import type { KLinePoint, PeriodType, PredictionPoint, StockKLineResponse } from '../types';
import { queueElectronStorageSync } from './electronStorage.ts';

export interface WorkspaceCache {
  stockCode: string;
  period: PeriodType;
  baseDate: string;
  updatedAt: string;
}

const WORKSPACE_CACHE_KEY = 'prediction-ma40:last-workspace';
const KLINE_CACHE_PREFIX = 'prediction-ma40:kline-cache';

export function predictionPlanKey(stockCode: string, period: PeriodType, _baseDate?: string) {
  return `prediction-ma:${stockCode}:${period}:v2`;
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
  void queueElectronStorageSync();
}

export function loadPredictionRows(
  stockCode: string,
  period: PeriodType,
  baseDate: string,
  points: KLinePoint[],
  rowCount: number,
): PredictionPoint[] {
  const rows = generatePredictionRows(points, period, baseDate, rowCount);
  const currentRows =
    loadPredictions(predictionPlanKey(stockCode, period, baseDate)) ??
    loadPredictions(legacyPredictionPlanKey(stockCode, period, baseDate)) ??
    [];

  return rows.map((row) => {
    const currentMatch = currentRows.find((item) => item.targetDate === row.targetDate);
    if (!currentMatch) return row;

    const normalized = normalizePredictionPoint(currentMatch);
    return {
      ...row,
      predictedMaValues: mergePredictionValues(row.predictedMaValues, normalized.predictedMaValues),
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
  void queueElectronStorageSync();
}

export interface KLineDataCache {
  stockCode: string;
  period: PeriodType;
  updatedAt: string;
  data: StockKLineResponse;
}

export function loadKLineCache(rawStockCode: string, period: PeriodType): KLineDataCache | null {
  const raw = localStorage.getItem(kLineCacheKey(rawStockCode, period));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as KLineDataCache;
    if (
      typeof parsed.stockCode === 'string' &&
      parsed.period === period &&
      typeof parsed.updatedAt === 'string' &&
      isStockKLineResponse(parsed.data)
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

export function saveKLineCache(data: StockKLineResponse, period: PeriodType) {
  const cache: KLineDataCache = {
    stockCode: data.code,
    period,
    updatedAt: new Date().toISOString(),
    data,
  };

  localStorage.setItem(kLineCacheKey(data.code, period), JSON.stringify(cache));
  void queueElectronStorageSync();
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
    predictedMaValues: {},
    note: '',
  }));
}

export function normalizePredictionPoint(value: any): PredictionPoint {
  const predictedMa40 = String(value?.predictedMa40 ?? value?.predictedMaValues?.['40'] ?? '');
  const predictedMaValues = normalizePredictionValues(value?.predictedMaValues);
  if (predictedMa40.trim() !== '' && !predictedMaValues['40']) {
    predictedMaValues['40'] = predictedMa40;
  }

  return {
    targetDate: String(value?.targetDate ?? ''),
    predictedMa40,
    predictedMaValues,
    note: String(value?.note ?? ''),
  };
}

function normalizePredictionValues(value: any) {
  if (!value || typeof value !== 'object') return {};

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => ['5', '10', '20', '40', '60'].includes(key))
      .map(([key, input]) => [key, String(input ?? '')]),
  );
}

function mergePredictionValues(
  baseValues: Record<string, string>,
  savedValues: Record<string, string>,
) {
  return {
    ...baseValues,
    ...Object.fromEntries(
      Object.entries(savedValues).filter(([, value]) => value.trim() !== ''),
    ),
  };
}

function legacyPredictionPlanKey(stockCode: string, period: PeriodType, baseDate: string) {
  return `prediction-ma40:${stockCode}:${period}:${baseDate}:v1`;
}

function kLineCacheKey(rawStockCode: string, period: PeriodType) {
  const stockCode = rawStockCode.replace(/\D/g, '').slice(0, 6);
  return `${KLINE_CACHE_PREFIX}:${stockCode}:${period}:v1`;
}

function isStockKLineResponse(value: any): value is StockKLineResponse {
  return (
    value &&
    typeof value.code === 'string' &&
    typeof value.name === 'string' &&
    typeof value.market === 'number' &&
    Array.isArray(value.points) &&
    value.points.every(isKLinePoint)
  );
}

function isKLinePoint(value: any): value is KLinePoint {
  return (
    value &&
    typeof value.date === 'string' &&
    typeof value.open === 'number' &&
    typeof value.close === 'number' &&
    typeof value.high === 'number' &&
    typeof value.low === 'number' &&
    typeof value.volume === 'number'
  );
}

function getTargetDates(
  points: KLinePoint[],
  period: PeriodType,
  baseDate: string,
  rowCount: number,
) {
  const dates = points.map((point) => point.date);
  const baseIndex = dates.indexOf(baseDate);
  const knownFuture =
    baseIndex >= 0 ? dates.slice(baseIndex + 1, baseIndex + 1 + rowCount) : [];

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
