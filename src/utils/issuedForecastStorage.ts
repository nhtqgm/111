import type { PeriodType } from '../types.ts';
import type { ForecastHistorySnapshot } from './forecastHistory.ts';
import {
  ISSUED_FORECAST_BATCH_SCHEMA,
  createIssuedForecastBatchId,
  isValidIssuedForecastRevision,
  selectActiveIssuedForecastBatch,
  sortIssuedForecastBatches,
  type IssuedForecastBasisValue,
  type IssuedForecastBatch,
  type IssuedForecastRow,
  type IssuedForecastScope,
} from './issuedForecastBatch.ts';

const HISTORY_BRIDGE_SCHEMA = 'gupiao-issued-forecast-history-bridge/v1' as const;
const MA_WINDOWS = [5, 10, 20, 40, 60] as const;

export type IssuedForecastPersistenceSource = 'issued' | 'migration' | 'legacy-history';

interface HistoryIssuedForecastBatchRecord {
  source: IssuedForecastPersistenceSource;
  persistedAt: string;
  batch: IssuedForecastBatch;
}

export interface CloudIssuedForecastBatchRecord {
  serverSequence: number;
  source: IssuedForecastPersistenceSource;
  persistedAt: string;
  batch: IssuedForecastBatch;
}

export type IssuedForecastRpc = (
  functionName: string,
  parameters?: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: unknown }>;

interface IssuedForecastHistoryBridgeMetadata {
  schema: typeof HISTORY_BRIDGE_SCHEMA;
  batchSchema: typeof ISSUED_FORECAST_BATCH_SCHEMA;
  batchId: string;
  revision: string;
  asOfDate: string;
  asOfPeriodKey: string;
  issuedAt: string;
  rowCount: number;
  fingerprint: string;
  source: IssuedForecastPersistenceSource;
  rowId: string;
  periodKey: string;
  horizon: number;
  previousSumAtIssue: number;
  basisValues: IssuedForecastBasisValue[];
}

export interface IssuedForecastHistorySnapshot extends ForecastHistorySnapshot {
  issuedForecast: IssuedForecastHistoryBridgeMetadata;
}

/**
 * Compatibility bridge for the already-deployed user_forecast_history RPC.
 * Each row has a content-addressed id, so draft/history autosaves from an old
 * client cannot collide with or replace the issued prediction.
 */
export function issuedForecastBatchToHistorySnapshots(
  batch: IssuedForecastBatch,
  source: IssuedForecastPersistenceSource = 'issued',
): IssuedForecastHistorySnapshot[] {
  const normalized = normalizeIssuedForecastBatch(batch);
  if (!normalized) throw new Error('Invalid issued forecast batch');
  const fingerprint = issuedForecastBatchFingerprint(normalized);
  return normalized.rows.map((row) => ({
    schema: 'gupiao-forecast-history/v1',
    id: `issued:${fingerprint}:${row.id}`,
    stockCode: normalized.stockCode,
    period: normalized.period,
    targetDate: row.targetDate,
    inputMaWindow: normalized.inputMaWindow,
    inputMaValue: row.inputMaValue,
    predictedClose: row.predictedClose,
    // Omit nulls in the v1 bridge. The deployed workspace normalizer treats a
    // missing value as null, while JSON null was historically coerced to zero.
    predictedMaValues: Object.fromEntries(
      MA_WINDOWS.flatMap((windowSize) => {
        const value = row.predictedMaValues[windowSize];
        return value === null ? [] : [[windowSize, value]];
      }),
    ) as ForecastHistorySnapshot['predictedMaValues'],
    note: row.note,
    savedAt: normalized.issuedAt,
    issuedForecast: {
      schema: HISTORY_BRIDGE_SCHEMA,
      batchSchema: normalized.schema,
      batchId: normalized.id,
      revision: normalized.revision,
      asOfDate: normalized.asOfDate,
      asOfPeriodKey: normalized.asOfPeriodKey,
      issuedAt: normalized.issuedAt,
      rowCount: normalized.rows.length,
      fingerprint,
      source,
      rowId: row.id,
      periodKey: row.periodKey,
      horizon: row.horizon,
      previousSumAtIssue: row.previousSumAtIssue,
      basisValues: row.basisValues.map((value) => ({ ...value })),
    },
  }));
}

/** Short names used by the application integration layer. */
export const issuedForecastBatchToSnapshots = issuedForecastBatchToHistorySnapshots;

/**
 * Reconstructs only complete, internally consistent batches. A conflicting
 * payload that reuses an existing batch id fails closed instead of silently
 * replacing the original prediction.
 */
export function issuedForecastRecordsFromHistorySnapshots(
  snapshots: readonly unknown[],
): HistoryIssuedForecastBatchRecord[] {
  const bridgeSnapshots = snapshots.map(normalizeBridgeSnapshot).filter(notNull);
  const grouped = new Map<string, IssuedForecastHistorySnapshot[]>();
  bridgeSnapshots.forEach((snapshot) => {
    const meta = snapshot.issuedForecast;
    const key = `${meta.batchId}\u0000${meta.fingerprint}`;
    grouped.set(key, [...(grouped.get(key) ?? []), snapshot]);
  });

  const records: HistoryIssuedForecastBatchRecord[] = [];
  grouped.forEach((rows) => {
    const record = historySnapshotGroupToRecord(rows);
    if (record) records.push(record);
  });
  return mergeImmutableBatchRecords(records);
}

export function issuedForecastBatchesFromHistorySnapshots(snapshots: readonly unknown[]) {
  return sortIssuedForecastBatches(
    issuedForecastRecordsFromHistorySnapshots(snapshots).map((record) => record.batch),
  );
}

export const issuedForecastBatchesFromSnapshots = issuedForecastBatchesFromHistorySnapshots;

export function isIssuedForecastSnapshot(value: unknown): value is IssuedForecastHistorySnapshot {
  return normalizeBridgeSnapshot(value) !== null;
}

export function selectActiveIssuedForecastBatchFromHistory(
  snapshots: readonly unknown[],
  scope: IssuedForecastScope,
) {
  return selectActiveIssuedForecastBatch(issuedForecastBatchesFromHistorySnapshots(snapshots), scope);
}

/**
 * Persists the immutable batch and its history bridge rows in one server-side
 * transaction. No local outbox or local storage is involved. A successful
 * result must include the authoritative server sequence before the UI may show
 * the batch as issued.
 */
export async function saveMyIssuedForecastBatchV2(
  batch: IssuedForecastBatch,
  source: IssuedForecastPersistenceSource = 'issued',
  rpc?: IssuedForecastRpc,
) {
  const normalized = normalizeIssuedForecastBatch(batch);
  if (!normalized) throw new Error('Invalid issued forecast batch');
  const invoke = rpc ?? await loadIssuedForecastRpc();
  const snapshots = issuedForecastBatchToHistorySnapshots(normalized, source);
  const { data, error } = await invoke('insert_my_issued_forecast_batch_v2', {
    p_batch: normalized,
    p_snapshots: snapshots,
    p_source: source,
  });
  if (error) throw error;
  const records = normalizeCloudIssuedForecastRecords(data);
  const saved = records.find((record) => record.batch.id === normalized.id);
  if (!saved) {
    throw new Error('云端未返回已提交预测的 server_sequence，不能确认锁定成功');
  }
  return saved.batch;
}

export async function loadMyIssuedForecastBatchesV2(rpc?: IssuedForecastRpc) {
  const invoke = rpc ?? await loadIssuedForecastRpc();
  const { data, error } = await invoke('get_my_issued_forecast_batches_v2');
  if (error) throw error;
  return normalizeCloudIssuedForecastRecords(data).map((record) => record.batch);
}

function normalizeCloudIssuedForecastRecords(value: unknown): CloudIssuedForecastBatchRecord[] {
  if (!Array.isArray(value)) throw new Error('云端已提交预测返回格式无效');
  const records = value.map((item) => {
    if (!isObject(item)) throw new Error('云端已提交预测记录格式无效');
    const serverSequence = Number(item.server_sequence);
    const source = normalizeSource(item.source);
    const persistedAt = typeof item.persisted_at === 'string' ? item.persisted_at : '';
    const normalized = normalizeIssuedForecastBatch(item.batch_payload);
    if (
      !Number.isSafeInteger(serverSequence) || serverSequence < 1 ||
      !source || !isTimestamp(persistedAt) || !normalized
    ) throw new Error('云端已提交预测记录未通过不可变契约校验');
    const batch = freezeCloudIssuedForecastBatch(normalized, serverSequence, persistedAt);
    return { serverSequence, source, persistedAt, batch } satisfies CloudIssuedForecastBatchRecord;
  });

  const byId = new Map<string, CloudIssuedForecastBatchRecord>();
  for (const record of records) {
    const existing = byId.get(record.batch.id);
    if (!existing) {
      byId.set(record.batch.id, record);
      continue;
    }
    if (issuedForecastBatchFingerprint(existing.batch) !== issuedForecastBatchFingerprint(record.batch)) {
      throw new Error(`Issued forecast batch id conflict: ${record.batch.id}`);
    }
    if (record.serverSequence > existing.serverSequence) byId.set(record.batch.id, record);
  }
  return [...byId.values()].sort((left, right) =>
    left.serverSequence - right.serverSequence || left.batch.id.localeCompare(right.batch.id),
  );
}

function freezeCloudIssuedForecastBatch(
  batch: IssuedForecastBatch,
  serverSequence: number,
  serverPersistedAt: string,
): IssuedForecastBatch {
  const rows = batch.rows.map((row) => Object.freeze({
    ...row,
    predictedMaValues: Object.freeze({ ...row.predictedMaValues }),
    basisValues: Object.freeze(row.basisValues.map((value) => Object.freeze({ ...value }))),
  }));
  return Object.freeze({
    ...batch,
    serverSequence,
    serverPersistedAt,
    rows: Object.freeze(rows),
  });
}

async function loadIssuedForecastRpc(): Promise<IssuedForecastRpc> {
  const api = (await import('./supabase.ts')).getSupabaseClient();
  if (!api) throw new Error('云端同步尚未配置');
  return async (functionName, parameters) => {
    const result = await api.rpc(functionName, parameters);
    return { data: result.data, error: result.error };
  };
}

export function issuedForecastBatchFingerprint(batch: IssuedForecastBatch) {
  const {
    serverSequence: _serverSequence,
    serverPersistedAt: _serverPersistedAt,
    ...predictionPayload
  } = batch;
  const canonical = stableStringify(predictionPayload);
  return [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => hashToHex(canonical, seed))
    .join('');
}

function historySnapshotGroupToRecord(
  snapshots: IssuedForecastHistorySnapshot[],
): HistoryIssuedForecastBatchRecord | null {
  if (!snapshots.length) return null;
  const first = snapshots[0];
  const meta = first.issuedForecast;
  const byRowId = new Map<string, IssuedForecastHistorySnapshot>();
  for (const snapshot of snapshots) {
    const current = snapshot.issuedForecast;
    if (
      current.batchId !== meta.batchId ||
      current.fingerprint !== meta.fingerprint ||
      current.revision !== meta.revision ||
      current.asOfDate !== meta.asOfDate ||
      current.asOfPeriodKey !== meta.asOfPeriodKey ||
      current.issuedAt !== meta.issuedAt ||
      current.rowCount !== meta.rowCount ||
      current.source !== meta.source ||
      snapshot.stockCode !== first.stockCode ||
      snapshot.period !== first.period ||
      snapshot.inputMaWindow !== first.inputMaWindow
    ) return null;
    const existing = byRowId.get(current.rowId);
    if (existing && stableStringify(existing) !== stableStringify(snapshot)) return null;
    byRowId.set(current.rowId, snapshot);
  }
  if (byRowId.size !== meta.rowCount) return null;

  const rows = [...byRowId.values()]
    .sort((left, right) => left.issuedForecast.horizon - right.issuedForecast.horizon)
    .map((snapshot) => ({
      id: snapshot.issuedForecast.rowId,
      targetDate: snapshot.targetDate,
      periodKey: snapshot.issuedForecast.periodKey,
      horizon: snapshot.issuedForecast.horizon,
      inputMaValue: snapshot.inputMaValue,
      predictedClose: snapshot.predictedClose,
      predictedMaValues: { ...snapshot.predictedMaValues },
      note: snapshot.note,
      previousSumAtIssue: snapshot.issuedForecast.previousSumAtIssue,
      basisValues: snapshot.issuedForecast.basisValues.map((value) => ({ ...value })),
    } satisfies IssuedForecastRow));
  const batch = normalizeIssuedForecastBatch({
    schema: meta.batchSchema,
    id: meta.batchId,
    stockCode: first.stockCode,
    period: first.period,
    inputMaWindow: first.inputMaWindow,
    revision: meta.revision,
    asOfDate: meta.asOfDate,
    asOfPeriodKey: meta.asOfPeriodKey,
    issuedAt: meta.issuedAt,
    rows,
  });
  if (!batch || issuedForecastBatchFingerprint(batch) !== meta.fingerprint) return null;
  return { batch, source: meta.source, persistedAt: meta.issuedAt };
}

function normalizeBridgeSnapshot(value: unknown): IssuedForecastHistorySnapshot | null {
  if (!isObject(value) || value.schema !== 'gupiao-forecast-history/v1') return null;
  const meta = value.issuedForecast;
  if (!isObject(meta) || meta.schema !== HISTORY_BRIDGE_SCHEMA) return null;
  const source = normalizeSource(meta.source);
  if (
    meta.batchSchema !== ISSUED_FORECAST_BATCH_SCHEMA ||
    typeof meta.batchId !== 'string' || !meta.batchId ||
    typeof meta.revision !== 'string' || !meta.revision ||
    !isDate(meta.asOfDate) ||
    typeof meta.asOfPeriodKey !== 'string' || !meta.asOfPeriodKey ||
    !isIssuedTimestamp(meta.issuedAt) ||
    !Number.isInteger(meta.rowCount) || Number(meta.rowCount) < 1 ||
    typeof meta.fingerprint !== 'string' || !/^[0-9a-f]{32}$/.test(meta.fingerprint) ||
    !source ||
    typeof meta.rowId !== 'string' || !meta.rowId ||
    typeof meta.periodKey !== 'string' || !meta.periodKey ||
    !Number.isInteger(meta.horizon) || Number(meta.horizon) < 1 ||
    !Number.isFinite(meta.previousSumAtIssue) ||
    !Array.isArray(meta.basisValues)
  ) return null;
  const batchShell = normalizeBatchShell(value);
  if (!batchShell) return null;
  const basisValues = meta.basisValues.map(normalizeBasisValue);
  if (basisValues.some((item) => item === null)) return null;
  return {
    ...batchShell,
    issuedForecast: {
      schema: HISTORY_BRIDGE_SCHEMA,
      batchSchema: ISSUED_FORECAST_BATCH_SCHEMA,
      batchId: meta.batchId,
      revision: meta.revision,
      asOfDate: meta.asOfDate,
      asOfPeriodKey: meta.asOfPeriodKey,
      issuedAt: meta.issuedAt,
      rowCount: Number(meta.rowCount),
      fingerprint: meta.fingerprint,
      source,
      rowId: meta.rowId,
      periodKey: meta.periodKey,
      horizon: Number(meta.horizon),
      previousSumAtIssue: Number(meta.previousSumAtIssue),
      basisValues: basisValues as IssuedForecastBasisValue[],
    },
  };
}

function normalizeBatchShell(value: Record<string, unknown>): ForecastHistorySnapshot | null {
  const stockCode = typeof value.stockCode === 'string' ? value.stockCode : '';
  const period = normalizePeriod(value.period);
  const inputMaWindow = Number(value.inputMaWindow);
  const predictedMaValues = normalizeMaValues(value.predictedMaValues);
  if (
    typeof value.id !== 'string' || !value.id ||
    !/^\d{6}$/.test(stockCode) || !period ||
    !isDate(value.targetDate) ||
    !MA_WINDOWS.includes(inputMaWindow as (typeof MA_WINDOWS)[number]) ||
    !Number.isFinite(value.inputMaValue) ||
    !Number.isFinite(value.predictedClose) ||
    !predictedMaValues ||
    typeof value.note !== 'string' ||
    !isTimestamp(value.savedAt)
  ) return null;
  return {
    schema: 'gupiao-forecast-history/v1',
    id: value.id,
    stockCode,
    period,
    targetDate: value.targetDate,
    inputMaWindow: inputMaWindow as ForecastHistorySnapshot['inputMaWindow'],
    inputMaValue: Number(value.inputMaValue),
    predictedClose: Number(value.predictedClose),
    predictedMaValues,
    note: value.note,
    savedAt: value.savedAt,
  };
}

function normalizeIssuedForecastBatch(value: unknown): IssuedForecastBatch | null {
  if (!isObject(value) || value.schema !== ISSUED_FORECAST_BATCH_SCHEMA) return null;
  const stockCode = typeof value.stockCode === 'string' ? value.stockCode.trim() : '';
  const period = normalizePeriod(value.period);
  const inputMaWindow = Number(value.inputMaWindow);
  if (
    typeof value.id !== 'string' || !value.id ||
    !/^\d{6}$/.test(stockCode) || !period ||
    !MA_WINDOWS.includes(inputMaWindow as (typeof MA_WINDOWS)[number]) ||
    typeof value.revision !== 'string' || !isValidIssuedForecastRevision(value.revision) ||
    !isDate(value.asOfDate) ||
    typeof value.asOfPeriodKey !== 'string' || !value.asOfPeriodKey ||
    !isIssuedTimestamp(value.issuedAt) ||
    !Array.isArray(value.rows) || !value.rows.length
  ) return null;
  const expectedId = createIssuedForecastBatchId({
    stockCode,
    period,
    inputMaWindow: inputMaWindow as IssuedForecastBatch['inputMaWindow'],
    revision: value.revision,
    asOfDate: value.asOfDate,
  });
  if (value.id !== expectedId) return null;
  const batchId = value.id;
  const rows = value.rows.map((row) => normalizeIssuedForecastRow(row, batchId, inputMaWindow));
  if (rows.some((row) => row === null)) return null;
  const normalizedRows = rows as IssuedForecastRow[];
  const periods = new Set(normalizedRows.map((row) => row.periodKey));
  const ids = new Set(normalizedRows.map((row) => row.id));
  if (periods.size !== normalizedRows.length || ids.size !== normalizedRows.length) return null;
  if (normalizedRows.some((row, index) => row.horizon !== index + 1)) return null;
  return {
    schema: ISSUED_FORECAST_BATCH_SCHEMA,
    id: value.id,
    stockCode,
    period,
    inputMaWindow: inputMaWindow as IssuedForecastBatch['inputMaWindow'],
    revision: value.revision.trim(),
    asOfDate: value.asOfDate,
    asOfPeriodKey: value.asOfPeriodKey,
    issuedAt: value.issuedAt,
    rows: normalizedRows,
  };
}

function normalizeIssuedForecastRow(
  value: unknown,
  batchId: string,
  inputMaWindow: number,
): IssuedForecastRow | null {
  if (!isObject(value)) return null;
  const horizon = Number(value.horizon);
  const predictedMaValues = normalizeMaValues(value.predictedMaValues);
  if (
    typeof value.id !== 'string' || !value.id ||
    !isDate(value.targetDate) ||
    typeof value.periodKey !== 'string' || !value.periodKey ||
    !Number.isInteger(horizon) || horizon < 1 ||
    !Number.isFinite(value.inputMaValue) ||
    !Number.isFinite(value.predictedClose) ||
    !predictedMaValues ||
    typeof value.note !== 'string' ||
    !Number.isFinite(value.previousSumAtIssue) ||
    !Array.isArray(value.basisValues)
  ) return null;
  if (value.id !== `${batchId}:${value.periodKey}:H${horizon}`) return null;
  const basisValues = value.basisValues.map(normalizeBasisValue);
  if (basisValues.some((item) => item === null) || basisValues.length !== inputMaWindow - 1) return null;
  return {
    id: value.id,
    targetDate: value.targetDate,
    periodKey: value.periodKey,
    horizon,
    inputMaValue: Number(value.inputMaValue),
    predictedClose: Number(value.predictedClose),
    predictedMaValues,
    note: value.note,
    previousSumAtIssue: Number(value.previousSumAtIssue),
    basisValues: basisValues as IssuedForecastBasisValue[],
  };
}

function normalizeBasisValue(value: unknown): IssuedForecastBasisValue | null {
  if (!isObject(value)) return null;
  if (
    typeof value.periodKey !== 'string' || !value.periodKey ||
    !isDate(value.targetDate) ||
    !Number.isFinite(value.value) ||
    (value.source !== 'actual' && value.source !== 'predicted')
  ) return null;
  return {
    periodKey: value.periodKey,
    targetDate: value.targetDate,
    value: Number(value.value),
    source: value.source,
  };
}

function mergeImmutableBatchRecords(records: HistoryIssuedForecastBatchRecord[]) {
  const byId = new Map<string, HistoryIssuedForecastBatchRecord>();
  records.forEach((record) => {
    const existing = byId.get(record.batch.id);
    if (!existing) {
      byId.set(record.batch.id, cloneRecord(record));
      return;
    }
    if (stableStringify(existing.batch) !== stableStringify(record.batch)) {
      throw new Error(`Issued forecast batch id conflict: ${record.batch.id}`);
    }
    if (record.persistedAt < existing.persistedAt) byId.set(record.batch.id, cloneRecord(record));
  });
  return [...byId.values()].sort((left, right) =>
    left.batch.issuedAt.localeCompare(right.batch.issuedAt) || left.batch.id.localeCompare(right.batch.id),
  );
}

function cloneRecord(record: HistoryIssuedForecastBatchRecord): HistoryIssuedForecastBatchRecord {
  const batch = normalizeIssuedForecastBatch(JSON.parse(JSON.stringify(record.batch))) as IssuedForecastBatch;
  return { source: record.source, persistedAt: record.persistedAt, batch };
}

function normalizeMaValues(value: unknown): IssuedForecastRow['predictedMaValues'] | null {
  if (!isObject(value)) return null;
  const entries = MA_WINDOWS.map((windowSize) => {
    const item = value[String(windowSize)];
    return [windowSize, item === null || item === undefined ? null : Number(item)] as const;
  });
  if (entries.some(([, item]) => item !== null && !Number.isFinite(item))) return null;
  return Object.fromEntries(entries) as unknown as IssuedForecastRow['predictedMaValues'];
}

function normalizePeriod(value: unknown): PeriodType | null {
  return value === 'day' || value === 'week' || value === 'month' ? value : null;
}

function normalizeSource(value: unknown): IssuedForecastPersistenceSource | null {
  return value === 'issued' || value === 'migration' || value === 'legacy-history' ? value : null;
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));
}

function isIssuedTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

function hashToHex(value: string, seed: number) {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
