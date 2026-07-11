import type { LineValuePoint } from './movingAverage';

export function mergeLineValuePoints(...groups: LineValuePoint[][]) {
  return mergeLineValuePointsByPriority(groups, true);
}

export function mergeLineValuePointsPreservingEarlier(...groups: LineValuePoint[][]) {
  return mergeLineValuePointsByPriority(groups, false);
}

function mergeLineValuePointsByPriority(groups: LineValuePoint[][], replaceExisting: boolean) {
  const values = new Map<string, number | null>();
  groups.flat().forEach((row) => {
    if (row.value !== null && (replaceExisting || !values.has(row.targetDate))) {
      values.set(row.targetDate, row.value);
    }
  });
  return Array.from(values, ([targetDate, value]) => ({ targetDate, value })).sort((left, right) =>
    left.targetDate.localeCompare(right.targetDate),
  );
}
