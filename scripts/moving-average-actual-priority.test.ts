import assert from 'node:assert/strict';
import test from 'node:test';

import type { KLinePoint, PredictionPoint } from '../src/types.ts';
import { buildMa40Projection } from '../src/utils/movingAverage.ts';

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

test('completed K-line remains the source of truth after an old MA prediction exists', () => {
  const completedDates = Array.from(
    { length: 40 },
    (_, index) => `2026-01-${String(index + 1).padStart(2, '0')}`,
  );
  const completedDate = completedDates.at(-1)!;
  const futureDate = '2026-02-01';
  const projection = buildMa40Projection(
    completedDates.map((date) => point(date)),
    [prediction(completedDate, '9.0000'), prediction(futureDate, '10.0000')],
    completedDate,
    40,
  );

  const completedRow = projection.rows[0];
  const futureRow = projection.rows[1];

  assert.equal(completedRow.actualClose, 10);
  assert.equal(completedRow.derivedClose, -30);
  assert.equal(completedRow.isForecast, false);
  assert.equal(projection.closeByDate.get(completedDate), 10);
  assert.equal(futureRow.derivedClose, 10);
  assert.equal(futureRow.isForecast, true);
  assert.deepEqual(
    projection.predictedLines[40].map((row) => row.targetDate),
    [completedDate, futureDate],
  );
});
