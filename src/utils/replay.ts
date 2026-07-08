import type { KLinePoint, PeriodType } from '../types';
import {
  calculateMovingAverage,
  MA_WINDOWS,
  type Ma40ProjectionRow,
  type MaWindow,
} from './movingAverage.ts';

export const REPLAY_SNAPSHOT_SCHEMA = 'gupiao-replay-snapshots/v1';

export type ReplayDirection = 'up' | 'down' | 'flat';
export type ReplayStatus = 'ready' | 'pending';

export interface ReplaySnapshot {
  schema: typeof REPLAY_SNAPSHOT_SCHEMA;
  id: string;
  stockCode: string;
  stockName?: string;
  period: PeriodType;
  baseDate: string;
  targetDate: string;
  inputMaWindow: MaWindow;
  inputMaValue: number;
  predictedClose: number;
  predictedMaValues: Record<string, number | null>;
  baseClose: number | null;
  baseMaValues: Record<string, number | null>;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReplayMaComparison {
  windowSize: MaWindow;
  predicted: number | null;
  actual: number | null;
  diff: number | null;
  diffPct: number | null;
  predictedDirection: ReplayDirection | null;
  actualDirection: ReplayDirection | null;
  directionHit: boolean | null;
}

export interface ReplayReviewRow extends ReplaySnapshot {
  status: ReplayStatus;
  actualClose: number | null;
  closeDiff: number | null;
  closeDiffPct: number | null;
  predictedCloseDirection: ReplayDirection | null;
  actualCloseDirection: ReplayDirection | null;
  closeDirectionHit: boolean | null;
  maComparisons: Record<MaWindow, ReplayMaComparison>;
}

export interface ReplaySummary {
  total: number;
  ready: number;
  pending: number;
  closeMae: number | null;
  closeMape: number | null;
  closeDirectionHitRate: number | null;
  ma40Mae: number | null;
}

/**
 * Read saved forecast snapshots used for later replay/review.
 */
export function loadReplaySnapshots(stockCode: string, period: PeriodType): ReplaySnapshot[] {
  const raw = localStorage.getItem(replayStorageKey(stockCode, period));
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeReplaySnapshot)
      .filter((item): item is ReplaySnapshot => item !== null)
      .sort(compareSnapshots);
  } catch {
    return [];
  }
}

/**
 * Persist replay snapshots independently from the current editable forecast table.
 */
export function saveReplaySnapshots(
  stockCode: string,
  period: PeriodType,
  snapshots: ReplaySnapshot[],
) {
  localStorage.setItem(replayStorageKey(stockCode, period), JSON.stringify(snapshots));
}

/**
 * Create replay snapshots from the currently calculated projection rows.
 */
export function createReplaySnapshotsFromProjection({
  stockCode,
  stockName,
  period,
  baseDate,
  points,
  rows,
  inputMaWindow,
  existingSnapshots,
  now,
}: {
  stockCode: string;
  stockName?: string;
  period: PeriodType;
  baseDate: string;
  points: KLinePoint[];
  rows: Ma40ProjectionRow[];
  inputMaWindow: MaWindow;
  existingSnapshots: ReplaySnapshot[];
  now: string;
}): ReplaySnapshot[] {
  const closeByDate = new Map(points.map((point) => [point.date, point.close]));
  const baseClose = closeByDate.get(baseDate) ?? null;
  const baseMaValues = getMaValuesAtDate(points, baseDate);
  const existingById = new Map(existingSnapshots.map((snapshot) => [snapshot.id, snapshot]));

  return rows
    .filter(
      (row) =>
        row.derivedClose !== null &&
        row.calculation.reverse.predictedMa !== null &&
        Number.isFinite(row.derivedClose),
    )
    .map((row) => {
      const id = buildReplaySnapshotId(stockCode, period, baseDate, row.targetDate, inputMaWindow);
      const existing = existingById.get(id);

      return {
        schema: REPLAY_SNAPSHOT_SCHEMA,
        id,
        stockCode,
        stockName,
        period,
        baseDate,
        targetDate: row.targetDate,
        inputMaWindow,
        inputMaValue: row.calculation.reverse.predictedMa as number,
        predictedClose: row.derivedClose as number,
        predictedMaValues: normalizeMaNumberRecord(row.maValues),
        baseClose,
        baseMaValues,
        note: row.note,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
    });
}

/**
 * Merge new snapshots into old snapshots without deleting older review history.
 */
export function mergeReplaySnapshots(
  existingSnapshots: ReplaySnapshot[],
  incomingSnapshots: ReplaySnapshot[],
) {
  const byId = new Map(existingSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  for (const snapshot of incomingSnapshots) {
    byId.set(snapshot.id, {
      ...snapshot,
      createdAt: byId.get(snapshot.id)?.createdAt ?? snapshot.createdAt,
    });
  }

  return Array.from(byId.values()).sort(compareSnapshots);
}

/**
 * Compare saved forecast snapshots with the latest completed real K-line data.
 */
export function buildReplayReviewRows(
  snapshots: ReplaySnapshot[],
  points: KLinePoint[],
): ReplayReviewRow[] {
  const actualCloseByDate = new Map(points.map((point) => [point.date, point.close]));
  const actualMaByWindow = getMaValueMaps(points);

  return snapshots.map((snapshot) => {
    const actualClose = actualCloseByDate.get(snapshot.targetDate) ?? null;
    const closeDiff = calculateDiff(snapshot.predictedClose, actualClose);
    const predictedCloseDirection = getDirection(snapshot.baseClose, snapshot.predictedClose);
    const actualCloseDirection = getDirection(snapshot.baseClose, actualClose);
    const maComparisons = Object.fromEntries(
      MA_WINDOWS.map((windowSize) => {
        const predicted = snapshot.predictedMaValues[String(windowSize)] ?? null;
        const actual = actualMaByWindow[windowSize].get(snapshot.targetDate) ?? null;
        const base = snapshot.baseMaValues[String(windowSize)] ?? null;
        const predictedDirection = getDirection(base, predicted);
        const actualDirection = getDirection(base, actual);

        return [
          windowSize,
          {
            windowSize,
            predicted,
            actual,
            diff: calculateDiff(predicted, actual),
            diffPct: calculateDiffPct(predicted, actual),
            predictedDirection,
            actualDirection,
            directionHit: getDirectionHit(predictedDirection, actualDirection),
          },
        ];
      }),
    ) as Record<MaWindow, ReplayMaComparison>;

    return {
      ...snapshot,
      status: actualClose === null ? 'pending' : 'ready',
      actualClose,
      closeDiff,
      closeDiffPct: calculateDiffPct(snapshot.predictedClose, actualClose),
      predictedCloseDirection,
      actualCloseDirection,
      closeDirectionHit: getDirectionHit(predictedCloseDirection, actualCloseDirection),
      maComparisons,
    };
  });
}

/**
 * Summarize replay results for the dashboard strip.
 */
export function summarizeReplayRows(rows: ReplayReviewRow[]): ReplaySummary {
  const readyRows = rows.filter((row) => row.status === 'ready');
  const closeDiffs = readyRows
    .map((row) => row.closeDiff)
    .filter((value): value is number => value !== null);
  const closePcts = readyRows
    .map((row) => row.closeDiffPct)
    .filter((value): value is number => value !== null);
  const closeHits = readyRows
    .map((row) => row.closeDirectionHit)
    .filter((value): value is boolean => value !== null);
  const ma40Diffs = readyRows
    .map((row) => row.maComparisons[40].diff)
    .filter((value): value is number => value !== null);

  return {
    total: rows.length,
    ready: readyRows.length,
    pending: rows.length - readyRows.length,
    closeMae: averageAbsolute(closeDiffs),
    closeMape: averageAbsolute(closePcts),
    closeDirectionHitRate: closeHits.length
      ? (closeHits.filter(Boolean).length / closeHits.length) * 100
      : null,
    ma40Mae: averageAbsolute(ma40Diffs),
  };
}

function getMaValuesAtDate(points: KLinePoint[], targetDate: string) {
  const maps = getMaValueMaps(points);
  return normalizeMaNumberRecord(
    Object.fromEntries(
      MA_WINDOWS.map((windowSize) => [windowSize, maps[windowSize].get(targetDate) ?? null]),
    ),
  );
}

function getMaValueMaps(points: KLinePoint[]) {
  return Object.fromEntries(
    MA_WINDOWS.map((windowSize) => [
      windowSize,
      new Map(
        calculateMovingAverage(points, windowSize).map((row) => [row.targetDate, row.value]),
      ),
    ]),
  ) as Record<MaWindow, Map<string, number | null>>;
}

function calculateDiff(predicted: number | null, actual: number | null) {
  return predicted !== null && actual !== null ? predicted - actual : null;
}

function calculateDiffPct(predicted: number | null, actual: number | null) {
  const diff = calculateDiff(predicted, actual);
  return diff !== null && actual ? (Math.abs(diff) / Math.abs(actual)) * 100 : null;
}

function getDirection(base: number | null, value: number | null): ReplayDirection | null {
  if (base === null || value === null) return null;
  const diff = value - base;
  if (Math.abs(diff) <= 1e-9) return 'flat';
  return diff > 0 ? 'up' : 'down';
}

function getDirectionHit(
  predictedDirection: ReplayDirection | null,
  actualDirection: ReplayDirection | null,
) {
  if (predictedDirection === null || actualDirection === null) return null;
  return predictedDirection === actualDirection;
}

function normalizeReplaySnapshot(value: unknown): ReplaySnapshot | null {
  const candidate = value as ReplaySnapshot;
  if (
    candidate?.schema !== REPLAY_SNAPSHOT_SCHEMA ||
    typeof candidate.id !== 'string' ||
    typeof candidate.stockCode !== 'string' ||
    !['day', 'week', 'month'].includes(candidate.period) ||
    typeof candidate.baseDate !== 'string' ||
    typeof candidate.targetDate !== 'string' ||
    !MA_WINDOWS.includes(candidate.inputMaWindow) ||
    !Number.isFinite(candidate.inputMaValue) ||
    !Number.isFinite(candidate.predictedClose)
  ) {
    return null;
  }

  return {
    schema: REPLAY_SNAPSHOT_SCHEMA,
    id: candidate.id,
    stockCode: candidate.stockCode,
    stockName: typeof candidate.stockName === 'string' ? candidate.stockName : undefined,
    period: candidate.period,
    baseDate: candidate.baseDate,
    targetDate: candidate.targetDate,
    inputMaWindow: candidate.inputMaWindow,
    inputMaValue: candidate.inputMaValue,
    predictedClose: candidate.predictedClose,
    predictedMaValues: normalizeMaNumberRecord(candidate.predictedMaValues),
    baseClose: normalizeOptionalNumber(candidate.baseClose),
    baseMaValues: normalizeMaNumberRecord(candidate.baseMaValues),
    note: typeof candidate.note === 'string' ? candidate.note : '',
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : '',
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '',
  };
}

function normalizeMaNumberRecord(value: unknown) {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    MA_WINDOWS.map((windowSize) => [
      String(windowSize),
      normalizeOptionalNumber(record[String(windowSize)] ?? record[windowSize]),
    ]),
  ) as Record<string, number | null>;
}

function normalizeOptionalNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function averageAbsolute(values: number[]) {
  if (!values.length) return null;
  return values.reduce((total, value) => total + Math.abs(value), 0) / values.length;
}

function replayStorageKey(stockCode: string, period: PeriodType) {
  const normalizedCode = stockCode.replace(/\D/g, '').slice(0, 6);
  return `prediction-ma:replay:${normalizedCode}:${period}:v1`;
}

function buildReplaySnapshotId(
  stockCode: string,
  period: PeriodType,
  baseDate: string,
  targetDate: string,
  inputMaWindow: MaWindow,
) {
  const normalizedCode = stockCode.replace(/\D/g, '').slice(0, 6);
  return `${normalizedCode}:${period}:${baseDate}:${targetDate}:MA${inputMaWindow}`;
}

function compareSnapshots(a: ReplaySnapshot, b: ReplaySnapshot) {
  return (
    a.targetDate.localeCompare(b.targetDate) ||
    a.baseDate.localeCompare(b.baseDate) ||
    a.inputMaWindow - b.inputMaWindow
  );
}
