import assert from 'node:assert/strict';
import test from 'node:test';

import type { KLinePoint, PeriodType } from '../src/types.ts';
import { generatePredictionRows, hydratePredictionRows } from '../src/utils/predictions.ts';

test('cloud-backed prediction rows retain the selected MA horizon for day, week, and month', () => {
  const cases: Array<{ period: PeriodType; baseDate: string; count: number }> = [
    { period: 'day', baseDate: '2026-01-02', count: 5 },
    { period: 'week', baseDate: '2026-01-02', count: 10 },
    { period: 'month', baseDate: '2026-01-31', count: 60 },
  ];

  for (const { period, baseDate, count } of cases) {
    const points = [point(baseDate)];
    const expectedDates = generatePredictionRows(points, period, baseDate, count).map((row) => row.targetDate);
    const rows = hydratePredictionRows([], points, period, baseDate, count);

    assert.deepEqual(rows.map((row) => row.targetDate), expectedDates, period);
    assert.ok(rows.every((row) => row.predictedMa40 === '' && Object.keys(row.predictedMaValues).length === 0), period);
  }
});

test('cloud prediction values survive horizon hydration while blank input rows are restored', () => {
  const points = [point('2026-01-02')];
  const rows = hydratePredictionRows(
    [
      {
        targetDate: '2026-01-05',
        predictedMa40: '',
        predictedMaValues: { 60: '4.8300' },
        note: 'user forecast',
      },
      {
        targetDate: '2025-12-31',
        predictedMa40: '4.7100',
        predictedMaValues: { 40: '4.7100' },
        note: 'historical forecast',
      },
    ],
    points,
    'day',
    '2026-01-02',
    60,
  );

  assert.equal(rows.length, 61);
  assert.deepEqual(rows.find((row) => row.targetDate === '2026-01-05')?.predictedMaValues, { 60: '4.8300' });
  assert.equal(rows.find((row) => row.targetDate === '2025-12-31')?.note, 'historical forecast');
  assert.equal(rows.filter((row) => row.targetDate > '2026-01-02').length, 60);
});

function point(date: string): KLinePoint {
  return {
    date,
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
  };
}
