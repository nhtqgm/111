import type { KLinePoint, PredictionPoint } from '../types';

export const MA40_WINDOW = 40;

export interface LineValuePoint {
  targetDate: string;
  value: number | null;
}

export interface Ma40ProjectionRow extends PredictionPoint {
  actualClose: number | null;
  derivedClose: number | null;
  ma40: number | null;
}

export interface Ma40Projection {
  rows: Ma40ProjectionRow[];
  actualLine: LineValuePoint[];
  predictedLine: LineValuePoint[];
  closeByDate: Map<string, number>;
}

export function calculateMovingAverage(
  points: KLinePoint[],
  windowSize = MA40_WINDOW,
): LineValuePoint[] {
  return points.map((point, index) => {
    const window = points.slice(index - windowSize + 1, index + 1);
    return {
      targetDate: point.date,
      value: window.length === windowSize ? average(window.map((item) => item.close)) : null,
    };
  });
}

export function buildMa40Projection(
  points: KLinePoint[],
  predictions: PredictionPoint[],
  baseDate: string,
): Ma40Projection {
  const actualCloseByDate = new Map(points.map((point) => [point.date, point.close]));
  const closeByDate = new Map(actualCloseByDate);
  const sortedPredictions = [...predictions].sort((a, b) =>
    a.targetDate.localeCompare(b.targetDate),
  );
  const orderedDates = mergeDates(
    points.map((point) => point.date),
    sortedPredictions.map((row) => row.targetDate),
  );

  const rows = sortedPredictions.map((row) => {
    const predictedMa40 = parseInput(row.predictedMa40);
    const derivedClose =
      predictedMa40 === null
        ? null
        : reverseCloseFromMovingAverage(orderedDates, closeByDate, row.targetDate, predictedMa40);

    if (derivedClose !== null) {
      closeByDate.set(row.targetDate, derivedClose);
    } else if (!closeByDate.has(row.targetDate)) {
      closeByDate.set(row.targetDate, Number.NaN);
    }

    return {
      ...row,
      actualClose: actualCloseByDate.get(row.targetDate) ?? null,
      derivedClose,
      ma40:
        derivedClose === null
          ? null
          : calculateMovingAverageAtDate(orderedDates, closeByDate, row.targetDate),
    };
  });

  const actualLine = calculateMovingAverage(points).filter(
    (row) => row.value !== null && row.targetDate < baseDate,
  );
  const anchor = [...actualLine].reverse().find((row) => row.targetDate < baseDate);
  const predictedLine: LineValuePoint[] = [
    ...(anchor ? [anchor] : []),
    ...rows.map((row) => ({
      targetDate: row.targetDate,
      value: row.ma40,
    })),
  ];

  return {
    rows,
    actualLine,
    predictedLine,
    closeByDate,
  };
}

function reverseCloseFromMovingAverage(
  orderedDates: string[],
  closeByDate: Map<string, number>,
  targetDate: string,
  targetMa40: number,
) {
  const targetIndex = orderedDates.indexOf(targetDate);
  if (targetIndex < 0) return null;

  const previousDates = orderedDates.slice(targetIndex - (MA40_WINDOW - 1), targetIndex);
  if (previousDates.length !== MA40_WINDOW - 1) return null;

  const previousValues = previousDates.map((date) => closeByDate.get(date) ?? Number.NaN);
  if (previousValues.some((value) => !Number.isFinite(value))) return null;

  return targetMa40 * MA40_WINDOW - sum(previousValues);
}

function calculateMovingAverageAtDate(
  orderedDates: string[],
  closeByDate: Map<string, number>,
  targetDate: string,
) {
  const targetIndex = orderedDates.indexOf(targetDate);
  if (targetIndex < 0) return null;

  const windowDates = orderedDates.slice(targetIndex - MA40_WINDOW + 1, targetIndex + 1);
  if (windowDates.length !== MA40_WINDOW) return null;

  const values = windowDates.map((date) => closeByDate.get(date) ?? Number.NaN);
  if (values.some((value) => !Number.isFinite(value))) return null;

  return average(values);
}

function parseInput(value: string) {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mergeDates(actualDates: string[], predictedDates: string[]) {
  return Array.from(new Set([...actualDates, ...predictedDates])).sort();
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]) {
  return sum(values) / values.length;
}
