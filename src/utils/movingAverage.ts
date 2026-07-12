import type { KLinePoint, PeriodType, PredictionPoint } from '../types';

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
  period?: PeriodType,
): Ma40Projection {
  const toPeriodKey = createPeriodKeyResolver(period);
  const basePeriodKey = toPeriodKey(baseDate);
  const actualPointByPeriod = buildActualPointMap(points, toPeriodKey);
  const actualCloseByPeriod = new Map(
    [...actualPointByPeriod].map(([periodKey, point]) => [periodKey, point.close]),
  );
  const closeByPeriod = new Map(actualCloseByPeriod);
  const predictedClosePeriods = new Set<string>();
  const displayDateByPeriod = new Map(
    [...actualPointByPeriod].map(([periodKey, point]) => [periodKey, point.date]),
  );
  const sortedPredictions = [...predictions].sort((a, b) =>
    toPeriodKey(a.targetDate).localeCompare(toPeriodKey(b.targetDate)) ||
    a.targetDate.localeCompare(b.targetDate),
  );
  const orderedPeriods = mergeDates(
    [...actualPointByPeriod.keys()],
    sortedPredictions
      .map((row) => toPeriodKey(row.targetDate))
      .filter((periodKey) => periodKey > basePeriodKey || actualPointByPeriod.has(periodKey)),
  );

  const rows = sortedPredictions.map((row) => {
    const targetPeriodKey = toPeriodKey(row.targetDate);
    const rowOrderedPeriods = orderedPeriods.includes(targetPeriodKey)
      ? orderedPeriods
      : insertSortedPeriod(orderedPeriods, targetPeriodKey);
    const predictedMa = parseInput(getPredictedMaInput(row, inputWindow));
    const reverse = buildReverseCalculation(
      rowOrderedPeriods,
      closeByPeriod,
      actualCloseByPeriod,
      predictedClosePeriods,
      displayDateByPeriod,
      targetPeriodKey,
      predictedMa,
      inputWindow,
    );
    const derivedClose = reverse.derivedClose;
    const actualPoint = actualPointByPeriod.get(targetPeriodKey);
    const hasCompletedActual = Boolean(actualPoint && actualPoint.date <= baseDate);
    const isForecast = !hasCompletedActual && targetPeriodKey > basePeriodKey;

    if (isForecast && derivedClose !== null) {
      closeByPeriod.set(targetPeriodKey, derivedClose);
      predictedClosePeriods.add(targetPeriodKey);
      displayDateByPeriod.set(targetPeriodKey, row.targetDate);
    }

    // Preserve the user's forecast calculation for this row without replacing
    // a completed real close in the rolling source used by later periods.
    const calculationCloseByPeriod = new Map(closeByPeriod);
    const calculationPredictedPeriods = new Set(predictedClosePeriods);
    const calculationDisplayDates = new Map(displayDateByPeriod);
    if (derivedClose !== null) {
      calculationCloseByPeriod.set(targetPeriodKey, derivedClose);
      calculationPredictedPeriods.add(targetPeriodKey);
      calculationDisplayDates.set(targetPeriodKey, row.targetDate);
    }

    const movingAverages = Object.fromEntries(
      MA_WINDOWS.map((windowSize) => [
        windowSize,
        derivedClose === null
          ? buildEmptyMovingAverageCalculation(windowSize, '缺少反推收盘价，无法计算均线')
          : buildMovingAverageCalculation(
              rowOrderedPeriods,
              calculationCloseByPeriod,
              actualCloseByPeriod,
              calculationPredictedPeriods,
              calculationDisplayDates,
              targetPeriodKey,
              windowSize,
            ),
      ]),
    ) as Record<MaWindow, MovingAverageCalculationDetail>;

    const maValues = Object.fromEntries(
      MA_WINDOWS.map((windowSize) => [windowSize, movingAverages[windowSize].average]),
    ) as Record<MaWindow, number | null>;

    return {
      ...row,
      actualClose: actualPoint?.close ?? null,
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

  const closeByDate = new Map(points.map((point) => [point.date, point.close]));
  for (const periodKey of predictedClosePeriods) {
    const targetDate = displayDateByPeriod.get(periodKey);
    const close = closeByPeriod.get(periodKey);
    if (targetDate && close !== undefined) closeByDate.set(targetDate, close);
  }

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
  displayDateByPeriod: Map<string, string>,
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
    displayDateByPeriod,
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
  displayDateByPeriod: Map<string, string>,
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
    displayDateByPeriod,
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
  displayDateByPeriod: Map<string, string>,
): CalculationValueItem[] | null {
  const values = dates.map((date) => {
    const value = closeByDate.get(date) ?? Number.NaN;
    return {
      targetDate: displayDateByPeriod.get(date) ?? date,
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

function insertSortedPeriod(periods: string[], targetPeriod: string) {
  return Array.from(new Set([...periods, targetPeriod])).sort();
}

function buildActualPointMap(points: KLinePoint[], toPeriodKey: (date: string) => string) {
  const actualPointByPeriod = new Map<string, KLinePoint>();
  for (const point of points) {
    const periodKey = toPeriodKey(point.date);
    const existing = actualPointByPeriod.get(periodKey);
    if (!existing || point.date >= existing.date) actualPointByPeriod.set(periodKey, point);
  }
  return actualPointByPeriod;
}

function createPeriodKeyResolver(period?: PeriodType) {
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

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]) {
  return sum(values) / values.length;
}
