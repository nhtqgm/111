export interface ChartZoomRange {
  start: number;
  end: number;
}

export function getStableChartZoomRange(
  previousAxisSignature: string,
  axisSignature: string,
  currentRange: ChartZoomRange,
  defaultRange: ChartZoomRange,
): ChartZoomRange {
  return previousAxisSignature === axisSignature ? currentRange : defaultRange;
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
