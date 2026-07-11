import type { KLinePoint, PredictionPoint } from '../types';

export const MA_WINDOWS = [5, 10, 20, 40, 60] as const;
export type MaWindow = (typeof MA_WINDOWS)[number];
export const MA40_WINDOW: MaWindow = 40;

export interface LineValuePoint {
  targetDate: string;
  value: number | null;
}

export interface CalculationValueItem {
  targetDate: string;
  value: number;
  source: 'actual' | 'predicted';
}

export interface ReverseCalculationDetail {
  inputWindow: MaWindow;
  predictedMa: number | null;
  previousValues: CalculationValueItem[];
  previousSum: number | null;
  derivedClose: number | null;
  reason: string | null;
}

export interface MovingAverageCalculationDetail {
  windowSize: MaWindow;
  values: CalculationValueItem[];
  sum: number | null;
  average: number | null;
  reason: string | null;
}

export interface ProjectionCalculationDetail {
  reverse: ReverseCalculationDetail;
  movingAverages: Record<MaWindow, MovingAverageCalculationDetail>;
}

export interface Ma40ProjectionRow extends PredictionPoint {
  actualClose: number | null;
  derivedClose: number | null;
  isForecast: boolean;
  ma40: number | null;
  maValues: Record<MaWindow, number | null>;
  calculation: ProjectionCalculationDetail;
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
  const predictedCloseDates = new Set<string>();
  const sortedPredictions = [...predictions].sort((a, b) =>
    a.targetDate.localeCompare(b.targetDate),
  );
  const orderedDates = mergeDates(
    points.map((point) => point.date),
    sortedPredictions.map((row) => row.targetDate),
  );

  const rows = sortedPredictions.map((row) => {
    const predictedMa = parseInput(getPredictedMaInput(row, inputWindow));
    const reverse = buildReverseCalculation(
      orderedDates,
      closeByDate,
      actualCloseByDate,
      predictedCloseDates,
      row.targetDate,
      predictedMa,
      inputWindow,
    );
    const derivedClose = reverse.derivedClose;
    const hasCompletedActual = actualCloseByDate.has(row.targetDate) && row.targetDate <= baseDate;
    const isForecast = !hasCompletedActual && row.targetDate > baseDate;

    if (isForecast && derivedClose !== null) {
      closeByDate.set(row.targetDate, derivedClose);
      predictedCloseDates.add(row.targetDate);
    } else if (!hasCompletedActual && !closeByDate.has(row.targetDate)) {
      closeByDate.set(row.targetDate, Number.NaN);
    }

    const movingAverages = Object.fromEntries(
      MA_WINDOWS.map((windowSize) => [
        windowSize,
        derivedClose === null
          ? buildEmptyMovingAverageCalculation(windowSize, '缺少反推收盘价，无法计算均线')
          : buildMovingAverageCalculation(
              orderedDates,
              closeByDate,
              actualCloseByDate,
              predictedCloseDates,
              row.targetDate,
              windowSize,
            ),
      ]),
    ) as Record<MaWindow, MovingAverageCalculationDetail>;

    const maValues = Object.fromEntries(
      MA_WINDOWS.map((windowSize) => [windowSize, movingAverages[windowSize].average]),
    ) as Record<MaWindow, number | null>;

    return {
      ...row,
      actualClose: actualCloseByDate.get(row.targetDate) ?? null,
      derivedClose,
      isForecast,
      ma40: maValues[40],
      maValues,
      calculation: {
        reverse,
        movingAverages,
      },
    };
  });

  const actualLines = Object.fromEntries(
    MA_WINDOWS.map((windowSize) => [
      windowSize,
      calculateMovingAverage(points, windowSize).filter(
        (row) => row.value !== null && row.targetDate <= baseDate,
      ),
    ]),
  ) as Record<MaWindow, LineValuePoint[]>;
  const predictedLines = Object.fromEntries(
    MA_WINDOWS.map((windowSize) => {
      const anchor = [...actualLines[windowSize]].reverse().find(
        (row) => row.targetDate <= baseDate,
      );

      return [
        windowSize,
        [
          ...(anchor ? [anchor] : []),
          ...rows.filter((row) => row.isForecast).map((row) => ({
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

function buildReverseCalculation(
  orderedDates: string[],
  closeByDate: Map<string, number>,
  actualCloseByDate: Map<string, number>,
  predictedCloseDates: Set<string>,
  targetDate: string,
  predictedMa: number | null,
  windowSize: MaWindow,
): ReverseCalculationDetail {
  const emptyDetail = (reason: string): ReverseCalculationDetail => ({
    inputWindow: windowSize,
    predictedMa,
    previousValues: [],
    previousSum: null,
    derivedClose: null,
    reason,
  });

  if (predictedMa === null) return emptyDetail(`请先填写预测MA${windowSize}`);

  const targetIndex = orderedDates.indexOf(targetDate);
  if (targetIndex < 0) return emptyDetail('目标周期不存在');

  const previousDates = orderedDates.slice(targetIndex - (windowSize - 1), targetIndex);
  if (previousDates.length !== windowSize - 1) {
    return emptyDetail(`需要前${windowSize - 1}个周期收盘价，目前数量不足`);
  }

  const previousValues = buildCalculationValues(
    previousDates,
    closeByDate,
    actualCloseByDate,
    predictedCloseDates,
  );
  if (previousValues === null) return emptyDetail(`前${windowSize - 1}个周期存在缺失收盘价`);

  const previousSum = sum(previousValues.map((item) => item.value));
  return {
    inputWindow: windowSize,
    predictedMa,
    previousValues,
    previousSum,
    derivedClose: predictedMa * windowSize - previousSum,
    reason: null,
  };
}

function buildMovingAverageCalculation(
  orderedDates: string[],
  closeByDate: Map<string, number>,
  actualCloseByDate: Map<string, number>,
  predictedCloseDates: Set<string>,
  targetDate: string,
  windowSize: MaWindow,
): MovingAverageCalculationDetail {
  const emptyDetail = (reason: string) => buildEmptyMovingAverageCalculation(windowSize, reason);
  const targetIndex = orderedDates.indexOf(targetDate);
  if (targetIndex < 0) return emptyDetail('目标周期不存在');

  const windowDates = orderedDates.slice(targetIndex - windowSize + 1, targetIndex + 1);
  if (windowDates.length !== windowSize) {
    return emptyDetail(`需要${windowSize}个周期收盘价，目前数量不足`);
  }

  const values = buildCalculationValues(
    windowDates,
    closeByDate,
    actualCloseByDate,
    predictedCloseDates,
  );
  if (values === null) return emptyDetail(`MA${windowSize}窗口存在缺失收盘价`);

  const total = sum(values.map((item) => item.value));
  return {
    windowSize,
    values,
    sum: total,
    average: total / windowSize,
    reason: null,
  };
}

function buildEmptyMovingAverageCalculation(
  windowSize: MaWindow,
  reason: string,
): MovingAverageCalculationDetail {
  return {
    windowSize,
    values: [],
    sum: null,
    average: null,
    reason,
  };
}

function buildCalculationValues(
  dates: string[],
  closeByDate: Map<string, number>,
  actualCloseByDate: Map<string, number>,
  predictedCloseDates: Set<string>,
): CalculationValueItem[] | null {
  const values = dates.map((date) => {
    const value = closeByDate.get(date) ?? Number.NaN;
    return {
      targetDate: date,
      value,
      source: (predictedCloseDates.has(date) || !actualCloseByDate.has(date)
        ? 'predicted'
        : 'actual') as CalculationValueItem['source'],
    };
  });

  return values.some((item) => !Number.isFinite(item.value)) ? null : values;
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
