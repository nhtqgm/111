import type { KLinePoint, PeriodType, PredictionPoint, StockKLineResponse } from '../types';
import {
  buildMa40Projection,
  calculateMovingAverage,
  MA_WINDOWS,
  type Ma40ProjectionRow,
  type MaWindow,
} from './movingAverage.ts';
import { queueElectronStorageSync } from './electronStorage.ts';

const STORAGE_PREFIX = 'prediction-ma:forecast-history';
const SCHEMA = 'gupiao-forecast-history/v1';

export interface ForecastHistorySnapshot {
  schema: typeof SCHEMA;
  id: string;
  stockCode: string;
  period: PeriodType;
  targetDate: string;
  inputMaWindow: MaWindow;
  inputMaValue: number;
  predictedClose: number;
  predictedMaValues: Record<MaWindow, number | null>;
  note: string;
  savedAt: string;
  /**
   * 该期结算入档的定格戳（结算K线日期）。带此标记的快照永不再被 repair 重写。
   * 云端按 JSONB 整体存 payload，可选字段可安全往返；旧快照缺省视为未定格。
   */
  settledAt?: string;
}

export interface ForecastHistoryRow extends ForecastHistorySnapshot {
  actualDate: string | null;
  actualClose: number | null;
  actualMaValues: Record<MaWindow, number | null>;
  closeDiff: number | null;
  /** 目标周期没有任何K线（休市/停牌），顺延到下一根真实K线结算 */
  settledByFallback: boolean;
}

export interface ForecastHistoryRecoveryResult {
  storage: Record<string, string>;
  recoveredCount: number;
}

export function loadForecastHistory(stockCode: string, period: PeriodType) {
  const raw = localStorage.getItem(storageKey(stockCode, period));
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return deduplicate(
      parsed
        .map((item) => normalizeSnapshot(item, stockCode, period))
        .filter((item): item is ForecastHistorySnapshot => item !== null),
    );
  } catch {
    return [];
  }
}

export function saveForecastHistory(
  stockCode: string,
  period: PeriodType,
  snapshots: ForecastHistorySnapshot[],
) {
  localStorage.setItem(
    storageKey(stockCode, period),
    JSON.stringify(deduplicate(snapshots)),
  );
  void queueElectronStorageSync();
}

export function createForecastHistorySnapshots(
  stockCode: string,
  period: PeriodType,
  inputMaWindow: MaWindow,
  rows: Ma40ProjectionRow[],
  savedAt = new Date().toISOString(),
) {
  const normalizedCode = normalizeStockCode(stockCode);
  return rows.flatMap((row) => {
    const inputMaValue = row.calculation.reverse.predictedMa;
    if (inputMaValue === null || row.derivedClose === null) return [];

    const snapshot: ForecastHistorySnapshot = {
      schema: SCHEMA,
      id: `${normalizedCode}:${period}:${row.targetDate}:MA${inputMaWindow}`,
      stockCode: normalizedCode,
      period,
      targetDate: row.targetDate,
      inputMaWindow,
      inputMaValue,
      predictedClose: row.derivedClose,
      predictedMaValues: normalizeMaValues(row.maValues),
      note: row.note,
      savedAt,
    };
    return [snapshot];
  });
}

/**
 * Each K-line period owns its MA inputs. Capture every filled MA field in that
 * same period so a later market refresh cannot make a completed forecast
 * disappear from its own historical chart.
 */
export function createForecastHistorySnapshotsForAllInputs(
  stockCode: string,
  period: PeriodType,
  points: KLinePoint[],
  rows: PredictionPoint[],
  baseDate: string,
  savedAt = new Date().toISOString(),
) {
  return MA_WINDOWS.flatMap((windowSize) =>
    createForecastHistorySnapshots(
      stockCode,
      period,
      windowSize,
      buildProjection(points, rows, baseDate, windowSize, period),
      savedAt,
    ),
  );
}

export function mergeForecastHistory(
  existing: ForecastHistorySnapshot[],
  incoming: ForecastHistorySnapshot[],
) {
  return deduplicate([...existing, ...incoming]);
}

/**
 * Completed forecasts are normally frozen for review. An older snapshot may
 * nevertheless have been produced from a stale chart state. When the saved
 * user MA is unchanged but its reverse-calculated close differs, the snapshot
 * is demonstrably inconsistent with that user input and can be repaired —
 * but only ONCE, at settlement time: a snapshot already stamped `settledAt`
 * has been shown to the user as final and must never be rewritten again
 * (later recomputations can differ merely because dead periods dropped out
 * of the projection window, which is not a data error).
 */
export function shouldRepairFrozenForecastSnapshot(
  existing: ForecastHistorySnapshot | undefined,
  rebuilt: ForecastHistorySnapshot,
) {
  if (!existing || existing.id !== rebuilt.id) return false;
  if (existing.settledAt) return false;
  if (existing.inputMaWindow !== rebuilt.inputMaWindow) return false;
  if (Math.abs(existing.inputMaValue - rebuilt.inputMaValue) > 1e-9) return false;
  return Math.abs(existing.predictedClose - rebuilt.predictedClose) > 1e-6;
}

export function getPendingForecastRows(rows: PredictionPoint[], baseDate: string) {
  return rows.filter((row) => row.targetDate > baseDate);
}

/**
 * A saved prediction remains eligible for review after the target period has
 * completed. The former date-only filter made a prediction disappear from
 * history if the market data arrived before its snapshot was written.
 */
export function getHistoryCaptureRows(rows: PredictionPoint[]) {
  return rows.filter((row) =>
    row.predictedMa40.trim() !== '' ||
    Object.values(row.predictedMaValues).some((value) => value.trim() !== ''),
  );
}

export function filterForecastHistorySnapshots(
  snapshots: ForecastHistorySnapshot[],
  stockCode: string,
  period: PeriodType,
) {
  const normalizedCode = normalizeStockCode(stockCode);
  return snapshots.filter(
    (snapshot) => snapshot.stockCode === normalizedCode && snapshot.period === period,
  );
}

/**
 * The review table keeps every completed forecast, while the chart only uses
 * the most recent completed period as the bridge into the current forecast.
 */
export function selectLatestChartForecastHistoryRows(rows: ForecastHistoryRow[]) {
  const completedRows = rows.filter((row) => row.actualClose !== null);
  const latestDate = completedRows.reduce<string | null>((latest, row) => {
    const rowDate = row.actualDate ?? row.targetDate;
    return latest === null || rowDate > latest ? rowDate : latest;
  }, null);

  if (latestDate === null) return [];
  return completedRows.filter((row) => (row.actualDate ?? row.targetDate) === latestDate);
}

/**
 * Old full backups contain the prediction input and the K-line cache that was
 * available when it was exported. Rebuild snapshots from those two records,
 * rather than from newer online prices.
 */
export function recoverForecastHistoryFromBackupStorage(
  sourceStorage: Record<string, string>,
  savedAt = new Date().toISOString(),
): ForecastHistoryRecoveryResult {
  const storage = { ...sourceStorage };
  let recoveredCount = 0;

  for (const [key, rawCache] of Object.entries(sourceStorage)) {
    const cacheMatch = /^prediction-ma40:kline-cache:(\d{6}):(day|week|month):v1$/.exec(key);
    if (!cacheMatch) continue;

    const stockCode = cacheMatch[1];
    const period = cacheMatch[2] as PeriodType;
    const cache = parseRecoveryCache(rawCache, stockCode, period);
    const predictions = parseRecoveryPredictions(
      sourceStorage[`prediction-ma:${stockCode}:${period}:v2`],
    );
    if (!cache || !predictions.length) continue;

    const baseDate = [...cache.points].map((point) => point.date).sort().at(-1);
    if (!baseDate) continue;

    const pendingRows = getPendingForecastRows(predictions, baseDate);
    if (!pendingRows.length) continue;

    const historyKey = storageKey(stockCode, period);
    const existing = parseStoredSnapshots(sourceStorage[historyKey], stockCode, period);
    const existingIds = new Set(existing.map((snapshot) => snapshot.id));
    const recovered = MA_WINDOWS.flatMap((windowSize) =>
      createForecastHistorySnapshots(
        stockCode,
        period,
        windowSize,
        buildProjection(cache.points, pendingRows, baseDate, windowSize, period),
        savedAt,
      ),
    ).filter((snapshot) => !existingIds.has(snapshot.id));

    if (!recovered.length) continue;
    storage[historyKey] = JSON.stringify(deduplicate([...existing, ...recovered]));
    recoveredCount += recovered.length;
  }

  return { storage, recoveredCount };
}

export function buildForecastHistoryRows(
  snapshots: ForecastHistorySnapshot[],
  points: KLinePoint[],
): ForecastHistoryRow[] {
  const actualMaMaps = Object.fromEntries(
    MA_WINDOWS.map((windowSize) => [
      windowSize,
      new Map(calculateMovingAverage(points, windowSize).map((row) => [row.targetDate, row.value])),
    ]),
  ) as Record<MaWindow, Map<string, number | null>>;

  return snapshots.map((snapshot) => {
    const actual = findActualPoint(snapshot.targetDate, snapshot.period, points);
    const actualClose = actual?.close ?? null;
    return {
      ...snapshot,
      actualDate: actual?.date ?? null,
      actualClose,
      actualMaValues: Object.fromEntries(
        MA_WINDOWS.map((windowSize) => [
          windowSize,
          actual ? actualMaMaps[windowSize].get(actual.date) ?? null : null,
        ]),
      ) as Record<MaWindow, number | null>,
      closeDiff: actualClose === null ? null : snapshot.predictedClose - actualClose,
      settledByFallback: actual
        ? isFallbackSettlement(snapshot.targetDate, actual.date, snapshot.period)
        : false,
    };
  });
}

function normalizeSnapshot(
  value: unknown,
  stockCode: string,
  period: PeriodType,
): ForecastHistorySnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<ForecastHistorySnapshot>;
  const normalizedCode = normalizeStockCode(stockCode);
  if (
    candidate.schema !== SCHEMA ||
    normalizeStockCode(String(candidate.stockCode ?? '')) !== normalizedCode ||
    candidate.period !== period ||
    typeof candidate.targetDate !== 'string' ||
    !MA_WINDOWS.includes(candidate.inputMaWindow as MaWindow) ||
    !Number.isFinite(candidate.inputMaValue) ||
    !Number.isFinite(candidate.predictedClose)
  ) {
    return null;
  }

  const inputMaWindow = candidate.inputMaWindow as MaWindow;
  return {
    schema: SCHEMA,
    id:
      typeof candidate.id === 'string' && candidate.id
        ? candidate.id
        : `${normalizedCode}:${period}:${candidate.targetDate}:MA${inputMaWindow}`,
    stockCode: normalizedCode,
    period,
    targetDate: candidate.targetDate,
    inputMaWindow,
    inputMaValue: Number(candidate.inputMaValue),
    predictedClose: Number(candidate.predictedClose),
    predictedMaValues: normalizeMaValues(candidate.predictedMaValues),
    note: typeof candidate.note === 'string' ? candidate.note : '',
    savedAt: typeof candidate.savedAt === 'string' ? candidate.savedAt : '',
    ...(typeof candidate.settledAt === 'string' && candidate.settledAt
      ? { settledAt: candidate.settledAt }
      : {}),
  };
}

function parseStoredSnapshots(raw: string | undefined, stockCode: string, period: PeriodType) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? deduplicate(
          parsed
            .map((item) => normalizeSnapshot(item, stockCode, period))
            .filter((item): item is ForecastHistorySnapshot => item !== null),
        )
      : [];
  } catch {
    return [];
  }
}

function parseRecoveryCache(raw: string, stockCode: string, period: PeriodType): StockKLineResponse | null {
  try {
    const candidate = JSON.parse(raw) as { stockCode?: unknown; period?: unknown; data?: unknown };
    const data = candidate.data as Partial<StockKLineResponse> | undefined;
    if (
      candidate.stockCode !== stockCode ||
      candidate.period !== period ||
      !data ||
      normalizeStockCode(String(data.code ?? '')) !== stockCode ||
      !Array.isArray(data.points)
    ) {
      return null;
    }
    return data as StockKLineResponse;
  } catch {
    return null;
  }
}

function parseRecoveryPredictions(raw: string | undefined): PredictionPoint[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const candidate = item as Partial<PredictionPoint>;
      if (typeof candidate.targetDate !== 'string') return [];
      return [
        {
          targetDate: candidate.targetDate,
          predictedMa40: typeof candidate.predictedMa40 === 'string' ? candidate.predictedMa40 : '',
          predictedMaValues:
            candidate.predictedMaValues && typeof candidate.predictedMaValues === 'object'
              ? candidate.predictedMaValues
              : {},
          note: typeof candidate.note === 'string' ? candidate.note : '',
        },
      ];
    });
  } catch {
    return [];
  }
}

function buildProjection(
  points: KLinePoint[],
  predictions: PredictionPoint[],
  baseDate: string,
  inputMaWindow: MaWindow,
  period: PeriodType,
) {
  return buildMa40Projection(points, predictions, baseDate, inputMaWindow, period).rows;
}

function normalizeMaValues(value: unknown) {
  const values = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    MA_WINDOWS.map((windowSize) => {
      const item = values[String(windowSize)] ?? values[windowSize];
      const parsed = Number(item);
      return [windowSize, Number.isFinite(parsed) ? parsed : null];
    }),
  ) as Record<MaWindow, number | null>;
}

function deduplicate(snapshots: ForecastHistorySnapshot[]) {
  const byId = new Map<string, ForecastHistorySnapshot>();
  for (const snapshot of snapshots) {
    const existing = byId.get(snapshot.id);
    if (!existing || snapshot.savedAt >= existing.savedAt) byId.set(snapshot.id, snapshot);
  }
  return Array.from(byId.values()).sort(
    (left, right) => left.targetDate.localeCompare(right.targetDate) || left.id.localeCompare(right.id),
  );
}

function findActualPoint(targetDate: string, period: PeriodType, points: KLinePoint[]) {
  const exact = points.find((point) => point.date === targetDate);
  if (exact) return exact;

  const target = parseDate(targetDate);
  if (!target) return null;
  const samePeriod =
    points
      .filter((point) => {
        const current = parseDate(point.date);
        if (!current) return false;
        if (period === 'month') return current.year === target.year && current.month === target.month;
        if (period === 'week') return getWeekStart(current) === getWeekStart(target);
        return false;
      })
      .sort((left, right) => right.date.localeCompare(left.date))[0] ?? null;
  if (samePeriod) return samePeriod;

  // 死目标日回退：目标周期整段没有任何K线（日历表未收录的休市日、个股停牌、
  // 整周/整月休市），而市场已经走到了更后面 —— 顺延到目标日之后的第一根真实K线结算。
  // 要求目标日之前也存在K线，防止把早于数据窗口起点的陈年幽灵快照错误结算到首根K线上。
  const hasEarlierPoint = points.some((point) => point.date < targetDate);
  if (!hasEarlierPoint) return null;
  return points.find((point) => point.date > targetDate) ?? null;
}

/** 结算K线是否落在目标周期之外（顺延结算） */
export function isFallbackSettlement(
  targetDate: string,
  actualDate: string,
  period: PeriodType,
) {
  if (period === 'day') return actualDate !== targetDate;
  const target = parseDate(targetDate);
  const actual = parseDate(actualDate);
  if (!target || !actual) return false;
  if (period === 'month') return target.year !== actual.year || target.month !== actual.month;
  return getWeekStart(target) !== getWeekStart(actual);
}

function storageKey(stockCode: string, period: PeriodType) {
  return `${STORAGE_PREFIX}:${normalizeStockCode(stockCode)}:${period}:v1`;
}

function normalizeStockCode(value: string) {
  return value.replace(/\D/g, '').slice(0, 6);
}

function parseDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function getWeekStart(value: { year: number; month: number; day: number }) {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}
