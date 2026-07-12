import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import type { KLinePoint, PredictionPoint } from '../src/types.ts';
import { buildForecastHistoryRows, createForecastHistorySnapshotsForAllInputs } from '../src/utils/forecastHistory.ts';
import { mergeLineValuePoints } from '../src/utils/linePoints.ts';
import { buildMa40Projection } from '../src/utils/movingAverage.ts';

const regressionFixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/688571-forecast-regression.json', import.meta.url), 'utf8'),
) as Record<'day' | 'week', Array<[string, number]>>;

function point(date: string, close = 10): KLinePoint {
  return {
    date,
    open: close,
    close,
    high: close,
    low: close,
    volume: 1,
    amount: 1,
    amplitude: 0,
    pctChange: 0,
    change: 0,
    turnover: 0,
  };
}

function prediction(targetDate: string, ma40: string): PredictionPoint {
  return {
    targetDate,
    predictedMa40: ma40,
    predictedMaValues: { 40: ma40 },
    note: '',
  };
}

function weeklyPoints(endDate: string, count = 40) {
  const end = new Date(`${endDate}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - (count - index - 1) * 7);
    return point(date.toISOString().slice(0, 10));
  });
}

function monthlyPoints(endDate: string, count = 40) {
  const end = new Date(`${endDate.slice(0, 7)}-01T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end);
    date.setUTCMonth(date.getUTCMonth() - (count - index - 1));
    const targetDate = index === count - 1
      ? endDate
      : `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-28`;
    return point(targetDate);
  });
}

function confirmed688571Points(period: 'day' | 'week') {
  return regressionFixture[period].map(([date, close]) => point(date, close));
}

test('week projection treats different dates in the same completed week as one K-line period', () => {
  const points = weeklyPoints('2026-07-10');
  const projection = buildMa40Projection(
    points,
    [prediction('2026-07-09', '10.0000'), prediction('2026-07-16', '10.0000')],
    '2026-07-10',
    40,
    'week',
  );

  assert.equal(projection.rows[0].actualClose, 10);
  assert.equal(projection.rows[0].isForecast, false);
  assert.equal(projection.rows[1].derivedClose, 10);
  assert.ok(projection.rows[1].calculation.reverse.previousValues.some((item) => item.targetDate === '2026-07-10'));
  assert.ok(!projection.rows[1].calculation.reverse.previousValues.some((item) => item.targetDate === '2026-07-09'));
});

test('month projection does not count the real trading-day close and calendar month-end twice', () => {
  const points = monthlyPoints('2026-06-29');
  const projection = buildMa40Projection(
    points,
    [prediction('2026-06-30', '10.0000'), prediction('2026-07-31', '10.0000')],
    '2026-06-29',
    40,
    'month',
  );

  assert.equal(projection.rows[0].actualClose, 10);
  assert.equal(projection.rows[0].isForecast, false);
  assert.equal(projection.rows[1].derivedClose, 10);
  assert.ok(projection.rows[1].calculation.reverse.previousValues.some((item) => item.targetDate === '2026-06-29'));
  assert.ok(!projection.rows[1].calculation.reverse.previousValues.some((item) => item.targetDate === '2026-06-30'));
});

test('completed forecast snapshot keeps user MA values while real close remains authoritative for later periods', () => {
  const points = weeklyPoints('2026-07-10');
  const rows = [prediction('2026-07-10', '9.0000'), prediction('2026-07-17', '10.0000')];
  const projection = buildMa40Projection(points, rows, '2026-07-10', 40, 'week');
  const snapshots = createForecastHistorySnapshotsForAllInputs(
    '688571',
    'week',
    points,
    rows,
    '2026-07-10',
    '2026-07-11T00:00:00.000Z',
  );
  const completed = snapshots.find((snapshot) => snapshot.targetDate === '2026-07-10');

  assert.equal(completed?.predictedClose, -30);
  assert.equal(completed?.predictedMaValues[40], 9);
  assert.equal(projection.closeByDate.get('2026-07-10'), 10);
  assert.equal(projection.rows[1].derivedClose, 10);
});

test('confirmed day MA40 9.1500 keeps its July 10 forecast marker after July 13 actual data arrives', () => {
  const throughJuly10 = confirmed688571Points('day');
  const beforeJuly10 = throughJuly10.filter((item: KLinePoint) => item.date < '2026-07-10');
  const rows = [prediction('2026-07-10', '9.1500')];
  const original = createForecastHistorySnapshotsForAllInputs(
    '688571',
    'day',
    beforeJuly10,
    rows,
    '2026-07-09',
    '2026-07-09T12:00:00.000Z',
  );
  const july10Snapshot = original.find((snapshot) => snapshot.targetDate === '2026-07-10');
  const reviewRows = buildForecastHistoryRows(
    original,
    [...throughJuly10, point('2026-07-13', 9.31)],
  );
  const july10Review = reviewRows.find((row) => row.targetDate === '2026-07-10');
  const chartForecastPoints = mergeLineValuePoints(
    reviewRows.map((row) => ({
      targetDate: row.actualDate ?? row.targetDate,
      value: row.predictedClose,
    })),
    [],
  );

  assert.equal(july10Snapshot?.inputMaValue, 9.15);
  assert.equal(Number(july10Snapshot?.predictedClose.toFixed(2)), 9.17);
  assert.equal(july10Snapshot?.predictedMaValues[40], 9.15);
  assert.equal(Number(july10Review?.predictedClose.toFixed(2)), 9.17);
  assert.equal(july10Review?.actualClose, 9.26);
  assert.equal(july10Review?.actualDate, '2026-07-10');
  assert.deepEqual(chartForecastPoints.find((row) => row.targetDate === '2026-07-10'), {
    targetDate: '2026-07-10',
    value: july10Snapshot?.predictedClose,
  });
});

test('the same target date keeps independent day and week MA inputs and reverse-calculated closes', () => {
  const buildSnapshot = (period: 'day' | 'week', inputMa: string) => {
    const points = confirmed688571Points(period).filter((item) => item.date < '2026-07-10');
    return createForecastHistorySnapshotsForAllInputs(
      '688571',
      period,
      points,
      [prediction('2026-07-10', inputMa)],
      points.at(-1).date,
      '2026-07-09T12:00:00.000Z',
    ).find((snapshot) => snapshot.targetDate === '2026-07-10' && snapshot.inputMaWindow === 40);
  };

  const daySnapshot = buildSnapshot('day', '9.1500');
  const weekSnapshot = buildSnapshot('week', '8.1700');

  assert.equal(daySnapshot?.inputMaValue, 9.15);
  assert.equal(Number(daySnapshot?.predictedClose.toFixed(2)), 9.17);
  assert.equal(weekSnapshot?.inputMaValue, 8.17);
  assert.equal(Number(weekSnapshot?.predictedClose.toFixed(2)), 9.2);
});

test('stale market data cannot resolve to a newly selected K-line period', async () => {
  const workspaceModule = await import('../src/utils/cloudWorkspace.ts');
  assert.equal(typeof workspaceModule.resolveActiveWorkspaceScope, 'function');

  assert.equal(
    workspaceModule.resolveActiveWorkspaceScope({
      dataStockCode: '688571',
      dataPeriod: 'week',
      selectedStockCode: '688571',
      selectedPeriod: 'day',
    }),
    null,
  );
  assert.equal(
    workspaceModule.resolveActiveWorkspaceScope({
      dataStockCode: '688571',
      dataPeriod: 'day',
      selectedStockCode: '688571',
      selectedPeriod: 'day',
      predictionStockCode: '688571',
      predictionPeriod: 'week',
    }),
    null,
  );
  assert.deepEqual(
    workspaceModule.resolveActiveWorkspaceScope({
      dataStockCode: '688571',
      dataPeriod: 'day',
      selectedStockCode: '688571',
      selectedPeriod: 'day',
    }),
    { stockCode: '688571', period: 'day' },
  );
});

test('review summary uses completed historical forecasts instead of future rows without actual closes', async () => {
  const metricsModule = await import('../src/utils/metrics.ts');
  assert.equal(typeof metricsModule.summarizeForecastHistory, 'function');
  const summary = metricsModule.summarizeForecastHistory([
    { predictedClose: 9.17, actualClose: 9.26 },
    { predictedClose: 9.2, actualClose: 9.26 },
  ]);

  assert.equal(summary.compared, 2);
  assert.equal(Number(summary.mae?.toFixed(3)), 0.075);
  assert.ok((summary.mape ?? 0) > 0);
});
