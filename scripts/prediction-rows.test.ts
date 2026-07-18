import assert from 'node:assert/strict';
import test from 'node:test';

import type { KLinePoint, PeriodType } from '../src/types.ts';
import {
  generatePredictionRows,
  hydratePredictionRows,
  selectPredictionRowsForInputTable,
} from '../src/utils/predictions.ts';

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

test('day prediction rows skip official A-share exchange holidays', () => {
  assert.deepEqual(
    generatePredictionRows([point('2026-02-13')], 'day', '2026-02-13', 2).map(
      (row) => row.targetDate,
    ),
    ['2026-02-24', '2026-02-25'],
  );

  assert.deepEqual(
    generatePredictionRows([point('2026-09-30')], 'day', '2026-09-30', 2).map(
      (row) => row.targetDate,
    ),
    ['2026-10-08', '2026-10-09'],
  );
});

test('week prediction rows use each trading week final session and skip fully closed weeks', () => {
  assert.deepEqual(
    generatePredictionRows([point('2026-02-13')], 'week', '2026-02-13', 2).map(
      (row) => row.targetDate,
    ),
    ['2026-02-27', '2026-03-06'],
  );

  assert.deepEqual(
    generatePredictionRows([point('2026-09-18')], 'week', '2026-09-18', 2).map(
      (row) => row.targetDate,
    ),
    ['2026-09-24', '2026-09-30'],
  );
});

test('month prediction rows use the final A-share trading day of each month', () => {
  assert.deepEqual(
    generatePredictionRows([point('2026-04-30')], 'month', '2026-04-30', 2).map(
      (row) => row.targetDate,
    ),
    ['2026-05-29', '2026-06-30'],
  );
});

test('existing predictions stay bound to their dates when a new trading day is added', () => {
  const savedRows = [
    {
      targetDate: '2026-07-10',
      predictedMa40: '9.1500',
      predictedMaValues: { 40: '9.1500' },
      note: 'original forecast',
    },
    {
      targetDate: '2026-07-13',
      predictedMa40: '9.1300',
      predictedMaValues: { 40: '9.1300' },
      note: '',
    },
  ];

  const rows = hydratePredictionRows(
    savedRows,
    [point('2026-07-10'), point('2026-07-13')],
    'day',
    '2026-07-13',
    3,
  );

  assert.equal(rows.find((row) => row.targetDate === '2026-07-10')?.predictedMa40, '9.1500');
  assert.equal(rows.find((row) => row.targetDate === '2026-07-13')?.predictedMa40, '9.1300');
  assert.deepEqual(
    rows.filter((row) => row.targetDate > '2026-07-13').map((row) => row.targetDate),
    ['2026-07-14', '2026-07-15', '2026-07-16'],
  );
});

test('the right input table hides historical rows while retaining them in the workspace', () => {
  const rows = [
    { targetDate: '2026-07-10', predictedMa40: '9.1500' },
    { targetDate: '2026-07-20', predictedMa40: '9.0600' },
    { targetDate: '2026-07-21', predictedMa40: '' },
  ];

  const tableRows = selectPredictionRowsForInputTable(
    rows,
    new Set(['2026-07-20', '2026-07-21']),
  );

  assert.deepEqual(tableRows.map((row) => row.targetDate), ['2026-07-20', '2026-07-21']);
  assert.equal(rows.find((row) => row.targetDate === '2026-07-10')?.predictedMa40, '9.1500');
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
