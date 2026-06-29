import type { Horizon, KLinePoint, PeriodType, PredictionPoint } from '../types';

export interface WorkspaceCache {
  stockCode: string;
  period: PeriodType;
  horizon?: Horizon;
  baseDate: string;
  updatedAt: string;
}

const WORKSPACE_CACHE_KEY = 'prediction:last-workspace';

export function storageKey(
  stockCode: string,
  period: PeriodType,
  baseDate: string,
  horizon: Horizon,
) {
  return `prediction:${stockCode}:${period}:${baseDate}:${horizon}`;
}

export function predictionPlanKey(stockCode: string, period: PeriodType, baseDate: string) {
  return `prediction-plan:${stockCode}:${period}:${baseDate}:v3`;
}

export function loadPredictions(key: string): PredictionPoint[] | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as PredictionPoint[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function savePredictions(key: string, rows: PredictionPoint[]) {
  localStorage.setItem(key, JSON.stringify(rows));
}

export function loadPredictionRows(
  stockCode: string,
  period: PeriodType,
  baseDate: string,
  points: KLinePoint[],
  horizon: Horizon,
  legacyHorizons: Horizon[],
): PredictionPoint[] {
  const rows = generatePredictionRows(points, period, baseDate, horizon);
  const currentRows = loadPredictions(predictionPlanKey(stockCode, period, baseDate)) ?? [];
  const legacyRows = legacyHorizons.flatMap(
    (candidateHorizon) =>
      loadPredictions(storageKey(stockCode, period, baseDate, candidateHorizon)) ?? [],
  );

  return rows.map((row) => {
    let merged = { ...row };
    for (const candidate of legacyRows.filter((item) => item.targetDate === row.targetDate)) {
      merged = fillEmptyPredictionFields(merged, candidate);
    }

    const currentMatch = currentRows.find((item) => item.targetDate === row.targetDate);
    if (currentMatch) {
      merged = fillEmptyPredictionFields(merged, currentMatch);
    }

    return merged;
  });
}

function fillEmptyPredictionFields(base: PredictionPoint, candidate: PredictionPoint) {
  return {
    ...base,
    predictedClose:
      base.predictedClose.trim() === '' && candidate.predictedClose.trim() !== ''
        ? candidate.predictedClose
        : base.predictedClose,
    note: base.note.trim() === '' && candidate.note.trim() !== '' ? candidate.note : base.note,
  };
}

export function loadWorkspaceCache(): WorkspaceCache | null {
  const raw = localStorage.getItem(WORKSPACE_CACHE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as WorkspaceCache;
    if (
      typeof parsed.stockCode === 'string' &&
      ['day', 'week', 'month'].includes(parsed.period) &&
      typeof parsed.baseDate === 'string'
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

export function saveWorkspaceCache(cache: WorkspaceCache) {
  localStorage.setItem(WORKSPACE_CACHE_KEY, JSON.stringify(cache));
}

export function generatePredictionRows(
  points: KLinePoint[],
  period: PeriodType,
  baseDate: string,
  horizon: Horizon,
): PredictionPoint[] {
  const targetDates = getTargetDates(points, period, baseDate, horizon);
  return targetDates.map((targetDate) => ({
    targetDate,
    predictedClose: '',
    note: '',
  }));
}

function getTargetDates(
  points: KLinePoint[],
  period: PeriodType,
  baseDate: string,
  horizon: Horizon,
) {
  const dates = points.map((point) => point.date);
  const baseIndex = dates.indexOf(baseDate);
  const knownFuture = baseIndex >= 0 ? dates.slice(baseIndex, baseIndex + horizon) : [baseDate];

  if (knownFuture.length === horizon) {
    return knownFuture;
  }

  const seed = knownFuture.at(-1) ?? baseDate;
  const generated = generateFutureDates(period, seed, horizon - knownFuture.length);
  return [...knownFuture, ...generated];
}

function generateFutureDates(period: PeriodType, seed: string, count: number) {
  if (count <= 0) return [];

  const result: string[] = [];
  const date = parseDate(seed);

  while (result.length < count) {
    if (period === 'day') {
      date.setDate(date.getDate() + 1);
      const day = date.getDay();
      if (day !== 0 && day !== 6) result.push(formatDate(date));
    } else if (period === 'week') {
      date.setDate(date.getDate() + 7);
      result.push(formatDate(date));
    } else {
      date.setMonth(date.getMonth() + 1, 1);
      date.setMonth(date.getMonth() + 1, 0);
      result.push(formatDate(date));
    }
  }

  return result;
}

function parseDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
