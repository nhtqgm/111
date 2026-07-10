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
    const snapshots = parsed.flatMap((item) => {
      if (
        !isPlainReplaySnapshotObject(item) ||
        hasConflictingReplayOwnership(item, normalizedStockCode, period)
      ) {
        return [];
      }

      const result = normalizeReplaySnapshot(item, normalizedStockCode, period);
      return result.snapshot ? [result.snapshot] : [];
    });
    return deduplicateReplaySnapshots(snapshots);
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
    const result = normalizeReplaySnapshot(snapshot, normalizedStockCode, period);
    if (!result.snapshot) throw new Error(getReplayNormalizationError(result.reason));
    return result.snapshot;
  });
  const deduplicatedSnapshots = deduplicateReplaySnapshots(normalizedSnapshots);

  localStorage.setItem(
    replayStorageKey(normalizedStockCode, period),
    JSON.stringify(deduplicatedSnapshots),
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
  requireReplayCalendarDate(baseDate, 'base');
  const normalizedStockCode = normalizeStockCode(stockCode);
  const normalizedPlanId = normalizeReplayPlanId(planId);
  const validPoints = filterValidReplayPoints(points);
  const closeByDate = new Map(validPoints.map((point) => [point.date, point.close]));
  const baseClose = closeByDate.get(baseDate) ?? null;
  const baseMaValues = getMaValuesAtDate(validPoints, baseDate);
  const existingById = new Map(
    deduplicateReplaySnapshots(existingSnapshots).map((snapshot) => [snapshot.id, snapshot]),
  );

  return rows
    .filter(
      (row) =>
        row.derivedClose !== null &&
        row.calculation.reverse.predictedMa !== null &&
        Number.isFinite(row.derivedClose),
    )
    .map((row) => {
      requireReplayCalendarDate(row.targetDate, 'target');
      const id = buildReplaySnapshotId(
        normalizedStockCode,
        period,
        baseDate,
        row.targetDate,
        inputMaWindow,
        normalizedPlanId,
      );
      const existing = existingById.get(id);

      return {
        schema: REPLAY_SNAPSHOT_SCHEMA,
        id,
        stockCode: normalizedStockCode,
        stockName,
        period,
        planId: normalizedPlanId,
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
  const byId = new Map(
    deduplicateReplaySnapshots(existingSnapshots).map((snapshot) => [snapshot.id, snapshot]),
  );
  for (const incoming of deduplicateReplaySnapshots(incomingSnapshots)) {
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
  const validPoints = filterValidReplayPoints(points);
  const actualMaByWindow = getMaValueMaps(validPoints);

  return snapshots.map((snapshot) => {
    const actualPoint = findReplayActualPoint(snapshot, validPoints);
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
  snapshot: Pick<ReplaySnapshot, 'period' | 'targetDate'> &
    Partial<Pick<ReplaySnapshot, 'baseDate'>>,
  points: KLinePoint[],
) {
  const targetDate = parseReplayCalendarDate(snapshot.targetDate);
  if (!targetDate) return null;
  if (snapshot.baseDate !== undefined && !parseReplayCalendarDate(snapshot.baseDate)) return null;

  const matches = points.filter((point) => {
    const actualDate = parseReplayCalendarDate(point.date);
    return actualDate && isSameReplayPeriod(actualDate, targetDate, snapshot.period);
  });
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

function filterValidReplayPoints(points: KLinePoint[]) {
  return points.filter((point) => parseReplayCalendarDate(point.date) !== null);
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

type ReplayNormalizationReason = 'invalid' | 'date' | 'id';

type ReplayNormalizationResult =
  | { snapshot: ReplaySnapshot; reason?: never }
  | { snapshot: null; reason: ReplayNormalizationReason };

function normalizeReplaySnapshot(
  value: unknown,
  stockCode: string,
  period: PeriodType,
): ReplayNormalizationResult {
  if (!isPlainReplaySnapshotObject(value)) return { snapshot: null, reason: 'invalid' };
  const candidate = value as unknown as ReplaySnapshot;
  if (
    candidate?.schema !== REPLAY_SNAPSHOT_SCHEMA ||
    typeof candidate.id !== 'string' ||
    typeof candidate.baseDate !== 'string' ||
    typeof candidate.targetDate !== 'string' ||
    (candidate.planId !== undefined &&
      candidate.planId !== null &&
      typeof candidate.planId !== 'string') ||
    !MA_WINDOWS.includes(candidate.inputMaWindow) ||
    !Number.isFinite(candidate.inputMaValue) ||
    !Number.isFinite(candidate.predictedClose)
  ) {
    return { snapshot: null, reason: 'invalid' };
  }

  if (
    !parseReplayCalendarDate(candidate.baseDate) ||
    !parseReplayCalendarDate(candidate.targetDate)
  ) {
    return { snapshot: null, reason: 'date' };
  }

  const planId = normalizeReplayPlanId(candidate.planId);
  const canonicalId = buildReplaySnapshotId(
    stockCode,
    period,
    candidate.baseDate,
    candidate.targetDate,
    candidate.inputMaWindow,
    planId,
  );
  const supportedIds = getSupportedReplaySnapshotIds(
    stockCode,
    period,
    candidate.baseDate,
    candidate.targetDate,
    candidate.inputMaWindow,
    planId,
  );
  if (!supportedIds.includes(candidate.id)) {
    return { snapshot: null, reason: 'id' };
  }

  return {
    snapshot: {
      schema: REPLAY_SNAPSHOT_SCHEMA,
      id: canonicalId,
      stockCode,
      stockName: typeof candidate.stockName === 'string' ? candidate.stockName : undefined,
      period,
      planId,
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
    },
  };
}

function getReplayNormalizationError(reason: ReplayNormalizationReason) {
  if (reason === 'date') return 'Replay snapshot contains an invalid date';
  if (reason === 'id') return 'Replay snapshot ID conflicts with its normalized fields';
  return 'Invalid replay snapshot';
}

function deduplicateReplaySnapshots(snapshots: ReplaySnapshot[]) {
  const byId = new Map<string, ReplaySnapshot>();
  for (const snapshot of snapshots) {
    const existing = byId.get(snapshot.id);
    byId.set(snapshot.id, existing ? chooseReplaySnapshot(existing, snapshot) : snapshot);
  }
  return Array.from(byId.values()).sort(compareSnapshots);
}

function chooseReplaySnapshot(existing: ReplaySnapshot, incoming: ReplaySnapshot) {
  const existingUpdatedAt = getValidTimestamp(existing.updatedAt);
  const incomingUpdatedAt = getValidTimestamp(incoming.updatedAt);
  if (existingUpdatedAt !== null || incomingUpdatedAt !== null) {
    if (existingUpdatedAt === null) return incoming;
    if (incomingUpdatedAt === null) return existing;
    if (existingUpdatedAt !== incomingUpdatedAt) {
      return incomingUpdatedAt > existingUpdatedAt ? incoming : existing;
    }
  }

  // Equal or unusable timestamps use stable content ordering, never array order.
  return stableSerializeReplayValue(incoming) > stableSerializeReplayValue(existing)
    ? incoming
    : existing;
}

function getValidTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function stableSerializeReplayValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerializeReplayValue).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerializeReplayValue(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
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

interface ReplayCalendarDate {
  value: string;
  year: number;
  month: number;
  day: number;
  timestamp: number;
}

function parseReplayCalendarDate(value: unknown): ReplayCalendarDate | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = createUtcDate(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { value, year, month, day, timestamp: date.getTime() };
}

function requireReplayCalendarDate(value: string, label: 'base' | 'target') {
  const parsed = parseReplayCalendarDate(value);
  if (!parsed) throw new Error(`Invalid replay ${label} date`);
  return parsed;
}

function createUtcDate(year: number, monthIndex: number, day: number) {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

function isSameReplayPeriod(
  actualDate: ReplayCalendarDate,
  targetDate: ReplayCalendarDate,
  period: PeriodType,
) {
  if (period === 'day') return actualDate.timestamp === targetDate.timestamp;
  if (period === 'month') {
    return actualDate.year === targetDate.year && actualDate.month === targetDate.month;
  }
  return getIsoWeekKey(actualDate) === getIsoWeekKey(targetDate);
}

function getIsoWeekKey(value: ReplayCalendarDate) {
  const date = new Date(value.timestamp);
  const isoDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - isoDay);
  const isoYear = date.getUTCFullYear();
  const yearStart = createUtcDate(isoYear, 0, 1);
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

function normalizeReplayPlanId(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function buildReplaySnapshotId(
  stockCode: string,
  period: PeriodType,
  baseDate: string,
  targetDate: string,
  inputMaWindow: MaWindow,
  planId?: string | null,
) {
  const normalizedCode = normalizeStockCode(stockCode);
  const normalizedPlanId = normalizeReplayPlanId(planId);
  const ownerId = normalizedPlanId
    ? `owner~plan~${encodeURIComponent(normalizedPlanId)}`
    : 'owner~legacy';
  return `${normalizedCode}:${period}:${ownerId}:${baseDate}:${targetDate}:MA${inputMaWindow}`;
}

function getSupportedReplaySnapshotIds(
  stockCode: string,
  period: PeriodType,
  baseDate: string,
  targetDate: string,
  inputMaWindow: MaWindow,
  planId?: string | null,
) {
  const normalizedCode = normalizeStockCode(stockCode);
  const normalizedPlanId = normalizeReplayPlanId(planId);
  const suffix = `${baseDate}:${targetDate}:MA${inputMaWindow}`;
  const canonicalId = buildReplaySnapshotId(
    normalizedCode,
    period,
    baseDate,
    targetDate,
    inputMaWindow,
    normalizedPlanId,
  );
  return normalizedPlanId
    ? [canonicalId, `${normalizedCode}:${period}:${normalizedPlanId}:${suffix}`]
    : [
        canonicalId,
        `${normalizedCode}:${period}:legacy:${suffix}`,
        `${normalizedCode}:${period}:${suffix}`,
      ];
}

function compareSnapshots(a: ReplaySnapshot, b: ReplaySnapshot) {
  return (
    a.targetDate.localeCompare(b.targetDate) ||
    a.baseDate.localeCompare(b.baseDate) ||
    a.inputMaWindow - b.inputMaWindow ||
    a.id.localeCompare(b.id)
  );
}
