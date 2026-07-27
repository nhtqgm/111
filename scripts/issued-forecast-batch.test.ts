import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import type { KLinePoint, PredictionPoint } from '../src/types.ts';
import {
  createIssuedForecastBatch,
  evaluateIssuedForecastBatch,
  selectActiveIssuedForecastBatch,
  sortIssuedForecastBatches,
} from '../src/utils/issuedForecastBatch.ts';
import type { MaWindow } from '../src/utils/movingAverage.ts';

const regressionFixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/688571-forecast-regression.json', import.meta.url), 'utf8'),
) as Record<'day' | 'week', Array<[string, number]>>;

function point(date: string, close: number): KLinePoint {
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

function prediction(
  targetDate: string,
  inputMa: string,
  inputWindow: MaWindow = 40,
  note = '',
): PredictionPoint {
  return {
    targetDate,
    predictedMa40: inputWindow === 40 ? inputMa : '',
    predictedMaValues: inputMa === '' ? {} : { [inputWindow]: inputMa },
    note,
  };
}

function dayPoints() {
  return regressionFixture.day.map(([date, close]) => point(date, close));
}

function createRegressionBatch(revision: string, issuedAt: string, stockCode = '688571') {
  return createIssuedForecastBatch({
    stockCode,
    period: 'day',
    inputMaWindow: 40,
    revision,
    asOfDate: '2026-07-09',
    issuedAt,
    // Deliberately includes July 10. Creation must ignore data newer than asOfDate.
    points: dayPoints(),
    predictions: [
      prediction('2026-07-10', '9.1500', 40, 'first issued row'),
      prediction('2026-07-13', '9.1300'),
      prediction('2026-07-14', ''),
    ],
  });
}

test('issuing freezes every calculable future row using only as-of data', () => {
  const batch = createRegressionBatch('r1', '2026-07-09T12:00:00.000Z');

  assert.equal(batch.rows.length, 2);
  assert.deepEqual(batch.rows.map((row) => row.horizon), [1, 2]);
  assert.deepEqual(batch.rows.map((row) => row.periodKey), ['2026-07-10', '2026-07-13']);
  assertClose(batch.rows[0].predictedClose, 9.17);
  assertClose(batch.rows[1].predictedClose, 8.52);
  assert.equal(batch.rows[0].inputMaValue, 9.15);
  assert.equal(batch.rows[0].predictedMaValues[40], 9.15);
  assert.equal(batch.rows[0].note, 'first issued row');
  assertClose(batch.rows[1].previousSumAtIssue, 356.68);
  assert.equal(batch.rows[1].basisValues.at(-1)?.source, 'predicted');
  assert.equal(Object.isFrozen(batch), true);
  assert.equal(Object.isFrozen(batch.rows), true);
  assert.equal(Object.isFrozen(batch.rows[0]), true);
  assert.equal(Object.isFrozen(batch.rows[0].basisValues), true);
  assert.equal(Object.isFrozen(batch.rows[0].predictedMaValues), true);
});

test('a new actual changes effective MA and conditional close without changing issued close', () => {
  const batch = createRegressionBatch('r1', '2026-07-09T12:00:00.000Z');
  const batchBeforeEvaluation = JSON.stringify(batch);
  const evaluation = evaluateIssuedForecastBatch(batch, {
    points: dayPoints(),
    evaluationAsOfDate: '2026-07-10',
  });
  const july10 = evaluation.rows.find((row) => row.targetDate === '2026-07-10');
  const july13 = evaluation.rows.find((row) => row.targetDate === '2026-07-13');

  assert.ok(july10);
  assert.ok(july13);
  assertClose(july10.predictedClose, 9.17);
  assertClose(july10.currentImpliedMa, 9.15);
  assert.equal(july10.settlement?.actualDate, '2026-07-10');
  assert.equal(july10.settlement?.actualClose, 9.26);
  assertClose(july10.settlement?.closeDiff, -0.09);

  assertClose(july13.predictedClose, 8.52);
  assertClose(july13.currentImpliedMa, 9.13225);
  assertClose(july13.conditionalClose, 8.43);
  assertClose(july13.conditionalPreviousSum, 356.77);
  assert.equal(july13.settlement, null);
  assert.deepEqual(
    july13.currentWindowValues.slice(-2).map((value) => [value.targetDate, value.value, value.source]),
    [
      ['2026-07-10', 9.26, 'actual'],
      ['2026-07-13', july13.predictedClose, 'issued'],
    ],
  );

  assert.equal(JSON.stringify(batch), batchBeforeEvaluation);
  assert.equal(Object.isFrozen(evaluation.rows), true);
  assert.equal(Object.isFrozen(july13), true);
  assert.equal(Object.isFrozen(july13.currentWindowValues), true);
});

test('weekly settlement matches the period key while keeping the issued target date', () => {
  const weekly = regressionFixture.week.map(([date, close]) => point(date, close));
  const batch = createIssuedForecastBatch({
    stockCode: '688571',
    period: 'week',
    inputMaWindow: 40,
    revision: 'week-r1',
    asOfDate: '2026-07-03',
    issuedAt: '2026-07-03T08:00:00.000Z',
    points: weekly,
    predictions: [prediction('2026-07-10', '8.1700')],
  });
  const evaluation = evaluateIssuedForecastBatch(batch, {
    points: [...weekly, point('2026-07-09', 9.26)],
    evaluationAsOfDate: '2026-07-10',
  });

  assert.equal(batch.rows[0].targetDate, '2026-07-10');
  assert.equal(batch.rows[0].periodKey, '2026-07-06');
  assertClose(batch.rows[0].predictedClose, 9.2);
  assert.equal(evaluation.rows[0].settlement?.actualDate, '2026-07-09');
  assert.equal(evaluation.rows[0].settlement?.actualClose, 9.26);
  assertClose(evaluation.rows[0].currentImpliedMa, 8.17);
});

test('active batch selection is isolated by stock, period, and input window', () => {
  const older = createRegressionBatch('r1', '2026-07-09T08:00:00.000Z');
  const newer = createRegressionBatch('r2', '2026-07-09T12:00:00.000Z');
  const otherStock = createRegressionBatch('r1', '2026-07-09T10:00:00.000Z', '000166');
  const ma5 = createIssuedForecastBatch({
    stockCode: '688571',
    period: 'day',
    inputMaWindow: 5,
    revision: 'ma5-r1',
    asOfDate: '2026-07-09',
    issuedAt: '2026-07-09T11:00:00.000Z',
    points: dayPoints(),
    predictions: [prediction('2026-07-10', '9.5000', 5)],
  });
  const batches = [newer, ma5, otherStock, older];

  assert.equal(
    selectActiveIssuedForecastBatch(batches, {
      stockCode: '688571',
      period: 'day',
      inputMaWindow: 40,
    })?.id,
    newer.id,
  );
  assert.equal(
    selectActiveIssuedForecastBatch(batches, {
      stockCode: '688571',
      period: 'day',
      inputMaWindow: 20,
    }),
    null,
  );
  assert.deepEqual(
    sortIssuedForecastBatches(batches).map((batch) => batch.id),
    [otherStock.id, ma5.id, older.id, newer.id],
  );
  assert.deepEqual(batches.map((batch) => batch.id), [newer.id, ma5.id, otherStock.id, older.id]);
});

test('issuing fails atomically when no future row can be calculated', () => {
  assert.throws(
    () => createIssuedForecastBatch({
      stockCode: '688571',
      period: 'day',
      inputMaWindow: 40,
      revision: 'empty',
      asOfDate: '2026-07-09',
      issuedAt: '2026-07-09T12:00:00.000Z',
      points: dayPoints(),
      predictions: [prediction('2026-07-10', '')],
    }),
    /No valid future forecast rows/,
  );
});

test('issued timestamp uses the same strict UTC contract as the cloud RPC', () => {
  assert.throws(
    () => createRegressionBatch('r1', '2026-07-09'),
    /Invalid issued forecast issuedAt/,
  );
});

function assertClose(actual: number | null | undefined, expected: number) {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs(actual - expected) <= 1e-9, `expected ${expected}, got ${actual}`);
}
