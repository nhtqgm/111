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
}

export interface ForecastHistoryRow extends ForecastHistorySnapshot {
  actualDate: string | null;
  actualClose: number | null;
  actualMaValues: Record<MaWindow, number | null>;
  closeDiff: number | null;
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
      buildProjection(points, rows, baseDate, windowSize),
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
 * is demonstrably inconsistent with that user input and can be repaired.
 */
export function shouldRepairFrozenForecastSnapshot(
  existing: ForecastHistorySnapshot | undefined,
  rebuilt: ForecastHistorySnapshot,
) {
  if (!existing || existing.id !== rebuilt.id) return false;
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
        buildProjection(cache.points, pendingRows, baseDate, windowSize),
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
) {
  return buildMa40Projection(points, predictions, baseDate, inputMaWindow).rows;
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
  return (
    points
      .filter((point) => {
        const current = parseDate(point.date);
        if (!current) return false;
        if (period === 'month') return current.year === target.year && current.month === target.month;
        if (period === 'week') return getWeekStart(current) === getWeekStart(target);
        return false;
      })
      .sort((left, right) => right.date.localeCompare(left.date))[0] ?? null
  );
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
