import type { KLinePoint, PeriodType, PredictionPoint } from '../types.ts';
import {
  buildMa40Projection,
  MA_WINDOWS,
  type CalculationValueItem,
  type MaWindow,
} from './movingAverage.ts';

export const ISSUED_FORECAST_BATCH_SCHEMA = 'gupiao-issued-forecast-batch/v1' as const;
const ISSUED_FORECAST_REVISION_PATTERN = /^[A-Za-z0-9._~-]{1,200}$/;

export type IssuedForecastMaValues = Readonly<Record<MaWindow, number | null>>;

export interface IssuedForecastBasisValue {
  periodKey: string;
  targetDate: string;
  value: number;
  source: CalculationValueItem['source'];
}

export interface IssuedForecastRow {
  id: string;
  targetDate: string;
  periodKey: string;
  horizon: number;
  inputMaValue: number;
  predictedClose: number;
  predictedMaValues: IssuedForecastMaValues;
  note: string;
  previousSumAtIssue: number;
  basisValues: readonly IssuedForecastBasisValue[];
}

export interface IssuedForecastBatch {
  schema: typeof ISSUED_FORECAST_BATCH_SCHEMA;
  id: string;
  stockCode: string;
  period: PeriodType;
  inputMaWindow: MaWindow;
  revision: string;
  asOfDate: string;
  asOfPeriodKey: string;
  issuedAt: string;
  /**
   * Authoritative ordering assigned by the cloud transaction. This is server
   * metadata, not part of the immutable prediction payload created locally.
   */
  readonly serverSequence?: number;
  /** Authoritative server timestamp for the immutable cloud transaction. */
  readonly serverPersistedAt?: string;
  rows: readonly IssuedForecastRow[];
}

export interface CreateIssuedForecastBatchInput {
  stockCode: string;
  period: PeriodType;
  inputMaWindow: MaWindow;
  revision: string;
  asOfDate: string;
  issuedAt: string;
  points: readonly KLinePoint[];
  predictions: readonly PredictionPoint[];
}

export interface IssuedForecastScope {
  stockCode: string;
  period: PeriodType;
  inputMaWindow: MaWindow;
}

export interface CurrentForecastValue {
  periodKey: string;
  targetDate: string;
  value: number;
  source: 'actual' | 'issued';
}

export interface IssuedForecastSettlement {
  actualDate: string;
  actualClose: number;
  closeDiff: number;
  closeDiffPct: number | null;
}

export interface EvaluatedIssuedForecastRow extends IssuedForecastRow {
  currentImpliedMa: number | null;
  conditionalClose: number | null;
  conditionalPreviousSum: number | null;
  currentWindowValues: readonly CurrentForecastValue[];
  conditionalBasisValues: readonly CurrentForecastValue[];
  settlement: IssuedForecastSettlement | null;
}

export interface IssuedForecastBatchEvaluation {
  batchId: string;
  evaluationAsOfDate: string;
  rows: readonly EvaluatedIssuedForecastRow[];
}

export interface EvaluateIssuedForecastBatchInput {
  points: readonly KLinePoint[];
  evaluationAsOfDate: string;
}

/**
 * Creates one immutable forecast revision from data known at `asOfDate`.
 * Every future row that can be calculated is frozen in the same batch.
 */
export function createIssuedForecastBatch(
  input: CreateIssuedForecastBatchInput,
): IssuedForecastBatch {
  validateCreateInput(input);

  const toPeriodKey = createPeriodKeyResolver(input.period);
  const stockCode = input.stockCode.trim();
  const revision = input.revision.trim();
  const batchId = createIssuedForecastBatchId({
    stockCode,
    period: input.period,
    inputMaWindow: input.inputMaWindow,
    revision,
    asOfDate: input.asOfDate,
  });
  const pointsAtIssue = input.points.filter((point) => point.date <= input.asOfDate);
  const projection = buildMa40Projection(
    [...pointsAtIssue],
    [...input.predictions],
    input.asOfDate,
    input.inputMaWindow,
    input.period,
  );

  const projectedRows = projection.rows.filter((row) =>
    row.isForecast &&
    row.derivedClose !== null && Number.isFinite(row.derivedClose) &&
    row.calculation.reverse.predictedMa !== null &&
    row.calculation.reverse.previousSum !== null,
  );
  const seenPeriods = new Set<string>();
  const rows = projectedRows.map((row, index) => {
    const periodKey = toPeriodKey(row.targetDate);
    if (seenPeriods.has(periodKey)) {
      throw new Error(`Duplicate issued forecast period: ${periodKey}`);
    }
    seenPeriods.add(periodKey);

    const horizon = index + 1;
    const inputMaValue = row.calculation.reverse.predictedMa as number;
    const predictedClose = row.derivedClose as number;
    const previousSumAtIssue = row.calculation.reverse.previousSum as number;
    const predictedMaValues = freezeMaValues(row.maValues);
    const basisValues = Object.freeze(
      row.calculation.reverse.previousValues.map((value) =>
        Object.freeze({
          periodKey: toPeriodKey(value.targetDate),
          targetDate: value.targetDate,
          value: value.value,
          source: value.source,
        }),
      ),
    );

    return Object.freeze({
      id: `${batchId}:${periodKey}:H${horizon}`,
      targetDate: row.targetDate,
      periodKey,
      horizon,
      inputMaValue,
      predictedClose,
      predictedMaValues,
      note: row.note,
      previousSumAtIssue,
      basisValues,
    });
  });

  if (rows.length === 0) {
    throw new Error('No valid future forecast rows can be issued');
  }

  return Object.freeze({
    schema: ISSUED_FORECAST_BATCH_SCHEMA,
    id: batchId,
    stockCode,
    period: input.period,
    inputMaWindow: input.inputMaWindow,
    revision,
    asOfDate: input.asOfDate,
    asOfPeriodKey: toPeriodKey(input.asOfDate),
    issuedAt: input.issuedAt,
    rows: Object.freeze(rows),
  });
}

/**
 * Evaluates an issued revision against newer completed K-lines. The frozen
 * `predictedClose` remains the target value; actuals only affect the current
 * implied MA, the conditional close, and settlement metadata.
 */
export function evaluateIssuedForecastBatch(
  batch: IssuedForecastBatch,
  input: EvaluateIssuedForecastBatchInput,
): IssuedForecastBatchEvaluation {
  validateEvaluationInput(batch, input);

  const toPeriodKey = createPeriodKeyResolver(batch.period);
  const actualPointByPeriod = buildActualPointMap(
    input.points.filter((point) => point.date <= input.evaluationAsOfDate),
    toPeriodKey,
  );
  const issuedRowByPeriod = new Map(batch.rows.map((row) => [row.periodKey, row]));
  const orderedPeriods = Array.from(
    new Set([...actualPointByPeriod.keys(), ...issuedRowByPeriod.keys()]),
  ).sort();

  const rows = batch.rows.map((row) => {
    const targetIndex = orderedPeriods.indexOf(row.periodKey);
    const previousPeriods = targetIndex < 0
      ? []
      : orderedPeriods.slice(targetIndex - (batch.inputMaWindow - 1), targetIndex);
    const windowPeriods = targetIndex < 0
      ? []
      : orderedPeriods.slice(targetIndex - batch.inputMaWindow + 1, targetIndex + 1);
    const conditionalBasisValues = previousPeriods.length === batch.inputMaWindow - 1
      ? buildCurrentValues(previousPeriods, row.periodKey, actualPointByPeriod, issuedRowByPeriod)
      : [];
    const currentWindowValues = windowPeriods.length === batch.inputMaWindow
      ? buildCurrentValues(windowPeriods, row.periodKey, actualPointByPeriod, issuedRowByPeriod)
      : [];
    const hasConditionalBasis = conditionalBasisValues.length === batch.inputMaWindow - 1;
    const hasCurrentWindow = currentWindowValues.length === batch.inputMaWindow;
    const conditionalPreviousSum = hasConditionalBasis
      ? sum(conditionalBasisValues.map((value) => value.value))
      : null;
    const conditionalClose = conditionalPreviousSum === null
      ? null
      : row.inputMaValue * batch.inputMaWindow - conditionalPreviousSum;
    const currentImpliedMa = hasCurrentWindow
      ? sum(currentWindowValues.map((value) => value.value)) / batch.inputMaWindow
      : null;
    const actual = actualPointByPeriod.get(row.periodKey);
    const settlement = actual
      ? freezeSettlement(row.predictedClose, actual)
      : null;

    return Object.freeze({
      ...row,
      currentImpliedMa,
      conditionalClose,
      conditionalPreviousSum,
      currentWindowValues: Object.freeze(currentWindowValues),
      conditionalBasisValues: Object.freeze(conditionalBasisValues),
      settlement,
    });
  });

  return Object.freeze({
    batchId: batch.id,
    evaluationAsOfDate: input.evaluationAsOfDate,
    rows: Object.freeze(rows),
  });
}

export function createIssuedForecastScopeKey(scope: IssuedForecastScope) {
  return `${scope.stockCode.trim()}:${scope.period}:MA${scope.inputMaWindow}`;
}

export function getIssuedForecastPeriodKey(period: PeriodType, date: string) {
  return createPeriodKeyResolver(period)(date);
}

export function createIssuedForecastBatchId(
  identity: IssuedForecastScope & { revision: string; asOfDate: string },
) {
  const revision = identity.revision.trim();
  if (!isValidIssuedForecastRevision(revision)) {
    throw new Error('Issued forecast revision contains unsupported characters');
  }
  return `${createIssuedForecastScopeKey(identity)}:${identity.asOfDate}:${revision}`;
}

export function isValidIssuedForecastRevision(value: string) {
  return ISSUED_FORECAST_REVISION_PATTERN.test(value.trim());
}

/** Returns a new array grouped by stock/period/window, then oldest to newest. */
export function sortIssuedForecastBatches(
  batches: readonly IssuedForecastBatch[],
): IssuedForecastBatch[] {
  return [...batches].sort((left, right) =>
    compareScope(left, right) ||
    compareIssueOrder(left, right),
  );
}

/** Selects the newest issued revision without mutating the supplied list. */
export function selectActiveIssuedForecastBatch(
  batches: readonly IssuedForecastBatch[],
  scope: IssuedForecastScope,
): IssuedForecastBatch | null {
  const scopeKey = createIssuedForecastScopeKey(scope);
  return batches.reduce<IssuedForecastBatch | null>((latest, batch) => {
    if (createIssuedForecastScopeKey(batch) !== scopeKey) return latest;
    if (latest === null || compareIssueOrder(batch, latest) > 0) return batch;
    return latest;
  }, null);
}

function buildCurrentValues(
  periodKeys: string[],
  targetPeriodKey: string,
  actualPointByPeriod: Map<string, KLinePoint>,
  issuedRowByPeriod: Map<string, IssuedForecastRow>,
): CurrentForecastValue[] {
  return periodKeys.flatMap((periodKey) => {
    const issued = issuedRowByPeriod.get(periodKey);
    const actual = actualPointByPeriod.get(periodKey);

    // The target itself always remains the issued close. A completed actual for
    // that target is exposed separately through `settlement`.
    if (periodKey === targetPeriodKey && issued) {
      return [freezeCurrentValue(periodKey, issued.targetDate, issued.predictedClose, 'issued')];
    }
    if (actual) {
      return [freezeCurrentValue(periodKey, actual.date, actual.close, 'actual')];
    }
    if (issued) {
      return [freezeCurrentValue(periodKey, issued.targetDate, issued.predictedClose, 'issued')];
    }
    return [];
  });
}

function freezeCurrentValue(
  periodKey: string,
  targetDate: string,
  value: number,
  source: CurrentForecastValue['source'],
) {
  return Object.freeze({ periodKey, targetDate, value, source });
}

function freezeSettlement(predictedClose: number, actual: KLinePoint) {
  const closeDiff = predictedClose - actual.close;
  return Object.freeze({
    actualDate: actual.date,
    actualClose: actual.close,
    closeDiff,
    closeDiffPct: actual.close === 0 ? null : (closeDiff / actual.close) * 100,
  });
}

function freezeMaValues(values: Record<MaWindow, number | null>): IssuedForecastMaValues {
  return Object.freeze(
    Object.fromEntries(
      MA_WINDOWS.map((windowSize) => [windowSize, values[windowSize]]),
    ) as Record<MaWindow, number | null>,
  );
}

function buildActualPointMap(
  points: readonly KLinePoint[],
  toPeriodKey: (date: string) => string,
) {
  const actualPointByPeriod = new Map<string, KLinePoint>();
  for (const point of points) {
    if (!isDate(point.date) || !Number.isFinite(point.close)) continue;
    const periodKey = toPeriodKey(point.date);
    const existing = actualPointByPeriod.get(periodKey);
    if (!existing || point.date >= existing.date) actualPointByPeriod.set(periodKey, point);
  }
  return actualPointByPeriod;
}

function compareIssueOrder(left: IssuedForecastBatch, right: IssuedForecastBatch) {
  if (left.serverSequence !== undefined || right.serverSequence !== undefined) {
    if (left.serverSequence === undefined) return -1;
    if (right.serverSequence === undefined) return 1;
    if (left.serverSequence !== right.serverSequence) {
      return left.serverSequence - right.serverSequence;
    }
  }
  return left.issuedAt.localeCompare(right.issuedAt) ||
    left.asOfDate.localeCompare(right.asOfDate) ||
    left.revision.localeCompare(right.revision) ||
    left.id.localeCompare(right.id);
}

function compareScope(left: IssuedForecastScope, right: IssuedForecastScope) {
  const periodOrder: Record<PeriodType, number> = { day: 0, week: 1, month: 2 };
  return left.stockCode.trim().localeCompare(right.stockCode.trim()) ||
    periodOrder[left.period] - periodOrder[right.period] ||
    left.inputMaWindow - right.inputMaWindow;
}

function validateCreateInput(input: CreateIssuedForecastBatchInput) {
  if (!/^\d{6}$/.test(input.stockCode.trim())) {
    throw new Error('Issued forecast stockCode must contain exactly six digits');
  }
  if (!MA_WINDOWS.includes(input.inputMaWindow)) {
    throw new Error(`Unsupported MA window: ${input.inputMaWindow}`);
  }
  if (!isValidIssuedForecastRevision(input.revision)) {
    throw new Error('Issued forecast revision must use 1-200 URL-safe characters');
  }
  if (!isDate(input.asOfDate)) throw new Error(`Invalid issued forecast asOfDate: ${input.asOfDate}`);
  if (!isTimestamp(input.issuedAt)) throw new Error(`Invalid issued forecast issuedAt: ${input.issuedAt}`);
}

function validateEvaluationInput(
  batch: IssuedForecastBatch,
  input: EvaluateIssuedForecastBatchInput,
) {
  if (!isDate(input.evaluationAsOfDate)) {
    throw new Error(`Invalid forecast evaluation date: ${input.evaluationAsOfDate}`);
  }
  if (input.evaluationAsOfDate < batch.asOfDate) {
    throw new Error('Forecast evaluation cannot precede the issued asOfDate');
  }
}

function createPeriodKeyResolver(period: PeriodType) {
  if (period === 'month') return (date: string) => date.slice(0, 7);
  if (period === 'week') {
    return (date: string) => {
      const parsed = new Date(`${date}T00:00:00Z`);
      if (!Number.isFinite(parsed.getTime())) return date;
      const day = parsed.getUTCDay() || 7;
      parsed.setUTCDate(parsed.getUTCDate() - day + 1);
      return parsed.toISOString().slice(0, 10);
    };
  }
  return (date: string) => date;
}

function isDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isTimestamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
