import type { KLinePoint, PeriodType } from '../types';
import { queueElectronStorageSync } from './electronStorage.ts';
import {
  calculateMovingAverage,
  MA_WINDOWS,
  type Ma40ProjectionRow,
  type MaWindow,
} from './movingAverage.ts';

export const REPLAY_SNAPSHOT_SCHEMA = 'gupiao-replay-snapshots/v1';

export type ReplayDirection = 'up' | 'down' | 'flat';
export type ReplayStatus = 'ready' | 'pending';
export type ReplayPlanFilter = 'all' | 'active' | 'legacy' | `plan:${string}`;

export interface ReplaySnapshot {
  schema: typeof REPLAY_SNAPSHOT_SCHEMA;
  id: string;
  stockCode: string;
  stockName?: string;
  period: PeriodType;
  planId?: string;
  planName?: string;
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
 * Filter replay rows by prediction plan without changing the underlying stock+period cache bucket.
 */
export function filterReplayRowsByPlan(
  rows: ReplayReviewRow[],
  filter: ReplayPlanFilter,
  activePlanId: string | null,
) {
  if (filter === 'all') return rows;
  if (filter === 'legacy') return rows.filter((row) => !row.planId);
  if (filter === 'active') {
    return activePlanId ? rows.filter((row) => row.planId === activePlanId) : [];
  }

  const planId = filter.slice('plan:'.length);
  return rows.filter((row) => row.planId === planId);
}

/**
 * Read saved forecast snapshots used for later replay/review.
 */
export function loadReplaySnapshots(stockCode: string, period: PeriodType): ReplaySnapshot[] {
  const normalizedStockCode = normalizeStockCode(stockCode);
  const raw = localStorage.getItem(replayStorageKey(normalizedStockCode, period));
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item) =>
          isPlainReplaySnapshotObject(item) &&
          !hasConflictingReplayOwnership(item, normalizedStockCode, period),
      )
      .map((item) => normalizeReplaySnapshot(item, normalizedStockCode, period))
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
  const normalizedStockCode = normalizeStockCode(stockCode);
  snapshots.forEach((snapshot) =>
    assertReplaySnapshotOwnership(snapshot, normalizedStockCode, period),
  );
  const normalizedSnapshots = snapshots.map((snapshot) => {
    const normalized = normalizeReplaySnapshot(snapshot, normalizedStockCode, period);
    if (!normalized) throw new Error('Invalid replay snapshot');
    return normalized;
  });

  localStorage.setItem(
    replayStorageKey(normalizedStockCode, period),
    JSON.stringify(normalizedSnapshots),
  );
  return queueElectronStorageSync();
}

/**
 * Create replay snapshots from the currently calculated projection rows.
 */
export function createReplaySnapshotsFromProjection({
  stockCode,
  stockName,
  period,
  planId,
  planName,
  planNote,
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
  planId?: string | null;
  planName?: string | null;
  planNote?: string | null;
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
      const id = buildReplaySnapshotId(
        stockCode,
        period,
        baseDate,
        row.targetDate,
        inputMaWindow,
        planId,
      );
      const existing = existingById.get(id);

      return {
        schema: REPLAY_SNAPSHOT_SCHEMA,
        id,
        stockCode,
        stockName,
        period,
        planId: planId ?? undefined,
        planName: planName ?? undefined,
        baseDate,
        targetDate: row.targetDate,
        inputMaWindow,
        inputMaValue: row.calculation.reverse.predictedMa as number,
        predictedClose: row.derivedClose as number,
        predictedMaValues: normalizeMaNumberRecord(row.maValues),
        baseClose,
        baseMaValues,
        note: planNote ?? '',
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
  points: KLinePoint[] = [],
) {
  const byId = new Map(existingSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  for (const incoming of incomingSnapshots) {
    const existing = byId.get(incoming.id);
    if (existing && findReplayActualPoint(existing, points)) continue;

    byId.set(incoming.id, {
      ...incoming,
      createdAt: existing?.createdAt ?? incoming.createdAt,
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
  const actualMaByWindow = getMaValueMaps(points);

  return snapshots.map((snapshot) => {
    const actualPoint = findReplayActualPoint(snapshot, points);
    const actualClose = actualPoint?.close ?? null;
    const closeDiff = calculateDiff(snapshot.predictedClose, actualClose);
    const predictedCloseDirection = getDirection(snapshot.baseClose, snapshot.predictedClose);
    const actualCloseDirection = getDirection(snapshot.baseClose, actualClose);
    const maComparisons = Object.fromEntries(
      MA_WINDOWS.map((windowSize) => {
        const predicted = snapshot.predictedMaValues[String(windowSize)] ?? null;
        const actual = actualPoint
          ? actualMaByWindow[windowSize].get(actualPoint.date) ?? null
          : null;
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

export function findReplayActualPoint(
  snapshot: Pick<ReplaySnapshot, 'period' | 'targetDate'>,
  points: KLinePoint[],
) {
  const matches = points.filter((point) =>
    isSameReplayPeriod(point.date, snapshot.targetDate, snapshot.period),
  );
  return matches.sort((a, b) => a.date.localeCompare(b.date)).at(-1) ?? null;
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

function normalizeReplaySnapshot(
  value: unknown,
  stockCode: string,
  period: PeriodType,
): ReplaySnapshot | null {
  if (!isPlainReplaySnapshotObject(value)) return null;
  const candidate = value as unknown as ReplaySnapshot;
  if (
    candidate?.schema !== REPLAY_SNAPSHOT_SCHEMA ||
    typeof candidate.id !== 'string' ||
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
    stockCode,
    stockName: typeof candidate.stockName === 'string' ? candidate.stockName : undefined,
    period,
    planId: typeof candidate.planId === 'string' ? candidate.planId : undefined,
    planName: typeof candidate.planName === 'string' ? candidate.planName : undefined,
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
  return `prediction-ma:replay:${normalizeStockCode(stockCode)}:${period}:v1`;
}

function isSameReplayPeriod(actualDate: string, targetDate: string, period: PeriodType) {
  if (period === 'day') return actualDate === targetDate;
  if (period === 'month') return actualDate.slice(0, 7) === targetDate.slice(0, 7);

  const actualWeek = getIsoWeekKey(actualDate);
  return actualWeek !== null && actualWeek === getIsoWeekKey(targetDate);
}

function getIsoWeekKey(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  const isoDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - isoDay);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function assertReplaySnapshotOwnership(
  value: unknown,
  stockCode: string,
  period: PeriodType,
) {
  if (!isPlainReplaySnapshotObject(value)) {
    throw new Error('Replay snapshot must be a plain object');
  }
  if (hasConflictingReplayOwnership(value, stockCode, period)) {
    throw new Error(`Replay snapshot ownership conflicts with ${stockCode}/${period}`);
  }
}

function hasConflictingReplayOwnership(
  value: Record<string, unknown>,
  stockCode: string,
  period: PeriodType,
) {
  const hasStockCode = Object.prototype.hasOwnProperty.call(value, 'stockCode');
  if (
    hasStockCode &&
    (typeof value.stockCode !== 'string' || normalizeStockCode(value.stockCode) !== stockCode)
  ) {
    return true;
  }

  const hasPeriod = Object.prototype.hasOwnProperty.call(value, 'period');
  return hasPeriod && (!isPeriodType(value.period) || value.period !== period);
}

function isPlainReplaySnapshotObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPeriodType(value: unknown): value is PeriodType {
  return value === 'day' || value === 'week' || value === 'month';
}

function normalizeStockCode(value: string) {
  return value.replace(/\D/g, '').slice(0, 6);
}

function buildReplaySnapshotId(
  stockCode: string,
  period: PeriodType,
  baseDate: string,
  targetDate: string,
  inputMaWindow: MaWindow,
  planId?: string | null,
) {
  const normalizedCode = stockCode.replace(/\D/g, '').slice(0, 6);
  const normalizedPlanId = planId ? `:${planId}` : '';
  return `${normalizedCode}:${period}${normalizedPlanId}:${baseDate}:${targetDate}:MA${inputMaWindow}`;
}

function compareSnapshots(a: ReplaySnapshot, b: ReplaySnapshot) {
  return (
    a.targetDate.localeCompare(b.targetDate) ||
    a.baseDate.localeCompare(b.baseDate) ||
    a.inputMaWindow - b.inputMaWindow
  );
}
