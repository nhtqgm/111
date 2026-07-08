import { type KeyboardEvent, useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { KLinePoint, PeriodType } from '../types';
import type { LineValuePoint } from '../utils/movingAverage';

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

interface KLineChartProps {
  points: KLinePoint[];
  lineSeries: ChartLineSeries[];
  baseDate: string;
  period: PeriodType;
  showCloseLine?: boolean;
}

const periodName: Record<PeriodType, string> = {
  day: '日K',
  week: '周K',
  month: '月K',
};

export default function KLineChart({
  points,
  lineSeries,
  baseDate,
  period,
  showCloseLine = true,
}: KLineChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.EChartsType | null>(null);
  const zoomRangeRef = useRef({ start: 45, end: 100 });

  useEffect(() => {
    if (!containerRef.current || !points.length) return;

    const chart = echarts.init(containerRef.current, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    zoomRangeRef.current = { start: 45, end: 100 };
    const visiblePoints = points.slice(-180);
    const lineDates = lineSeries.flatMap((series) =>
      series.rows.filter((row) => row.value !== null).map((row) => row.targetDate),
    );
    const xAxis = mergeDates([...visiblePoints.map((point) => point.date), baseDate], lineDates);
    const pointByDate = new Map(points.map((point) => [point.date, point]));
    const lineMaps = lineSeries.map((series) => ({
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
      grid: [
        { left: 54, right: 28, top: 32, height: '61%' },
        { left: 54, right: 28, top: '75%', height: '14%' },
      ],
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        backgroundColor: 'rgba(22, 29, 36, 0.92)',
        borderWidth: 0,
        textStyle: { color: '#f9f6ef' },
      },
      legend: {
        top: 4,
        left: 12,
        itemWidth: 14,
        itemHeight: 8,
        textStyle: { color: '#3d453f' },
        data: [
          '真实K线',
          ...(showCloseLine ? ['真实收盘'] : []),
          ...lineSeries.map((series) => series.label),
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
        {
          type: 'category',
          gridIndex: 1,
          data: xAxis,
          axisLine: { lineStyle: { color: '#b6b0a4' } },
          axisLabel: { show: false },
        },
      ],
      yAxis: [
        {
          scale: true,
          splitLine: { lineStyle: { color: '#dfd8ca' } },
          axisLabel: { color: '#6f6a60', formatter: (value: number) => value.toFixed(2) },
        },
        {
          scale: true,
          gridIndex: 1,
          splitLine: { show: false },
          axisLabel: {
            color: '#6f6a60',
            formatter: (value: number) => `${Math.round(value / 10000)}万`,
          },
        },
      ],
      dataZoom: [
        { id: 'keyboard-inside-zoom', type: 'inside', xAxisIndex: [0, 1], start: 45, end: 100 },
        {
          id: 'keyboard-slider-zoom',
          type: 'slider',
          xAxisIndex: [0, 1],
          bottom: 8,
          height: 18,
          start: 45,
          end: 100,
        },
      ],
      series: [
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
          markLine: baseDate
            ? {
                symbol: ['none', 'none'],
                label: { formatter: '预测起点', color: '#5f5444' },
                lineStyle: { color: '#8c6a3d', type: 'solid', width: 1 },
                data: [{ xAxis: baseDate }],
              }
            : undefined,
        },
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
        {
          name: '成交量',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: xAxis.map((date) => pointByDate.get(date)?.volume ?? 0),
          itemStyle: { color: '#9e9587' },
        },
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
  }, [baseDate, lineSeries, period, points, showCloseLine]);

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
  const requestedSpan = end - start;
  const nextSpan = Math.max(5, Math.min(100, requestedSpan));
  const center = (start + end) / 2;
  let nextStart = center - nextSpan / 2;
  let nextEnd = center + nextSpan / 2;

  if (nextStart < 0) {
    nextStart = 0;
    nextEnd = nextSpan;
  }

  if (nextEnd > 100) {
    nextEnd = 100;
    nextStart = 100 - nextSpan;
  }

  return {
    start: Number(nextStart.toFixed(2)),
    end: Number(nextEnd.toFixed(2)),
  };
}

function mergeDates(actualDates: string[], predictedDates: string[]) {
  return Array.from(new Set([...actualDates, ...predictedDates])).sort();
}

function roundPrice(value: number) {
  return Number(value.toFixed(2));
}
