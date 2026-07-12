import type { PeriodType, PredictionPoint } from '../types.ts';
import type { ForecastHistorySnapshot } from './forecastHistory.ts';

export interface CloudWorkspaceScope {
  stockCode: string;
  period: PeriodType;
}

export interface CloudWorkspace {
  schema: 'gupiao-cloud-workspace/v1';
  workspace: {
    stockCode: string;
    period: PeriodType;
    baseDate: string;
  };
  predictions: Record<string, PredictionPoint[]>;
  forecastHistory: Record<string, ForecastHistorySnapshot[]>;
  updatedAt: string;
}

export interface FullWorkspaceBackup {
  schema: 'gupiao-cloud-workspace-backup/v1';
  appVersion: string;
  exportedAt: string;
  workspace: CloudWorkspace;
}

interface LegacyBackup {
  schema?: string;
  storage?: Record<string, unknown>;
}

export interface CloudWorkspaceSaveQueueOptions {
  accountId: string;
  revision: number;
  baseline: CloudWorkspace;
  debounceMs?: number;
  save: (request: { payload: CloudWorkspace; baseline: CloudWorkspace; expectedRevision: number }) => Promise<{
    revision: number;
    payload: CloudWorkspace;
  }>;
  onStatusChange?: (status: CloudWorkspaceSaveStatus) => void;
}

export type CloudWorkspaceSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const PREDICTION_KEY = /^prediction-ma:(\d{6}):(day|week|month):v2$/;
const HISTORY_KEY = /^prediction-ma:forecast-history:(\d{6}):(day|week|month):v1$/;
const SCOPE_KEY = /^(\d{6}):(day|week|month)$/;

export function resolveActiveWorkspaceScope({
  dataStockCode,
  dataPeriod,
  selectedStockCode,
  selectedPeriod,
  predictionStockCode,
  predictionPeriod,
}: {
  dataStockCode: string | null | undefined;
  dataPeriod: PeriodType | null;
  selectedStockCode: string;
  selectedPeriod: PeriodType;
  predictionStockCode?: string | null;
  predictionPeriod?: PeriodType | null;
}): CloudWorkspaceScope | null {
  const dataCode = normalizeStockCode(dataStockCode ?? '');
  const selectedCode = normalizeStockCode(selectedStockCode);
  if (dataCode.length !== 6 || dataCode !== selectedCode || dataPeriod !== selectedPeriod) return null;
  if (
    predictionStockCode !== undefined &&
    (normalizeStockCode(predictionStockCode ?? '') !== selectedCode || predictionPeriod !== selectedPeriod)
  ) {
    return null;
  }
  return { stockCode: dataCode, period: selectedPeriod };
}

export function createFullWorkspaceBackup(
  workspace: CloudWorkspace,
  appVersion: string,
  exportedAt = new Date().toISOString(),
): FullWorkspaceBackup {
  return {
    schema: 'gupiao-cloud-workspace-backup/v1',
    appVersion,
    exportedAt,
    workspace: cloneWorkspace(workspace),
  };
}

export function readFullWorkspaceImport(value: unknown): CloudWorkspace {
  const candidate = value as Partial<FullWorkspaceBackup>;
  const workspace = candidate?.schema === 'gupiao-cloud-workspace-backup/v1'
    ? candidate.workspace
    : value;
  return normalizeCloudWorkspace(workspace);
}

export function createEmptyCloudWorkspace(): CloudWorkspace {
  return {
    schema: 'gupiao-cloud-workspace/v1',
    workspace: { stockCode: '000166', period: 'month', baseDate: '' },
    predictions: {},
    forecastHistory: {},
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Legacy exports can be imported once as a user baseline. Market K-line cache
 * records are deliberately ignored: they are fetched live and never synced.
 */
export function createCloudWorkspaceFromLegacyBackup(value: unknown): CloudWorkspace {
  const backup = value as LegacyBackup;
  if (backup?.schema !== 'gupiao-ma40-full-backup/v1' || !backup.storage) {
    throw new Error('Backup is not a supported full data export.');
  }

  const workspace = createEmptyCloudWorkspace();
  for (const [key, raw] of Object.entries(backup.storage)) {
    const predictionMatch = PREDICTION_KEY.exec(key);
    if (predictionMatch) {
      const rows = parsePredictionRows(raw);
      if (rows.length) workspace.predictions[toScopeKey(predictionMatch[1], predictionMatch[2] as PeriodType)] = rows;
      continue;
    }

    const historyMatch = HISTORY_KEY.exec(key);
    if (historyMatch) {
      const snapshots = parseHistoryRows(raw);
      if (snapshots.length) workspace.forecastHistory[toScopeKey(historyMatch[1], historyMatch[2] as PeriodType)] = snapshots;
    }
  }

  workspace.workspace = typeof backup.storage['prediction-ma40:last-workspace'] === 'string'
    ? parseWorkspaceSelection(backup.storage['prediction-ma40:last-workspace'], workspace.workspace)
    : workspace.workspace;
  return workspace;
}

export function getWorkspacePredictions(workspace: CloudWorkspace, scope: CloudWorkspaceScope) {
  return clonePredictionRows(workspace.predictions[toScopeKey(scope.stockCode, scope.period)] ?? []);
}

export function setWorkspacePredictions(
  workspace: CloudWorkspace,
  scope: CloudWorkspaceScope,
  rows: PredictionPoint[],
) {
  return {
    ...workspace,
    predictions: {
      ...workspace.predictions,
      [toScopeKey(scope.stockCode, scope.period)]: clonePredictionRows(rows),
    },
    updatedAt: new Date().toISOString(),
  } satisfies CloudWorkspace;
}

export function getWorkspaceForecastHistory(workspace: CloudWorkspace, scope: CloudWorkspaceScope) {
  return cloneForecastHistory(workspace.forecastHistory[toScopeKey(scope.stockCode, scope.period)] ?? []);
}

export function setWorkspaceForecastHistory(
  workspace: CloudWorkspace,
  scope: CloudWorkspaceScope,
  snapshots: ForecastHistorySnapshot[],
) {
  return {
    ...workspace,
    forecastHistory: {
      ...workspace.forecastHistory,
      [toScopeKey(scope.stockCode, scope.period)]: cloneForecastHistory(snapshots),
    },
    updatedAt: new Date().toISOString(),
  } satisfies CloudWorkspace;
}

/**
 * Replays only this device's edits onto the newest cloud copy. Predictions are
 * compared per stock/period scope, so an untouched scope from another device
 * is never replaced by an older full-workspace payload.
 */
export function mergeCloudWorkspaceAfterRevisionConflict({
  baseline,
  local,
  remote,
}: {
  baseline: CloudWorkspace;
  local: CloudWorkspace;
  remote: CloudWorkspace;
}): CloudWorkspace {
  const merged = cloneWorkspace(remote);
  merged.predictions = mergeWorkspaceScopes(
    baseline.predictions,
    local.predictions,
    remote.predictions,
    clonePredictionRows,
  );
  merged.forecastHistory = mergeWorkspaceScopes(
    baseline.forecastHistory,
    local.forecastHistory,
    remote.forecastHistory,
    cloneForecastHistory,
  );
  merged.workspace = {
    stockCode: local.workspace.stockCode === baseline.workspace.stockCode
      ? remote.workspace.stockCode
      : local.workspace.stockCode,
    period: local.workspace.period === baseline.workspace.period
      ? remote.workspace.period
      : local.workspace.period,
    baseDate: local.workspace.baseDate === baseline.workspace.baseDate
      ? remote.workspace.baseDate
      : local.workspace.baseDate,
  };
  merged.updatedAt = local.updatedAt;
  return merged;
}

export function createWorkspaceSaveQueue(options: CloudWorkspaceSaveQueueOptions) {
  let accountId = options.accountId;
  let revision = options.revision;
  let baseline = cloneWorkspace(options.baseline);
  let generation = 0;
  let pending: { payload: CloudWorkspace; baseline: CloudWorkspace } | null = null;
  let failed: { payload: CloudWorkspace; baseline: CloudWorkspace } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<void> | null = null;
  let status: CloudWorkspaceSaveStatus = 'idle';
  let lastError: Error | null = null;

  const setStatus = (next: CloudWorkspaceSaveStatus) => {
    status = next;
    options.onStatusChange?.(next);
  };

  const start = async () => {
    if (active || !pending) return;
    const request = pending;
    pending = null;
    const requestGeneration = generation;
    const requestAccountId = accountId;
    setStatus('saving');
    active = options
      .save({
        payload: cloneWorkspace(request.payload),
        baseline: cloneWorkspace(request.baseline),
        expectedRevision: revision,
      })
      .then((result) => {
        if (generation !== requestGeneration || accountId !== requestAccountId) return;
        revision = result.revision;
        baseline = cloneWorkspace(result.payload);
        failed = null;
        lastError = null;
        setStatus('saved');
      })
      .catch((error: unknown) => {
        if (generation !== requestGeneration || accountId !== requestAccountId) return;
        failed = {
          payload: cloneWorkspace(request.payload),
          baseline: cloneWorkspace(request.baseline),
        };
        lastError = error instanceof Error ? error : new Error(String(error));
        setStatus('error');
      })
      .finally(() => {
        active = null;
        if (generation !== requestGeneration || accountId !== requestAccountId) return;
        if (pending) void start();
      });
    await active;
  };

  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void start();
    }, options.debounceMs ?? 700);
  };

  return {
    schedule(payload: CloudWorkspace) {
      pending = { payload: cloneWorkspace(payload), baseline: cloneWorkspace(baseline) };
      failed = null;
      lastError = null;
      arm();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await start();
      if (active) await active;
    },
    retry() {
      if (!failed) return;
      pending = failed;
      failed = null;
      lastError = null;
      arm();
    },
    switchAccount(nextAccountId: string, nextRevision: number) {
      generation += 1;
      accountId = nextAccountId;
      revision = nextRevision;
      baseline = createEmptyCloudWorkspace();
      pending = null;
      failed = null;
      lastError = null;
      if (timer) clearTimeout(timer);
      timer = null;
      setStatus('idle');
    },
    getStatus: () => status,
    getLastError: () => lastError,
  };
}

function mergeWorkspaceScopes<T>(
  baseline: Record<string, T[]>,
  local: Record<string, T[]>,
  remote: Record<string, T[]>,
  cloneRows: (rows: T[]) => T[],
) {
  const merged = Object.fromEntries(Object.entries(remote).map(([key, rows]) => [key, cloneRows(rows)])) as Record<string, T[]>;
  const localKeys = new Set([...Object.keys(baseline), ...Object.keys(local)]);
  for (const key of localKeys) {
    if (sameValue(local[key], baseline[key])) continue;
    if (key in local) merged[key] = cloneRows(local[key]);
    else delete merged[key];
  }
  return merged;
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function toScopeKey(stockCode: string, period: PeriodType) {
  return `${stockCode.replace(/\D/g, '').slice(0, 6)}:${period}`;
}

function normalizeCloudWorkspace(value: unknown): CloudWorkspace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cloud workspace payload is invalid.');
  }
  const candidate = value as Partial<CloudWorkspace>;
  if (candidate.schema !== 'gupiao-cloud-workspace/v1') {
    throw new Error('Cloud workspace payload is invalid.');
  }
  const selectedCode = normalizeStockCode(candidate.workspace?.stockCode ?? '');
  const selectedPeriod = candidate.workspace?.period;
  if (selectedCode.length !== 6 || !isPeriodType(selectedPeriod)) {
    throw new Error('Cloud workspace selection is invalid.');
  }

  const predictions: CloudWorkspace['predictions'] = {};
  for (const [scopeKey, rows] of Object.entries(candidate.predictions ?? {})) {
    const scope = SCOPE_KEY.exec(scopeKey);
    if (!scope || !Array.isArray(rows)) throw new Error(`Prediction scope is invalid: ${scopeKey}`);
    predictions[scopeKey] = rows
      .map(normalizeImportedPredictionRow)
      .filter((row): row is PredictionPoint => row !== null);
  }

  const forecastHistory: CloudWorkspace['forecastHistory'] = {};
  for (const [scopeKey, rows] of Object.entries(candidate.forecastHistory ?? {})) {
    const scope = SCOPE_KEY.exec(scopeKey);
    if (!scope || !Array.isArray(rows)) throw new Error(`Forecast history scope is invalid: ${scopeKey}`);
    forecastHistory[scopeKey] = rows
      .map((row) => normalizeImportedHistoryRow(row, scope[1], scope[2] as PeriodType))
      .filter((row): row is ForecastHistorySnapshot => row !== null);
  }

  return {
    schema: 'gupiao-cloud-workspace/v1',
    workspace: {
      stockCode: selectedCode,
      period: selectedPeriod,
      baseDate: typeof candidate.workspace?.baseDate === 'string' ? candidate.workspace.baseDate : '',
    },
    predictions,
    forecastHistory,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
  };
}

function normalizeImportedPredictionRow(value: unknown): PredictionPoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<PredictionPoint>;
  if (typeof candidate.targetDate !== 'string') return null;
  return {
    targetDate: candidate.targetDate,
    predictedMa40: typeof candidate.predictedMa40 === 'string' ? candidate.predictedMa40 : '',
    predictedMaValues: candidate.predictedMaValues && typeof candidate.predictedMaValues === 'object'
      ? Object.fromEntries(Object.entries(candidate.predictedMaValues).map(([key, item]) => [key, String(item ?? '')]))
      : {},
    note: typeof candidate.note === 'string' ? candidate.note : '',
  };
}

function normalizeImportedHistoryRow(
  value: unknown,
  stockCode: string,
  period: PeriodType,
): ForecastHistorySnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<ForecastHistorySnapshot>;
  if (
    candidate.schema !== 'gupiao-forecast-history/v1' ||
    normalizeStockCode(candidate.stockCode ?? '') !== stockCode ||
    candidate.period !== period ||
    typeof candidate.id !== 'string' ||
    typeof candidate.targetDate !== 'string' ||
    ![5, 10, 20, 40, 60].includes(Number(candidate.inputMaWindow)) ||
    !Number.isFinite(Number(candidate.inputMaValue)) ||
    !Number.isFinite(Number(candidate.predictedClose))
  ) {
    return null;
  }
  return {
    ...candidate,
    schema: 'gupiao-forecast-history/v1',
    id: candidate.id,
    stockCode,
    period,
    targetDate: candidate.targetDate,
    inputMaWindow: Number(candidate.inputMaWindow) as ForecastHistorySnapshot['inputMaWindow'],
    inputMaValue: Number(candidate.inputMaValue),
    predictedClose: Number(candidate.predictedClose),
    predictedMaValues: Object.fromEntries(
      [5, 10, 20, 40, 60].map((windowSize) => {
        const item = candidate.predictedMaValues?.[windowSize as keyof typeof candidate.predictedMaValues];
        return [windowSize, Number.isFinite(Number(item)) ? Number(item) : null];
      }),
    ) as ForecastHistorySnapshot['predictedMaValues'],
    note: typeof candidate.note === 'string' ? candidate.note : '',
    savedAt: typeof candidate.savedAt === 'string' ? candidate.savedAt : '',
  };
}

function isPeriodType(value: unknown): value is PeriodType {
  return value === 'day' || value === 'week' || value === 'month';
}

function normalizeStockCode(value: string) {
  return value.replace(/\D/g, '').slice(0, 6);
}

function parsePredictionRows(raw: unknown): PredictionPoint[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row) => {
      if (!row || typeof row !== 'object' || typeof row.targetDate !== 'string') return [];
      const candidate = row as Partial<PredictionPoint> & { targetDate: string };
      return [{
        targetDate: candidate.targetDate,
        predictedMa40: typeof candidate.predictedMa40 === 'string' ? candidate.predictedMa40 : '',
        predictedMaValues: candidate.predictedMaValues && typeof candidate.predictedMaValues === 'object'
          ? Object.fromEntries(Object.entries(candidate.predictedMaValues).map(([key, item]) => [key, String(item ?? '')]))
          : {},
        note: typeof candidate.note === 'string' ? candidate.note : '',
      }];
    });
  } catch {
    return [];
  }
}

function parseHistoryRows(raw: unknown): ForecastHistorySnapshot[] {
  if (typeof raw !== 'string') return [];
  try {
    return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) as ForecastHistorySnapshot[] : [];
  } catch {
    return [];
  }
}

function parseWorkspaceSelection(raw: string, current: CloudWorkspace['workspace']) {
  try {
    const candidate = JSON.parse(raw) as Partial<CloudWorkspace['workspace']>;
    return {
      stockCode: typeof candidate.stockCode === 'string' ? candidate.stockCode.replace(/\D/g, '').slice(0, 6) || current.stockCode : current.stockCode,
      period: candidate.period === 'day' || candidate.period === 'week' || candidate.period === 'month' ? candidate.period : current.period,
      baseDate: typeof candidate.baseDate === 'string' ? candidate.baseDate : current.baseDate,
    };
  } catch {
    return current;
  }
}

function clonePredictionRows(rows: PredictionPoint[]) {
  return rows.map((row) => ({ ...row, predictedMaValues: { ...row.predictedMaValues } }));
}

function cloneForecastHistory(rows: ForecastHistorySnapshot[]) {
  return rows.map((row) => ({ ...row, predictedMaValues: { ...row.predictedMaValues } }));
}

function cloneWorkspace(workspace: CloudWorkspace): CloudWorkspace {
  return {
    ...workspace,
    workspace: { ...workspace.workspace },
    predictions: Object.fromEntries(Object.entries(workspace.predictions).map(([key, rows]) => [key, clonePredictionRows(rows)])),
    forecastHistory: Object.fromEntries(Object.entries(workspace.forecastHistory).map(([key, rows]) => [key, cloneForecastHistory(rows)])),
  };
}
