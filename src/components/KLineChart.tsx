import { type KeyboardEvent, useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { KLinePoint, PeriodType } from '../types';
import type { LineValuePoint } from '../utils/movingAverage';
import { getForecastCenteredZoomRange } from '../utils/chartViewport';

export interface ChartLineSeries {
  label: string;
  color: string;
  rows: LineValuePoint[];
  lineWidth: number;
  lineType: 'solid' | 'dashed' | 'dotted';
  symbol: string;
  symbolSize: number;
  symbolOffset: [number, number];
  opacity?: number;
  showSymbol?: boolean;
  z: number;
}

export interface ChartPointSeries {
  label: string;
  color: string;
  borderColor?: string;
  rows: LineValuePoint[];
  symbol: string;
  symbolSize: number;
  z: number;
}

interface KLineChartProps {
  points: KLinePoint[];
  lineSeries: ChartLineSeries[];
  pointSeries?: ChartPointSeries[];
  forecastDates?: string[];
  baseDate: string;
  period: PeriodType;
  showActualKLine?: boolean;
  showCloseLine?: boolean;
  showVolume?: boolean;
}

const periodName: Record<PeriodType, string> = {
  day: '日K',
  week: '周K',
  month: '月K',
};

export default function KLineChart({
  points,
  lineSeries,
  pointSeries = [],
  forecastDates = [],
  baseDate,
  period,
  showActualKLine = true,
  showCloseLine = true,
  showVolume = true,
}: KLineChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.EChartsType | null>(null);
  const zoomRangeRef = useRef({ start: 0, end: 100 });

  useEffect(() => {
    if (!containerRef.current || !points.length) return;

    const chart = echarts.init(containerRef.current, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    const visiblePoints = points.slice(-180);
    const lineDates = lineSeries.flatMap((series) =>
      series.rows.filter((row) => row.value !== null).map((row) => row.targetDate),
    );
    const pointDates = pointSeries.flatMap((series) =>
      series.rows.filter((row) => row.value !== null).map((row) => row.targetDate),
    );
    const xAxis = mergeDates(
      [...visiblePoints.map((point) => point.date), baseDate],
      [...lineDates, ...pointDates, ...forecastDates],
    );
    const initialZoomRange = getForecastCenteredZoomRange(xAxis, baseDate);
    zoomRangeRef.current = initialZoomRange;
    const pointByDate = new Map(points.map((point) => [point.date, point]));
    const lineMaps = lineSeries.map((series) => ({
      ...series,
      values: new Map(
        series.rows
          .filter((row) => row.value !== null)
          .map((row) => [row.targetDate, row.value as number]),
      ),
    }));
    const pointMaps = pointSeries.map((series) => ({
      ...series,
      values: new Map(
        series.rows
          .filter((row) => row.value !== null)
          .map((row) => [row.targetDate, row.value as number]),
      ),
    }));

    chart.setOption({
      backgroundColor: '#f7f4ee',
      animationDuration: 420,
      grid: showVolume
        ? [
            { left: 54, right: 28, top: 66, height: '56%' },
            { left: 54, right: 28, top: '77%', height: '12%' },
          ]
        : [{ left: 54, right: 28, top: 66, bottom: 48 }],
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        backgroundColor: 'rgba(22, 29, 36, 0.92)',
        borderWidth: 0,
        textStyle: { color: '#f9f6ef' },
      },
      legend: {
        type: 'scroll',
        top: 6,
        left: 12,
        right: 68,
        height: 42,
        itemWidth: 14,
        itemHeight: 8,
        pageButtonGap: 6,
        pageButtonItemGap: 4,
        pageIconColor: '#5f5444',
        pageIconInactiveColor: '#c8beae',
        pageTextStyle: { color: '#5f5444' },
        textStyle: { color: '#3d453f' },
        data: [
          ...(showActualKLine ? ['真实K线'] : []),
          ...(showCloseLine ? ['真实收盘'] : []),
          ...lineSeries.map((series) => series.label),
          ...pointSeries.map((series) => series.label),
        ],
      },
      xAxis: [
        {
          type: 'category',
          data: xAxis,
          boundaryGap: true,
          axisLine: { lineStyle: { color: '#b6b0a4' } },
          axisLabel: { color: '#6f6a60', hideOverlap: true },
        },
        ...(showVolume
          ? [
              {
                type: 'category',
                gridIndex: 1,
                data: xAxis,
                axisLine: { lineStyle: { color: '#b6b0a4' } },
                axisLabel: { show: false },
              },
            ]
          : []),
      ],
      yAxis: [
        {
          scale: true,
          splitLine: { lineStyle: { color: '#dfd8ca' } },
          axisLabel: { color: '#6f6a60', formatter: (value: number) => value.toFixed(2) },
        },
        ...(showVolume
          ? [
              {
                scale: true,
                gridIndex: 1,
                splitLine: { show: false },
                axisLabel: {
                  color: '#6f6a60',
                  formatter: (value: number) => `${Math.round(value / 10000)}万`,
                },
              },
            ]
          : []),
      ],
      dataZoom: [
        {
          id: 'keyboard-inside-zoom',
          type: 'inside',
          xAxisIndex: showVolume ? [0, 1] : [0],
          ...initialZoomRange,
        },
        {
          id: 'keyboard-slider-zoom',
          type: 'slider',
          xAxisIndex: showVolume ? [0, 1] : [0],
          bottom: 8,
          height: 18,
          ...initialZoomRange,
        },
      ],
      series: [
        ...(showActualKLine
          ? [
              {
                name: '真实K线',
                type: 'candlestick',
                data: xAxis.map((date) => {
                  const point = pointByDate.get(date);
                  return point
                    ? [
                        roundPrice(point.open),
                        roundPrice(point.close),
                        roundPrice(point.low),
                        roundPrice(point.high),
                      ]
                    : ['-', '-', '-', '-'];
                }),
                itemStyle: {
                  color: '#b43d31',
                  color0: '#1f8b74',
                  borderColor: '#b43d31',
                  borderColor0: '#1f8b74',
                },
                markLine: createBaseDateMarkLine(baseDate),
              },
            ]
          : []),
        ...(showCloseLine
          ? [
              {
                name: '真实收盘',
                type: 'line',
                data: xAxis.map((date) => {
                  const close = pointByDate.get(date)?.close;
                  return close === undefined ? null : roundPrice(close);
                }),
                showSymbol: false,
                smooth: false,
                lineStyle: { color: '#212529', width: 1.8 },
              },
            ]
          : []),
        ...lineMaps.map((series) => ({
          name: series.label,
          type: 'line',
          data: xAxis.map((date) => {
            const value = series.values.get(date);
            return value === undefined ? null : roundPrice(value);
          }),
          connectNulls: false,
          showSymbol: series.showSymbol ?? true,
          symbol: series.symbol,
          symbolOffset: series.symbolOffset,
          symbolSize: series.symbolSize,
          z: series.z,
          lineStyle: {
            color: series.color,
            width: series.lineWidth,
            type: series.lineType,
            opacity: series.opacity ?? 0.92,
          },
          itemStyle: {
            color: series.color,
            borderColor: series.color,
            borderWidth: 2,
          },
        })),
        ...pointMaps.map((series) => ({
          name: series.label,
          type: 'scatter',
          data: xAxis.map((date) => {
            const value = series.values.get(date);
            return value === undefined ? null : roundPrice(value);
          }),
          symbol: series.symbol,
          symbolSize: series.symbolSize,
          z: series.z,
          itemStyle: {
            color: series.color,
            borderColor: series.borderColor ?? '#20251f',
            borderWidth: 2,
            shadowBlur: 8,
            shadowColor: 'rgba(255, 230, 0, 0.55)',
          },
          emphasis: {
            scale: 1.25,
            itemStyle: {
              shadowBlur: 12,
              shadowColor: 'rgba(255, 230, 0, 0.75)',
            },
          },
        })),
        ...(showVolume
          ? [
              {
                name: '成交量',
                type: 'bar',
                xAxisIndex: 1,
                yAxisIndex: 1,
                data: xAxis.map((date) => pointByDate.get(date)?.volume ?? 0),
                itemStyle: { color: '#9e9587' },
              },
            ]
          : []),
      ],
      graphic: {
        type: 'text',
        right: 26,
        top: 8,
        style: {
          text: periodName[period],
          fill: '#89724f',
          fontSize: 12,
          fontWeight: 700,
        },
      },
    });

    const resize = () => chart.resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      chart.dispose();
      if (chartRef.current === chart) {
        chartRef.current = null;
      }
    };
  }, [
    baseDate,
    forecastDates,
    lineSeries,
    period,
    pointSeries,
    points,
    showActualKLine,
    showCloseLine,
    showVolume,
  ]);

  function applyKeyboardZoom(start: number, end: number) {
    const normalized = normalizeZoomRange(start, end);
    zoomRangeRef.current = normalized;
    chartRef.current?.dispatchAction({
      type: 'dataZoom',
      batch: [
        { dataZoomId: 'keyboard-inside-zoom', ...normalized },
        { dataZoomId: 'keyboard-slider-zoom', ...normalized },
      ],
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;

    event.preventDefault();
    const { start, end } = zoomRangeRef.current;
    const span = end - start;
    const center = (start + end) / 2;

    if (event.key === 'ArrowUp') {
      const nextSpan = Math.max(5, span * 0.82);
      applyKeyboardZoom(center - nextSpan / 2, center + nextSpan / 2);
      return;
    }

    if (event.key === 'ArrowDown') {
      const nextSpan = Math.min(100, span * 1.22);
      applyKeyboardZoom(center - nextSpan / 2, center + nextSpan / 2);
      return;
    }

    const step = Math.max(2, span * 0.16);
    applyKeyboardZoom(
      event.key === 'ArrowLeft' ? start - step : start + step,
      event.key === 'ArrowLeft' ? end - step : end + step,
    );
  }

  return (
    <div
      aria-label="K线图区域，点击后可用上下箭头放大缩小，左右箭头左右移动"
      className="chart-surface"
      onKeyDown={handleKeyDown}
      onMouseDown={() => containerRef.current?.focus()}
      ref={containerRef}
      tabIndex={0}
    />
  );
}

function normalizeZoomRange(start: number, end: number) {
  let nextStart = Math.max(0, Math.min(100, start));
  let nextEnd = Math.max(0, Math.min(100, end));
  const span = nextEnd - nextStart;

  if (span < 5) {
    const center = (nextStart + nextEnd) / 2;
    nextStart = center - 2.5;
    nextEnd = center + 2.5;
  }

  if (nextStart < 0) {
    nextEnd -= nextStart;
    nextStart = 0;
  }

  if (nextEnd > 100) {
    nextStart -= nextEnd - 100;
    nextEnd = 100;
  }

  return {
    start: Math.max(0, Number(nextStart.toFixed(2))),
    end: Math.min(100, Number(nextEnd.toFixed(2))),
  };
}

function createBaseDateMarkLine(baseDate: string) {
  if (!baseDate) return undefined;

  return {
    symbol: ['none', 'none'],
    label: { formatter: '预测起点', color: '#5f5444' },
    lineStyle: { color: '#8c6a3d', type: 'solid', width: 1 },
    data: [{ xAxis: baseDate }],
  };
}

function mergeDates(actualDates: string[], predictedDates: string[]) {
  return Array.from(new Set([...actualDates, ...predictedDates])).sort();
}

function roundPrice(value: number) {
  return Number(value.toFixed(2));
}
