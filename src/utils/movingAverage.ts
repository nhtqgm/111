import type { KLinePoint, PredictionPoint } from '../types';

export const MA_WINDOWS = [5, 10, 20, 40, 60] as const;
export type MaWindow = (typeof MA_WINDOWS)[number];
export const MA40_WINDOW: MaWindow = 40;

export interface LineValuePoint {
  targetDate: string;
  value: number | null;
}

export interface Ma40ProjectionRow extends PredictionPoint {
  actualClose: number | null;
  derivedClose: number | null;
  ma40: number | null;
  maValues: Record<MaWindow, number | null>;
}

export interface Ma40Projection {
  rows: Ma40ProjectionRow[];
  actualLines: Record<MaWindow, LineValuePoint[]>;
  predictedLines: Record<MaWindow, LineValuePoint[]>;
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
  inputWindow: MaWindow = MA40_WINDOW,
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
    const predictedMa = parseInput(getPredictedMaInput(row, inputWindow));
    const derivedClose =
      predictedMa === null
        ? null
        : reverseCloseFromMovingAverage(
            orderedDates,
            closeByDate,
            row.targetDate,
            predictedMa,
            inputWindow,
          );

    if (derivedClose !== null) {
      closeByDate.set(row.targetDate, derivedClose);
    } else if (!closeByDate.has(row.targetDate)) {
      closeByDate.set(row.targetDate, Number.NaN);
    }

    const maValues = Object.fromEntries(
      MA_WINDOWS.map((windowSize) => [
        windowSize,
        derivedClose === null
          ? null
          : calculateMovingAverageAtDate(orderedDates, closeByDate, row.targetDate, windowSize),
      ]),
    ) as Record<MaWindow, number | null>;

    return {
      ...row,
      actualClose: actualCloseByDate.get(row.targetDate) ?? null,
      derivedClose,
      ma40: maValues[40],
      maValues,
    };
  });

  const actualLines = Object.fromEntries(
    MA_WINDOWS.map((windowSize) => [
      windowSize,
      calculateMovingAverage(points, windowSize).filter(
        (row) => row.value !== null && row.targetDate < baseDate,
      ),
    ]),
  ) as Record<MaWindow, LineValuePoint[]>;
  const predictedLines = Object.fromEntries(
    MA_WINDOWS.map((windowSize) => {
      const anchor = [...actualLines[windowSize]].reverse().find(
        (row) => row.targetDate < baseDate,
      );

      return [
        windowSize,
        [
          ...(anchor ? [anchor] : []),
          ...rows.map((row) => ({
            targetDate: row.targetDate,
            value: row.maValues[windowSize],
          })),
        ],
      ];
    }),
  ) as Record<MaWindow, LineValuePoint[]>;

  return {
    rows,
    actualLines,
    predictedLines,
    closeByDate,
  };
}

function reverseCloseFromMovingAverage(
  orderedDates: string[],
  closeByDate: Map<string, number>,
  targetDate: string,
  targetMa: number,
  windowSize: MaWindow,
) {
  const targetIndex = orderedDates.indexOf(targetDate);
  if (targetIndex < 0) return null;

  const previousDates = orderedDates.slice(targetIndex - (windowSize - 1), targetIndex);
  if (previousDates.length !== windowSize - 1) return null;

  const previousValues = previousDates.map((date) => closeByDate.get(date) ?? Number.NaN);
  if (previousValues.some((value) => !Number.isFinite(value))) return null;

  return targetMa * windowSize - sum(previousValues);
}

function calculateMovingAverageAtDate(
  orderedDates: string[],
  closeByDate: Map<string, number>,
  targetDate: string,
  windowSize: MaWindow,
) {
  const targetIndex = orderedDates.indexOf(targetDate);
  if (targetIndex < 0) return null;

  const windowDates = orderedDates.slice(targetIndex - windowSize + 1, targetIndex + 1);
  if (windowDates.length !== windowSize) return null;

  const values = windowDates.map((date) => closeByDate.get(date) ?? Number.NaN);
  if (values.some((value) => !Number.isFinite(value))) return null;

  return average(values);
}

function parseInput(value: string) {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getPredictedMaInput(row: PredictionPoint, windowSize: MaWindow) {
  return row.predictedMaValues[String(windowSize)] ?? (windowSize === 40 ? row.predictedMa40 : '');
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
