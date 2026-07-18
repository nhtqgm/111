import type { KLinePoint, PeriodType, PredictionPoint, StockKLineResponse } from '../types';
import { generateFutureAStockDates } from './aShareTradingCalendar.ts';
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

export function savePredictionDraft(
  stockCode: string,
  period: PeriodType,
  baseDate: string,
  rows: PredictionPoint[],
) {
  savePredictions(predictionPlanKey(stockCode, period), rows);
  saveWorkspaceCache({
    stockCode,
    period,
    baseDate,
    updatedAt: new Date().toISOString(),
  });
}

export function loadPredictionRows(
  stockCode: string,
  period: PeriodType,
  baseDate: string,
  points: KLinePoint[],
  rowCount: number,
): PredictionPoint[] {
  const currentRows =
    loadPredictions(predictionPlanKey(stockCode, period, baseDate)) ??
    loadPredictions(legacyPredictionPlanKey(stockCode, period, baseDate)) ??
    [];

  return hydratePredictionRows(currentRows, points, period, baseDate, rowCount);
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

/**
 * Cloud storage deliberately omits blank values. Rebuild those blank input
 * rows locally, while keeping every date where the user has already entered a
 * prediction (including historical forecasts outside the current horizon).
 */
export function hydratePredictionRows(
  savedRows: PredictionPoint[],
  points: KLinePoint[],
  period: PeriodType,
  baseDate: string,
  rowCount: number,
): PredictionPoint[] {
  const generatedRows = generatePredictionRows(points, period, baseDate, rowCount);
  const savedByDate = new Map(savedRows.map((row) => [row.targetDate, normalizePredictionPoint(row)]));
  const horizonDates = new Set(generatedRows.map((row) => row.targetDate));

  const hydratedRows = generatedRows.map((row) => {
    const saved = savedByDate.get(row.targetDate);
    if (!saved) return row;

    return {
      ...row,
      predictedMaValues: mergePredictionValues(row.predictedMaValues, saved.predictedMaValues),
      predictedMa40: saved.predictedMa40.trim() || row.predictedMa40,
      note: saved.note.trim() || row.note,
    };
  });

  const historicalRows = [...savedByDate.values()].filter((row) => !horizonDates.has(row.targetDate));
  return [...historicalRows, ...hydratedRows].sort((left, right) => left.targetDate.localeCompare(right.targetDate));
}

/**
 * The cloud workspace keeps historical rows for chart/history views, but the
 * editable table should only show the current input horizon.
 */
export function selectPredictionRowsForInputTable<T extends { targetDate: string }>(
  rows: T[],
  horizonDates: ReadonlySet<string>,
) {
  return rows.filter((row) => horizonDates.has(row.targetDate));
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
  return generateFutureAStockDates(period, seed, count);
}
