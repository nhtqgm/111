import assert from 'node:assert/strict';
import test from 'node:test';

import type { KLinePoint, PeriodType, StockKLineResponse } from '../src/types.ts';
import {
  filterCompletedKLineData,
  isCompletedKLineDate,
} from '../src/utils/completedPeriods.ts';

test('day K-line completion keeps the existing 15:10 close boundary', () => {
  assert.equal(isCompletedKLineDate('2026-07-27', 'day', chinaTime('2026-07-27 15:09')), false);
  assert.equal(isCompletedKLineDate('2026-07-27', 'day', chinaTime('2026-07-27 15:10')), true);
  assert.equal(isCompletedKLineDate('2026-07-26', 'day', chinaTime('2026-07-27 09:00')), true);
  assert.equal(isCompletedKLineDate('2026-07-28', 'day', chinaTime('2026-07-27 16:00')), false);
});

test('week K-line closes on the final A-share session before the Dragon Boat holiday', () => {
  const date = '2026-06-18';

  assert.equal(isCompletedKLineDate(date, 'week', chinaTime('2026-06-18 15:09')), false);
  assert.equal(isCompletedKLineDate(date, 'week', chinaTime('2026-06-18 15:10')), true);
  assert.equal(isCompletedKLineDate(date, 'week', chinaTime('2026-06-19 09:00')), true);
});

test('month K-line closes on the final A-share session before the Spring Festival holiday', () => {
  const date = '2025-01-27';

  assert.equal(isCompletedKLineDate(date, 'month', chinaTime('2025-01-27 15:09')), false);
  assert.equal(isCompletedKLineDate(date, 'month', chinaTime('2025-01-27 15:10')), true);
  assert.equal(isCompletedKLineDate(date, 'month', chinaTime('2025-01-28 09:00')), true);
});

test('ordinary week remains incomplete during the week and closes at Friday 15:10', () => {
  assert.equal(
    isCompletedKLineDate('2026-07-27', 'week', chinaTime('2026-07-27 15:10')),
    false,
  );
  assert.equal(
    isCompletedKLineDate('2026-07-31', 'week', chinaTime('2026-07-31 15:09')),
    false,
  );
  assert.equal(
    isCompletedKLineDate('2026-07-31', 'week', chinaTime('2026-07-31 15:10')),
    true,
  );
});

test('ordinary month remains incomplete before its final session close', () => {
  assert.equal(
    isCompletedKLineDate('2026-07-27', 'month', chinaTime('2026-07-27 15:10')),
    false,
  );
  assert.equal(
    isCompletedKLineDate('2026-07-31', 'month', chinaTime('2026-07-31 15:09')),
    false,
  );
  assert.equal(
    isCompletedKLineDate('2026-07-31', 'month', chinaTime('2026-07-31 15:10')),
    true,
  );
});

test('filter keeps incomplete weekly and monthly points out of downstream calculation data', () => {
  const weekly = filterCompletedKLineData(
    response('week', ['2026-06-12', '2026-06-18']),
    'week',
    chinaTime('2026-06-18 15:09'),
  );
  assert.deepEqual(weekly.data.points.map(({ date }) => date), ['2026-06-12']);
  assert.deepEqual(weekly.removedPoints.map(({ date }) => date), ['2026-06-18']);
  assert.equal(weekly.lastCompletedDate, '2026-06-12');

  const monthly = filterCompletedKLineData(
    response('month', ['2024-12-31', '2025-01-27']),
    'month',
    chinaTime('2025-01-27 15:09'),
  );
  assert.deepEqual(monthly.data.points.map(({ date }) => date), ['2024-12-31']);
  assert.deepEqual(monthly.removedPoints.map(({ date }) => date), ['2025-01-27']);
  assert.equal(monthly.lastCompletedDate, '2024-12-31');
});

function response(period: PeriodType, dates: string[]): StockKLineResponse {
  return {
    code: '000166',
    name: `test-${period}`,
    market: 0,
    points: dates.map(point),
  };
}

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

function chinaTime(value: string) {
  return new Date(`${value}:00+08:00`);
}
