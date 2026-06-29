import type { ComparisonRow, KLinePoint, PredictionPoint } from '../types';

export function comparePredictions(
  predictions: PredictionPoint[],
  points: KLinePoint[],
): ComparisonRow[] {
  const actualByDate = new Map(points.map((point) => [point.date, point.close]));

  return predictions.map((row) => {
    const predicted = Number(row.predictedClose);
    const actualClose = actualByDate.get(row.targetDate) ?? null;
    const hasPrediction = Number.isFinite(predicted) && row.predictedClose.trim() !== '';
    const diff = hasPrediction && actualClose !== null ? predicted - actualClose : null;

    return {
      ...row,
      actualClose,
      diff,
      diffPct: diff !== null && actualClose ? (Math.abs(diff) / actualClose) * 100 : null,
    };
  });
}

export function formatNumber(value: number | null, digits = 2) {
  if (value === null || !Number.isFinite(value)) return '--';
  return value.toFixed(digits);
}

export function summarizeComparisons(rows: ComparisonRow[]) {
  const valid = rows.filter((row) => row.diff !== null && row.actualClose !== null);
  if (!valid.length) {
    return {
      compared: 0,
      mae: null,
      mape: null,
      maxAbsError: null,
    };
  }

  const absDiffs = valid.map((row) => Math.abs(row.diff as number));
  const pctDiffs = valid.map((row) => row.diffPct as number);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

  return {
    compared: valid.length,
    mae: sum(absDiffs) / valid.length,
    mape: sum(pctDiffs) / valid.length,
    maxAbsError: Math.max(...absDiffs),
  };
}
