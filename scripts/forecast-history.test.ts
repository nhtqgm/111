import assert from 'node:assert/strict';
import test from 'node:test';

async function loadHistoryModule() {
  return await import('../src/utils/forecastHistory.ts');
}

function createRow(targetDate: string, input = 4.8) {
  return {
    targetDate,
    predictedMa40: String(input),
    predictedMaValues: { 40: String(input) },
    note: 'test',
    actualClose: null,
    derivedClose: 4.6,
    ma40: input,
    maValues: { 5: 4.5, 10: 4.6, 20: 4.7, 40: input, 60: 4.9 },
    calculation: {
      reverse: { inputWindow: 40, predictedMa: input, previousValues: [], previousSum: 0, derivedClose: 4.6, reason: null },
      movingAverages: {},
    },
  } as any;
}

test('history snapshots retain the predicted close and every MA value', async () => {
  const { createForecastHistorySnapshots } = await loadHistoryModule();
  const snapshots = createForecastHistorySnapshots('000166', 'day', 40, [createRow('2026-07-10')], '2026-07-09T10:00:00.000Z');

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].predictedClose, 4.6);
  assert.equal(snapshots[0].predictedMaValues[5], 4.5);
  assert.equal(snapshots[0].predictedMaValues[60], 4.9);
});

test('history rows pair a past prediction with the real close and real MA', async () => {
  const { buildForecastHistoryRows, createForecastHistorySnapshots } = await loadHistoryModule();
  const snapshots = createForecastHistorySnapshots('000166', 'day', 40, [createRow('2026-07-10')]);
  const points = Array.from({ length: 60 }, (_, index) => ({
    date: `2026-05-${String(index + 1).padStart(2, '0')}`,
    open: 4,
    close: 4,
    high: 4,
    low: 4,
    volume: 1,
    amount: 1,
    amplitude: 0,
    pctChange: 0,
    change: 0,
    turnover: 0,
  }));
  points[59] = { ...points[59], date: '2026-07-10', close: 4.56 };

  const rows = buildForecastHistoryRows(snapshots, points);
  assert.equal(rows[0].actualClose, 4.56);
  assert.ok(Math.abs((rows[0].closeDiff ?? 0) - 0.04) < 1e-9);
  assert.notEqual(rows[0].actualMaValues[40], null);
});

test('week and month history use the real K-line date in the same period', async () => {
  const { buildForecastHistoryRows, createForecastHistorySnapshots } = await loadHistoryModule();
  const week = createForecastHistorySnapshots('000166', 'week', 40, [createRow('2026-07-10')]);
  const month = createForecastHistorySnapshots('000166', 'month', 40, [createRow('2026-07-31')]);
  const points = [
    { date: '2026-07-09', open: 4, close: 4.5, high: 4.5, low: 4, volume: 1, amount: 1, amplitude: 0, pctChange: 0, change: 0, turnover: 0 },
    { date: '2026-07-30', open: 4, close: 4.7, high: 4.7, low: 4, volume: 1, amount: 1, amplitude: 0, pctChange: 0, change: 0, turnover: 0 },
  ];

  assert.equal(buildForecastHistoryRows(week, points)[0].actualDate, '2026-07-09');
  assert.equal(buildForecastHistoryRows(month, points)[0].actualDate, '2026-07-30');
});

test('backup recovery rebuilds a historical prediction from the backup K-line cache', async () => {
  const { recoverForecastHistoryFromBackupStorage } = await loadHistoryModule();
  const points = Array.from({ length: 60 }, (_, index) => ({
    date: `2026-05-${String(index + 1).padStart(2, '0')}`,
    open: 10,
    close: 10,
    high: 10,
    low: 10,
    volume: 1,
    amount: 1,
    amplitude: 0,
    pctChange: 0,
    change: 0,
    turnover: 0,
  }));
  points[59] = { ...points[59], date: '2026-07-09' };
  const storage = {
    'prediction-ma40:kline-cache:688571:day:v1': JSON.stringify({
      stockCode: '688571',
      period: 'day',
      updatedAt: '2026-07-09T12:00:00.000Z',
      data: { code: '688571', name: 'test', market: 1, sourceName: 'test', points },
    }),
    'prediction-ma:688571:day:v2': JSON.stringify([
      {
        targetDate: '2026-07-10',
        predictedMa40: '9.0000',
        predictedMaValues: { 40: '9.0000' },
        note: 'original forecast',
      },
    ]),
  };

  const recovered = recoverForecastHistoryFromBackupStorage(storage, '2026-07-11T00:00:00.000Z');
  const snapshots = JSON.parse(recovered.storage['prediction-ma:forecast-history:688571:day:v1']);

  assert.equal(recovered.recoveredCount, 1);
  assert.equal(snapshots[0].targetDate, '2026-07-10');
  assert.equal(snapshots[0].inputMaValue, 9);
  assert.equal(snapshots[0].predictedClose, -30);
  assert.equal(snapshots[0].predictedMaValues[40], 9);
});

test('only prediction rows after the saved K-line date are eligible for history capture', async () => {
  const { getPendingForecastRows } = await loadHistoryModule();
  const rows = [
    createRow('2026-07-09'),
    createRow('2026-07-10'),
    createRow('2026-07-11'),
  ];

  assert.deepEqual(
    getPendingForecastRows(rows, '2026-07-10').map((row: { targetDate: string }) => row.targetDate),
    ['2026-07-11'],
  );
});
