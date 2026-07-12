import type { PeriodType } from '../types';
import { queueElectronStorageSync, type StorageLike } from './electronStorage.ts';

export interface ChartZoomRange {
  start: number;
  end: number;
}

export interface ChartViewport {
  startDate: string;
  endDate: string;
}

export const chartViewportStorageKey = 'prediction-ma40:chart-viewport:v1';

export function getStableChartZoomRange(
  previousAxisSignature: string,
  axisSignature: string,
  currentRange: ChartZoomRange,
  defaultRange: ChartZoomRange,
): ChartZoomRange {
  return previousAxisSignature === axisSignature ? currentRange : defaultRange;
}

export function loadChartViewport(
  stockCode: string,
  period: PeriodType,
  storage: StorageLike = localStorage,
): ChartViewport | null {
  try {
    const raw = storage.getItem(chartViewportStorageKey);
    if (!raw) return null;

    const stored = JSON.parse(raw) as Record<string, unknown>;
    const candidate = stored[viewportScopeKey(stockCode, period)];
    return isChartViewport(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function saveChartViewport(
  stockCode: string,
  period: PeriodType,
  viewport: ChartViewport,
  storage: StorageLike = localStorage,
) {
  if (!isChartViewport(viewport)) return;

  let stored: Record<string, unknown> = {};
  try {
    const raw = storage.getItem(chartViewportStorageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        stored = parsed as Record<string, unknown>;
      }
    }
  } catch {
    stored = {};
  }

  stored[viewportScopeKey(stockCode, period)] = viewport;
  storage.setItem(chartViewportStorageKey, JSON.stringify(stored));
  if (typeof window !== 'undefined') {
    void queueElectronStorageSync(storage);
  }
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

function viewportScopeKey(stockCode: string, period: PeriodType) {
  return `${stockCode.replace(/\D/g, '').slice(0, 6)}:${period}`;
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
