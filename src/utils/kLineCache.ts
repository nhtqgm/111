import type { KLinePoint, PeriodType, StockKLineResponse } from '../types.ts';
import type { ElectronStorageApi, StorageLike } from './electronStorage.ts';

const KLINE_CACHE_SCHEMA = 'gupiao-kline-cache/v1';
const KLINE_SCOPE_SCHEMA = 'gupiao-kline-cache-scope/v1';
const KLINE_CACHE_PREFIX = 'prediction-ma40:kline-cache';
const KLINE_SCOPE_KEY = `${KLINE_CACHE_PREFIX}:last-scope:v1`;
const KLINE_ENTRY_KEY = /^prediction-ma40:kline-cache:(\d{6}):(day|week|month):v1$/;

export interface KLineDataCache {
  schema: typeof KLINE_CACHE_SCHEMA;
  stockCode: string;
  period: PeriodType;
  updatedAt: string;
  data: StockKLineResponse;
}

interface StoredKLineScope {
  schema: typeof KLINE_SCOPE_SCHEMA;
  stockCode: string;
  period: PeriodType;
  updatedAt: string;
}

export interface KLineScope {
  stockCode: string;
  period: PeriodType;
}

export function loadKLineCache(
  rawStockCode: string,
  period: PeriodType,
  storage: StorageLike = localStorage,
): KLineDataCache | null {
  const stockCode = normalizeStockCode(rawStockCode);
  if (stockCode.length !== 6) return null;

  const raw = storage.getItem(kLineCacheKey(stockCode, period));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isStoredKLineCache(parsed, stockCode, period) ? cloneKLineCache(parsed) : null;
  } catch {
    return null;
  }
}

export async function saveKLineCache(
  data: StockKLineResponse,
  period: PeriodType,
  storage: StorageLike = localStorage,
  api: ElectronStorageApi | undefined = defaultElectronStorageApi(),
) {
  const stockCode = normalizeStockCode(data.code);
  const cache: KLineDataCache = {
    schema: KLINE_CACHE_SCHEMA,
    stockCode,
    period,
    updatedAt: new Date().toISOString(),
    data: cloneKLineData(data),
  };
  if (!isStoredKLineCache(cache, stockCode, period)) {
    throw new Error('K-line cache data is invalid.');
  }

  const key = kLineCacheKey(stockCode, period);
  const value = JSON.stringify(cache);
  storage.setItem(key, value);
  if (!api) return;

  const canonical = await api.bootstrap({ [key]: value });
  restoreKLineCacheStorage(storage, canonical);
}

export function loadLastKLineScope(storage: StorageLike = localStorage): KLineScope | null {
  const raw = storage.getItem(KLINE_SCOPE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredKLineScope(parsed)) return null;
    return { stockCode: parsed.stockCode, period: parsed.period };
  } catch {
    return null;
  }
}

export async function saveLastKLineScope(
  rawStockCode: string,
  period: PeriodType,
  storage: StorageLike = localStorage,
  api: ElectronStorageApi | undefined = defaultElectronStorageApi(),
) {
  const stockCode = normalizeStockCode(rawStockCode);
  const scope: StoredKLineScope = {
    schema: KLINE_SCOPE_SCHEMA,
    stockCode,
    period,
    updatedAt: new Date().toISOString(),
  };
  if (!isStoredKLineScope(scope)) return;

  const value = JSON.stringify(scope);
  storage.setItem(KLINE_SCOPE_KEY, value);
  if (!api) return;

  const canonical = await api.bootstrap({ [KLINE_SCOPE_KEY]: value });
  restoreKLineCacheStorage(storage, canonical);
}

export async function bootstrapKLineCacheStorage(
  storage: StorageLike = localStorage,
  api: ElectronStorageApi | undefined = defaultElectronStorageApi(),
) {
  if (!api) return;

  const canonical = await api.bootstrap(collectKLineCacheStorage(storage));
  restoreKLineCacheStorage(storage, canonical);
}

function collectKLineCacheStorage(storage: StorageLike) {
  const snapshot: Record<string, string> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key) continue;
    const value = storage.getItem(key);
    if (value !== null && isValidSerializedEntry(key, value)) snapshot[key] = value;
  }
  return snapshot;
}

function restoreKLineCacheStorage(storage: StorageLike, snapshot: Record<string, string>) {
  const invalidKeys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && isKLineStorageKey(key)) {
      const value = storage.getItem(key);
      if (value === null || !isValidSerializedEntry(key, value)) invalidKeys.push(key);
    }
  }
  invalidKeys.forEach((key) => storage.removeItem(key));

  Object.entries(snapshot).forEach(([key, value]) => {
    if (isValidSerializedEntry(key, value)) storage.setItem(key, value);
  });
}

function isValidSerializedEntry(key: string, value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (key === KLINE_SCOPE_KEY) return isStoredKLineScope(parsed);

    const match = KLINE_ENTRY_KEY.exec(key);
    if (!match) return false;
    return isStoredKLineCache(parsed, match[1], match[2] as PeriodType);
  } catch {
    return false;
  }
}

function isKLineStorageKey(key: string) {
  return key === KLINE_SCOPE_KEY || KLINE_ENTRY_KEY.test(key);
}

function isStoredKLineScope(value: unknown): value is StoredKLineScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredKLineScope>;
  return (
    candidate.schema === KLINE_SCOPE_SCHEMA &&
    normalizeStockCode(candidate.stockCode ?? '').length === 6 &&
    candidate.stockCode === normalizeStockCode(candidate.stockCode ?? '') &&
    isPeriod(candidate.period) &&
    isTimestamp(candidate.updatedAt)
  );
}

function isStoredKLineCache(
  value: unknown,
  expectedStockCode: string,
  expectedPeriod: PeriodType,
): value is KLineDataCache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<KLineDataCache>;
  return (
    candidate.schema === KLINE_CACHE_SCHEMA &&
    candidate.stockCode === expectedStockCode &&
    candidate.period === expectedPeriod &&
    isTimestamp(candidate.updatedAt) &&
    isStockKLineResponse(candidate.data, expectedStockCode)
  );
}

function isStockKLineResponse(value: unknown, expectedStockCode: string): value is StockKLineResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<StockKLineResponse>;
  if (
    normalizeStockCode(candidate.code ?? '') !== expectedStockCode ||
    candidate.code !== expectedStockCode ||
    typeof candidate.name !== 'string' ||
    !candidate.name.trim() ||
    !Number.isFinite(candidate.market) ||
    !Array.isArray(candidate.points) ||
    !candidate.points.length ||
    (candidate.adjustment !== undefined && candidate.adjustment !== 'bfq') ||
    (candidate.sourceProvider !== undefined && !['tencent', 'eastmoney'].includes(candidate.sourceProvider))
  ) {
    return false;
  }

  let previousDate = '';
  for (const point of candidate.points) {
    if (!isKLinePoint(point) || (previousDate && point.date <= previousDate)) return false;
    previousDate = point.date;
  }
  return true;
}

function isKLinePoint(value: unknown): value is KLinePoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<KLinePoint>;
  const prices = [candidate.open, candidate.close, candidate.high, candidate.low];
  if (
    !isDate(candidate.date) ||
    prices.some((price) => !Number.isFinite(price) || Number(price) <= 0) ||
    !Number.isFinite(candidate.volume) ||
    Number(candidate.volume) < 0 ||
    !Number.isFinite(candidate.amount) ||
    !Number.isFinite(candidate.amplitude) ||
    !Number.isFinite(candidate.pctChange) ||
    !Number.isFinite(candidate.change) ||
    !Number.isFinite(candidate.turnover)
  ) {
    return false;
  }

  const open = Number(candidate.open);
  const close = Number(candidate.close);
  const high = Number(candidate.high);
  const low = Number(candidate.low);
  return high >= Math.max(open, close, low) && low <= Math.min(open, close, high);
}

function cloneKLineCache(cache: KLineDataCache): KLineDataCache {
  return {
    ...cache,
    data: cloneKLineData(cache.data),
  };
}

function cloneKLineData(data: StockKLineResponse): StockKLineResponse {
  return {
    ...data,
    points: data.points.map((point) => ({ ...point })),
  };
}

function kLineCacheKey(stockCode: string, period: PeriodType) {
  return `${KLINE_CACHE_PREFIX}:${stockCode}:${period}:v1`;
}

function normalizeStockCode(stockCode: string) {
  return stockCode.replace(/\D/g, '').slice(0, 6);
}

function isPeriod(value: unknown): value is PeriodType {
  return value === 'day' || value === 'week' || value === 'month';
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function defaultElectronStorageApi() {
  return typeof window === 'undefined' ? undefined : window.appStorageApi;
}

