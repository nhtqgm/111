import type { Horizon, KLinePoint, PredictionPoint } from '../types';

export interface LineValuePoint {
  targetDate: string;
  value: number | null;
}

export interface ProjectedAverageRow extends PredictionPoint {
  actualClose: number | null;
  ma: Record<Horizon, number | null>;
}

export function calculateActualMovingAverage(
  points: KLinePoint[],
  horizon: Horizon,
): LineValuePoint[] {
  return points.map((point, index) => {
    const window = points.slice(index - horizon + 1, index + 1);
    return {
      targetDate: point.date,
      value: window.length === horizon ? average(window.map((item) => item.close)) : null,
    };
  });
}

export function calculateProjectedMovingAverages(
  points: KLinePoint[],
  predictions: PredictionPoint[],
  horizons: Horizon[],
): Record<Horizon, LineValuePoint[]> {
  const valueByDate = buildProjectedCloseMap(points, predictions);
  const orderedDates = Array.from(valueByDate.keys()).sort();

  return Object.fromEntries(
    horizons.map((horizon) => [
      horizon,
      predictions.map((row) => ({
        targetDate: row.targetDate,
        value: calculateProjectedAverageAtDate(orderedDates, valueByDate, row.targetDate, horizon),
      })),
    ]),
  ) as Record<Horizon, LineValuePoint[]>;
}

export function buildProjectedAverageRows(
  points: KLinePoint[],
  predictions: PredictionPoint[],
  horizons: Horizon[],
): ProjectedAverageRow[] {
  const actualByDate = new Map(points.map((point) => [point.date, point.close]));
  const averageSeries = calculateProjectedMovingAverages(points, predictions, horizons);

  return predictions.map((row) => ({
    ...row,
    actualClose: actualByDate.get(row.targetDate) ?? null,
    ma: Object.fromEntries(
      horizons.map((horizon) => [
        horizon,
        averageSeries[horizon].find((item) => item.targetDate === row.targetDate)?.value ?? null,
      ]),
    ) as Record<Horizon, number | null>,
  }));
}

export function predictionCloseLine(predictions: PredictionPoint[]): LineValuePoint[] {
  return predictions.map((row) => {
    const predicted = Number(row.predictedClose);
    return {
      targetDate: row.targetDate,
      value: Number.isFinite(predicted) && row.predictedClose.trim() !== '' ? predicted : null,
    };
  });
}

function buildProjectedCloseMap(points: KLinePoint[], predictions: PredictionPoint[]) {
  const valueByDate = new Map(points.map((point) => [point.date, point.close]));

  for (const row of predictions) {
    const predicted = Number(row.predictedClose);
    if (Number.isFinite(predicted) && row.predictedClose.trim() !== '') {
      valueByDate.set(row.targetDate, predicted);
    } else if (!valueByDate.has(row.targetDate)) {
      valueByDate.set(row.targetDate, Number.NaN);
    }
  }

  return valueByDate;
}

function calculateProjectedAverageAtDate(
  orderedDates: string[],
  valueByDate: Map<string, number>,
  targetDate: string,
  horizon: Horizon,
) {
  const targetIndex = orderedDates.indexOf(targetDate);
  if (targetIndex < 0) return null;

  const windowDates = orderedDates.slice(targetIndex - horizon + 1, targetIndex + 1);
  if (windowDates.length !== horizon) return null;

  const values = windowDates.map((date) => valueByDate.get(date) ?? Number.NaN);
  if (values.some((value) => !Number.isFinite(value))) return null;

  return average(values);
}

function average(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
