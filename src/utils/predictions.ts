import type { KLinePoint, PeriodType, PredictionPoint } from '../types';

export interface WorkspaceCache {
  stockCode: string;
  period: PeriodType;
  baseDate: string;
  updatedAt: string;
}

const WORKSPACE_CACHE_KEY = 'prediction-ma40:last-workspace';

export function predictionPlanKey(stockCode: string, period: PeriodType, baseDate: string) {
  return `prediction-ma40:${stockCode}:${period}:${baseDate}:v1`;
}

export function loadPredictions(key: string): PredictionPoint[] | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as PredictionPoint[];
    return Array.isArray(parsed) ? parsed.map(normalizePredictionPoint) : null;
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
  rowCount: number,
): PredictionPoint[] {
  const rows = generatePredictionRows(points, period, baseDate, rowCount);
  const currentRows = loadPredictions(predictionPlanKey(stockCode, period, baseDate)) ?? [];

  return rows.map((row) => {
    const currentMatch = currentRows.find((item) => item.targetDate === row.targetDate);
    if (!currentMatch) return row;

    const normalized = normalizePredictionPoint(currentMatch);
    return {
      ...row,
      predictedMa40:
        row.predictedMa40.trim() === '' && normalized.predictedMa40.trim() !== ''
          ? normalized.predictedMa40
          : row.predictedMa40,
      note: row.note.trim() === '' && normalized.note.trim() !== '' ? normalized.note : row.note,
    };
  });
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
  rowCount: number,
): PredictionPoint[] {
  const targetDates = getTargetDates(points, period, baseDate, rowCount);
  return targetDates.map((targetDate) => ({
    targetDate,
    predictedMa40: '',
    note: '',
  }));
}

export function normalizePredictionPoint(value: any): PredictionPoint {
  return {
    targetDate: String(value?.targetDate ?? ''),
    predictedMa40: String(value?.predictedMa40 ?? ''),
    note: String(value?.note ?? ''),
  };
}

function getTargetDates(
  points: KLinePoint[],
  period: PeriodType,
  baseDate: string,
  rowCount: number,
) {
  const dates = points.map((point) => point.date);
  const baseIndex = dates.indexOf(baseDate);
  const knownFuture = baseIndex >= 0 ? dates.slice(baseIndex, baseIndex + rowCount) : [baseDate];

  if (knownFuture.length === rowCount) {
    return knownFuture;
  }

  const seed = knownFuture.at(-1) ?? baseDate;
  const generated = generateFutureDates(period, seed, rowCount - knownFuture.length);
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
