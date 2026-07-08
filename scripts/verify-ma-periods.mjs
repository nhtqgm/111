import assert from 'node:assert/strict';
import {
  buildMa40Projection,
  MA_WINDOWS,
} from '../src/utils/movingAverage.ts';
import { filterCompletedKLineData } from '../src/utils/completedPeriods.ts';
import { generatePredictionRows } from '../src/utils/predictions.ts';

const EPSILON = 1e-9;

function main() {
  verifyDayFiltering();
  verifyWeekFiltering();
  verifyMonthFiltering();
  verifyProjectionMathForAllWindows();
  console.log('MA period verification passed.');
}

function verifyDayFiltering() {
  const historical = makeBusinessDaysEnding('2026-07-07', 60);
  const points = [...historical, makePoint('2026-07-08', 999)];
  const beforeClose = makeResponse(points);
  const filteredBefore = filterCompletedKLineData(
    beforeClose,
    'day',
    chinaTime('2026-07-08 14:00'),
  );

  assert.equal(filteredBefore.lastCompletedDate, '2026-07-07');
  assert.deepEqual(
    filteredBefore.removedPoints.map((point) => point.date),
    ['2026-07-08'],
  );
  assert.equal(
    generatePredictionRows(filteredBefore.data.points, 'day', '2026-07-07', 1)[0].targetDate,
    '2026-07-08',
  );

  const filteredAfter = filterCompletedKLineData(
    beforeClose,
    'day',
    chinaTime('2026-07-08 15:20'),
  );
  assert.equal(filteredAfter.lastCompletedDate, '2026-07-08');
  assert.equal(filteredAfter.removedPoints.length, 0);
}

function verifyWeekFiltering() {
  const historical = makeWeeklyDatesEnding('2026-07-03', 60);
  const points = [...historical, makePoint('2026-07-10', 999)];
  const filteredBefore = filterCompletedKLineData(
    makeResponse(points),
    'week',
    chinaTime('2026-07-08 14:00'),
  );

  assert.equal(filteredBefore.lastCompletedDate, '2026-07-03');
  assert.deepEqual(
    filteredBefore.removedPoints.map((point) => point.date),
    ['2026-07-10'],
  );
  assert.equal(
    generatePredictionRows(filteredBefore.data.points, 'week', '2026-07-03', 1)[0].targetDate,
    '2026-07-10',
  );

  const filteredAfter = filterCompletedKLineData(
    makeResponse(points),
    'week',
    chinaTime('2026-07-10 15:20'),
  );
  assert.equal(filteredAfter.lastCompletedDate, '2026-07-10');
  assert.equal(filteredAfter.removedPoints.length, 0);
}

function verifyMonthFiltering() {
  const historical = makeMonthEndsEnding('2026-06-30', 60);
  const points = [...historical, makePoint('2026-07-31', 999)];
  const filteredBefore = filterCompletedKLineData(
    makeResponse(points),
    'month',
    chinaTime('2026-07-08 14:00'),
  );

  assert.equal(filteredBefore.lastCompletedDate, '2026-06-30');
  assert.deepEqual(
    filteredBefore.removedPoints.map((point) => point.date),
    ['2026-07-31'],
  );
  assert.equal(
    generatePredictionRows(filteredBefore.data.points, 'month', '2026-06-30', 1)[0].targetDate,
    '2026-07-31',
  );

  const currentMonthDatedToday = filterCompletedKLineData(
    makeResponse([...historical, makePoint('2026-07-08', 999)]),
    'month',
    chinaTime('2026-07-08 15:20'),
  );
  assert.equal(currentMonthDatedToday.lastCompletedDate, '2026-06-30');
  assert.deepEqual(
    currentMonthDatedToday.removedPoints.map((point) => point.date),
    ['2026-07-08'],
  );

  const filteredAfter = filterCompletedKLineData(
    makeResponse(points),
    'month',
    chinaTime('2026-07-31 15:20'),
  );
  assert.equal(filteredAfter.lastCompletedDate, '2026-07-31');
  assert.equal(filteredAfter.removedPoints.length, 0);
}

function verifyProjectionMathForAllWindows() {
  const cases = [
    {
      period: 'day',
      baseDate: '2026-07-07',
      points: makeBusinessDaysEnding('2026-07-07', 80),
    },
    {
      period: 'week',
      baseDate: '2026-07-03',
      points: makeWeeklyDatesEnding('2026-07-03', 80),
    },
    {
      period: 'month',
      baseDate: '2026-06-30',
      points: makeMonthEndsEnding('2026-06-30', 80),
    },
  ];

  for (const testCase of cases) {
    for (const inputWindow of MA_WINDOWS) {
      verifyProjectionCase(testCase.period, testCase.points, testCase.baseDate, inputWindow);
    }
  }
}

function verifyProjectionCase(period, points, baseDate, inputWindow) {
  const targetRows = generatePredictionRows(points, period, baseDate, 2);
  const predictions = targetRows.map((row, index) => ({
    ...row,
    predictedMaValues: {
      [String(inputWindow)]: String(25 + inputWindow / 10 + index),
    },
  }));
  const projection = buildMa40Projection(points, predictions, baseDate, inputWindow);
  const orderedDates = Array.from(
    new Set([...points.map((point) => point.date), ...predictions.map((row) => row.targetDate)]),
  ).sort();
  const closeByDate = new Map(points.map((point) => [point.date, point.close]));

  for (let rowIndex = 0; rowIndex < predictions.length; rowIndex += 1) {
    const prediction = predictions[rowIndex];
    const projectionRow = projection.rows[rowIndex];
    const targetMa = Number(prediction.predictedMaValues[String(inputWindow)]);
    const targetIndex = orderedDates.indexOf(prediction.targetDate);
    const reverseDates = orderedDates.slice(targetIndex - (inputWindow - 1), targetIndex);
    const expectedClose = targetMa * inputWindow - sum(reverseDates.map((date) => closeByDate.get(date)));

    assertAlmostEqual(
      projectionRow.derivedClose,
      expectedClose,
      `${period} MA${inputWindow} reverse close at ${prediction.targetDate}`,
    );

    closeByDate.set(prediction.targetDate, expectedClose);
    for (const outputWindow of MA_WINDOWS) {
      const windowDates = orderedDates.slice(targetIndex - outputWindow + 1, targetIndex + 1);
      const expectedMa = average(windowDates.map((date) => closeByDate.get(date)));
      assertAlmostEqual(
        projectionRow.maValues[outputWindow],
        expectedMa,
        `${period} input MA${inputWindow} output MA${outputWindow} at ${prediction.targetDate}`,
      );
    }
  }

  for (const outputWindow of MA_WINDOWS) {
    assert.equal(projection.actualLines[outputWindow].at(-1)?.targetDate, baseDate);
    assert.equal(projection.predictedLines[outputWindow][0]?.targetDate, baseDate);
  }
}

function makeResponse(points) {
  return {
    code: '000166',
    name: 'test',
    market: 0,
    points,
  };
}

function makePoint(date, close) {
  return {
    date,
    open: close,
    close,
    high: close,
    low: close,
    volume: 0,
    amount: 0,
    amplitude: 0,
    pctChange: 0,
    change: 0,
    turnover: 0,
  };
}

function makeBusinessDaysEnding(endDate, count) {
  const result = [];
  let date = parseDate(endDate);

  while (result.length < count) {
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) {
      result.push(formatDate(date));
    }
    date = addDays(date, -1);
  }

  return result.reverse().map((dateValue, index) => makePoint(dateValue, index + 1));
}

function makeWeeklyDatesEnding(endDate, count) {
  return makeSteppedDatesEnding(endDate, count, -7);
}

function makeMonthEndsEnding(endDate, count) {
  const result = [];
  let date = parseDate(endDate);

  while (result.length < count) {
    result.push(formatDate(date));
    date = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0));
  }

  return result.reverse().map((dateValue, index) => makePoint(dateValue, index + 1));
}

function makeSteppedDatesEnding(endDate, count, stepDays) {
  const result = [];
  let date = parseDate(endDate);

  while (result.length < count) {
    result.push(formatDate(date));
    date = addDays(date, stepDays);
  }

  return result.reverse().map((dateValue, index) => makePoint(dateValue, index + 1));
}

function parseDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function formatDate(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function chinaTime(value) {
  return new Date(`${value}:00+08:00`);
}

function assertAlmostEqual(actual, expected, message) {
  assert.equal(typeof actual, 'number', message);
  assert.ok(Number.isFinite(actual), message);
  assert.ok(Math.abs(actual - expected) <= EPSILON, `${message}: expected ${expected}, got ${actual}`);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function average(values) {
  return sum(values) / values.length;
}

main();
