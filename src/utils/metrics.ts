import type { ComparisonRow } from '../types';
import type { Ma40ProjectionRow } from './movingAverage';

export function compareProjectionRows(rows: Ma40ProjectionRow[]): ComparisonRow[] {
  return rows.map((row) => {
    const diff =
      row.derivedClose !== null && row.actualClose !== null ? row.derivedClose - row.actualClose : null;

    return {
      ...row,
      diff,
      diffPct: diff !== null && row.actualClose ? (Math.abs(diff) / row.actualClose) * 100 : null,
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
