import type { PeriodType } from '../types';
import type { ElectronStorageApi, StorageLike } from './electronStorage.ts';

export interface ChartZoomRange {
  start: number;
  end: number;
}

export interface ChartViewport {
  startDate: string;
  endDate: string;
}

interface StoredChartViewport extends ChartViewport {
  userAdjusted: true;
  updatedAt: string;
}

const chartViewportStoragePrefix = 'prediction-ma40:chart-viewport:';
export const legacyChartViewportStorageKey = `${chartViewportStoragePrefix}v1`;

export function chartViewportStorageKey(stockCode: string, period: PeriodType) {
  return `${chartViewportStoragePrefix}${normalizeStockCode(stockCode)}:${period}:v2`;
}

export function loadChartViewport(
  stockCode: string,
  period: PeriodType,
  storage: StorageLike = localStorage,
): ChartViewport | null {
  try {
    storage.removeItem(legacyChartViewportStorageKey);
    const raw = storage.getItem(chartViewportStorageKey(stockCode, period));
    if (!raw) return null;

    const candidate = JSON.parse(raw) as unknown;
    return isStoredChartViewport(candidate)
      ? { startDate: candidate.startDate, endDate: candidate.endDate }
      : null;
  } catch {
    return null;
  }
}

export function saveChartViewport(
  stockCode: string,
  period: PeriodType,
  viewport: ChartViewport,
  storage: StorageLike = localStorage,
  api: ElectronStorageApi | undefined = typeof window === 'undefined' ? undefined : window.appStorageApi,
) {
  if (!isChartViewport(viewport)) return;

  storage.removeItem(legacyChartViewportStorageKey);
  const key = chartViewportStorageKey(stockCode, period);
  const stored: StoredChartViewport = {
    ...viewport,
    userAdjusted: true,
    updatedAt: nextViewportUpdatedAt(storage.getItem(key)),
  };
  const value = JSON.stringify(stored);
  storage.setItem(key, value);
  if (api) {
    void api.bootstrap({ [key]: value }).catch((error: unknown) => {
      console.error('Chart viewport save failed:', error);
    });
  }
}

export async function bootstrapChartViewportStorage(
  storage: StorageLike = localStorage,
  api: ElectronStorageApi | undefined = typeof window === 'undefined' ? undefined : window.appStorageApi,
) {
  storage.removeItem(legacyChartViewportStorageKey);
  if (!api) return;

  const localViewports = collectChartViewportStorage(storage);
  const canonical = await api.bootstrap(localViewports);
  Object.entries(canonical).forEach(([key, value]) => {
    if (isChartViewportStorageKey(key) && isSerializedStoredChartViewport(value)) {
      storage.setItem(key, value);
    }
  });
}

export function getChartViewportFromZoomRange(
  xAxis: string[],
  range: ChartZoomRange,
): ChartViewport | null {
  if (!xAxis.length) return null;

  const startIndex = toAxisIndex(xAxis.length, range.start);
  const endIndex = toAxisIndex(xAxis.length, range.end);
  return {
    startDate: xAxis[Math.min(startIndex, endIndex)],
    endDate: xAxis[Math.max(startIndex, endIndex)],
  };
}

export function getPersistedChartZoomRange(
  xAxis: string[],
  viewport: ChartViewport | null,
  defaultRange: ChartZoomRange,
): ChartZoomRange {
  if (xAxis.length <= 1 || !viewport) return defaultRange;

  const startIndex = findStartIndex(xAxis, viewport.startDate);
  const endIndex = findEndIndex(xAxis, viewport.endDate);
  if (startIndex >= endIndex) return defaultRange;

  const denominator = xAxis.length - 1;
  return {
    start: Number(((startIndex / denominator) * 100).toFixed(2)),
    end: Number(((endIndex / denominator) * 100).toFixed(2)),
  };
}

export function getForecastCenteredZoomRange(xAxis: string[], baseDate: string): ChartZoomRange {
  const baseIndex = xAxis.indexOf(baseDate);
  const forecastCount = xAxis.length - baseIndex - 1;

  if (baseIndex <= 0 || forecastCount <= 0) {
    return { start: 0, end: 100 };
  }

  const halfWindow = Math.min(baseIndex, forecastCount);
  const firstIndex = baseIndex - halfWindow;
  const lastIndex = baseIndex + halfWindow;
  const denominator = xAxis.length - 1;

  return {
    start: Number(((firstIndex / denominator) * 100).toFixed(2)),
    end: Number(((lastIndex / denominator) * 100).toFixed(2)),
  };
}

function isChartViewport(value: unknown): value is ChartViewport {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Partial<ChartViewport>;
  return (
    typeof candidate.startDate === 'string' &&
    typeof candidate.endDate === 'string' &&
    candidate.startDate.length > 0 &&
    candidate.endDate.length > 0 &&
    candidate.startDate <= candidate.endDate
  );
}

function isStoredChartViewport(value: unknown): value is StoredChartViewport {
  if (!isChartViewport(value)) return false;

  const candidate = value as Partial<StoredChartViewport>;
  return (
    candidate.userAdjusted === true &&
    typeof candidate.updatedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.updatedAt))
  );
}

function collectChartViewportStorage(storage: StorageLike) {
  const viewports: Record<string, string> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !isChartViewportStorageKey(key)) continue;

    const value = storage.getItem(key);
    if (value !== null && isSerializedStoredChartViewport(value)) {
      viewports[key] = value;
    }
  }
  return viewports;
}

function isChartViewportStorageKey(key: string) {
  return /^prediction-ma40:chart-viewport:\d{6}:(day|week|month):v2$/.test(key);
}

function isSerializedStoredChartViewport(value: string) {
  try {
    return isStoredChartViewport(JSON.parse(value));
  } catch {
    return false;
  }
}

function nextViewportUpdatedAt(previousValue: string | null) {
  let previousTimestamp = 0;
  if (previousValue) {
    try {
      const previous = JSON.parse(previousValue) as Partial<StoredChartViewport>;
      const parsed = typeof previous.updatedAt === 'string' ? Date.parse(previous.updatedAt) : Number.NaN;
      if (Number.isFinite(parsed)) previousTimestamp = parsed;
    } catch {
      previousTimestamp = 0;
    }
  }

  return new Date(Math.max(Date.now(), previousTimestamp + 1)).toISOString();
}

function normalizeStockCode(stockCode: string) {
  return stockCode.replace(/\D/g, '').slice(0, 6);
}

function toAxisIndex(axisLength: number, percentage: number) {
  const normalized = Math.max(0, Math.min(100, Number.isFinite(percentage) ? percentage : 0));
  return Math.round((normalized / 100) * (axisLength - 1));
}

function findStartIndex(xAxis: string[], date: string) {
  const exactIndex = xAxis.indexOf(date);
  if (exactIndex >= 0) return exactIndex;

  const nextIndex = xAxis.findIndex((item) => item >= date);
  return nextIndex >= 0 ? nextIndex : xAxis.length - 1;
}

function findEndIndex(xAxis: string[], date: string) {
  const exactIndex = xAxis.indexOf(date);
  if (exactIndex >= 0) return exactIndex;

  for (let index = xAxis.length - 1; index >= 0; index -= 1) {
    if (xAxis[index] <= date) return index;
  }

  return 0;
}
