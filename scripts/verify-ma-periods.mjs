import assert from 'node:assert/strict';
import {
  buildMa40Projection,
  MA_WINDOWS,
} from '../src/utils/movingAverage.ts';
import { filterCompletedKLineData } from '../src/utils/completedPeriods.ts';
import { generatePredictionRows } from '../src/utils/predictions.ts';
import {
  copyPredictionPlan,
  createDefaultPlan,
  getActivePlanKey,
  getPredictionPlansKey,
  loadPredictionPlans,
  saveActivePlanId,
  savePredictionPlans,
} from '../src/utils/predictionPlans.ts';
import {
  buildReplayReviewRows,
  createReplaySnapshotsFromProjection,
  filterReplayRowsByPlan,
  mergeReplaySnapshots,
  summarizeReplayRows,
} from '../src/utils/replay.ts';

const EPSILON = 1e-9;

function main() {
  verifyDayFiltering();
  verifyWeekFiltering();
  verifyMonthFiltering();
  verifyProjectionMathForAllWindows();
  verifyPredictionPlanMigration();
  verifyPredictionPlanIsolationAndActiveSelection();
  verifyPlanProjectionConsistency();
  verifyReplayReviewSnapshots();
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

function verifyPredictionPlanMigration() {
  resetLocalStorage();
  const stockCode = '000166';
  const period = 'month';
  const baseDate = '2026-06-30';
  const points = makeMonthEndsEnding(baseDate, 80);
  const targetRows = generatePredictionRows(points, period, baseDate, 2);
  const legacyRows = [
    {
      ...targetRows[0],
      predictedMa40: '4.8300',
      predictedMaValues: { 40: '4.8300' },
      note: 'legacy note',
    },
  ];

  localStorage.setItem(`prediction-ma:${stockCode}:${period}:v2`, JSON.stringify(legacyRows));
  const loaded = loadPredictionPlans(stockCode, period, baseDate, points, 2);

  assert.equal(loaded.migrated, true);
  assert.equal(loaded.plans.length, 1);
  assert.equal(loaded.plans[0].source, 'migrated');
  assert.equal(loaded.plans[0].note, 'legacy note');
  assert.equal(loaded.plans[0].predictions[0].predictedMaValues['40'], '4.8300');
  assert.equal(localStorage.getItem(getActivePlanKey(stockCode, period)), loaded.activePlanId);
  assert.ok(localStorage.getItem(getPredictionPlansKey(stockCode, period)));
}

function verifyPredictionPlanIsolationAndActiveSelection() {
  resetLocalStorage();
  const stockCode = '000166';
  const baseDate = '2026-06-30';
  const points = makeMonthEndsEnding(baseDate, 80);
  const rows = generatePredictionRows(points, 'month', baseDate, 2);
  const conservative = {
    ...createDefaultPlan(stockCode, 'month', rows, 'manual'),
    name: 'conservative',
    inputMaWindow: 20,
  };
  const aggressive = {
    ...copyPredictionPlan(conservative, [conservative]),
    name: 'aggressive',
    predictions: conservative.predictions.map((row, index) => ({
      ...row,
      predictedMaValues: index === 0 ? { 20: '5.1200' } : {},
    })),
  };

  savePredictionPlans(stockCode, 'month', [conservative, aggressive]);
  saveActivePlanId(stockCode, 'month', aggressive.id);
  const loadedMonth = loadPredictionPlans(stockCode, 'month', baseDate, points, 2);
  const loadedAggressive = loadedMonth.plans.find((plan) => plan.id === aggressive.id);

  assert.equal(loadedMonth.activePlanId, aggressive.id);
  assert.equal(loadedAggressive.inputMaWindow, 20);
  assert.equal(loadedAggressive.predictions[0].predictedMaValues['20'], '5.1200');

  const loadedWeek = loadPredictionPlans(
    stockCode,
    'week',
    '2026-07-03',
    makeWeeklyDatesEnding('2026-07-03', 80),
    2,
  );
  assert.equal(loadedWeek.plans.length, 1);
  assert.notEqual(loadedWeek.activePlanId, aggressive.id);
  assert.equal(loadedWeek.plans[0].period, 'week');
}

function verifyPlanProjectionConsistency() {
  const baseDate = '2026-06-30';
  const points = makeMonthEndsEnding(baseDate, 80);
  const rows = generatePredictionRows(points, 'month', baseDate, 1).map((row) => ({
    ...row,
    predictedMaValues: { 40: '4.8300' },
  }));
  const planA = createDefaultPlan('000166', 'month', rows, 'manual');
  const planB = copyPredictionPlan(planA, [planA]);
  const projectionA = buildMa40Projection(points, planA.predictions, baseDate, 40);
  const projectionB = buildMa40Projection(points, planB.predictions, baseDate, 40);

  assertAlmostEqual(
    projectionA.rows[0].derivedClose,
    projectionB.rows[0].derivedClose,
    'plan identity must not change reverse close math',
  );
  for (const windowSize of MA_WINDOWS) {
    assertAlmostEqual(
      projectionA.rows[0].maValues[windowSize],
      projectionB.rows[0].maValues[windowSize],
      `plan identity must not change MA${windowSize}`,
    );
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
    const reverseValues = reverseDates.map((date) => closeByDate.get(date));
    const expectedPreviousSum = sum(reverseValues);
    const expectedClose = targetMa * inputWindow - expectedPreviousSum;

    assertAlmostEqual(
      projectionRow.derivedClose,
      expectedClose,
      `${period} MA${inputWindow} reverse close at ${prediction.targetDate}`,
    );
    assert.equal(
      projectionRow.calculation.reverse.previousValues.length,
      inputWindow - 1,
      `${period} MA${inputWindow} reverse previous value count`,
    );
    assertAlmostEqual(
      projectionRow.calculation.reverse.previousSum,
      expectedPreviousSum,
      `${period} MA${inputWindow} reverse previous sum at ${prediction.targetDate}`,
    );
    assertAlmostEqual(
      projectionRow.calculation.reverse.derivedClose,
      expectedClose,
      `${period} MA${inputWindow} reverse detail close at ${prediction.targetDate}`,
    );

    closeByDate.set(prediction.targetDate, expectedClose);
    for (const outputWindow of MA_WINDOWS) {
      const windowDates = orderedDates.slice(targetIndex - outputWindow + 1, targetIndex + 1);
      const windowValues = windowDates.map((date) => closeByDate.get(date));
      const expectedSum = sum(windowValues);
      const expectedMa = expectedSum / outputWindow;
      const calculationDetail = projectionRow.calculation.movingAverages[outputWindow];
      assertAlmostEqual(
        projectionRow.maValues[outputWindow],
        expectedMa,
        `${period} input MA${inputWindow} output MA${outputWindow} at ${prediction.targetDate}`,
      );
      assert.equal(
        calculationDetail.values.length,
        outputWindow,
        `${period} input MA${inputWindow} output MA${outputWindow} detail count`,
      );
      assertAlmostEqual(
        calculationDetail.sum,
        expectedSum,
        `${period} input MA${inputWindow} output MA${outputWindow} detail sum`,
      );
      assertAlmostEqual(
        calculationDetail.average,
        expectedMa,
        `${period} input MA${inputWindow} output MA${outputWindow} detail average`,
      );
    }
  }

  for (const outputWindow of MA_WINDOWS) {
    assert.equal(projection.actualLines[outputWindow].at(-1)?.targetDate, baseDate);
    assert.equal(projection.predictedLines[outputWindow][0]?.targetDate, baseDate);
  }
}

function verifyReplayReviewSnapshots() {
  const historical = makeBusinessDaysEnding('2026-07-07', 80);
  const future = [makePoint('2026-07-08', 88), makePoint('2026-07-09', 91)];
  const baseDate = '2026-07-07';
  const inputWindow = 40;
  const targetRows = generatePredictionRows(historical, 'day', baseDate, 2);
  const predictions = targetRows.map((row, index) => ({
    ...row,
    predictedMaValues: {
      40: String(50 + index),
    },
  }));
  const projection = buildMa40Projection(historical, predictions, baseDate, inputWindow);
  const snapshots = createReplaySnapshotsFromProjection({
    stockCode: '000166',
    stockName: 'test',
    period: 'day',
    planId: 'plan-a',
    planName: 'Plan A',
    planNote: 'Plan A note',
    baseDate,
    points: historical,
    rows: projection.rows,
    inputMaWindow: inputWindow,
    existingSnapshots: [],
    now: '2026-07-08T12:00:00.000Z',
  });

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].planId, 'plan-a');
  assert.equal(snapshots[0].planName, 'Plan A');
  assert.equal(snapshots[0].note, 'Plan A note');
  assert.equal(snapshots[0].targetDate, '2026-07-08');
  assert.equal(snapshots[0].inputMaWindow, 40);
  for (const [rowIndex, snapshot] of snapshots.entries()) {
    for (const windowSize of MA_WINDOWS) {
      assertAlmostEqual(
        snapshot.predictedMaValues[String(windowSize)],
        projection.rows[rowIndex].maValues[windowSize],
        `saved replay MA${windowSize} at ${snapshot.targetDate}`,
      );
    }
  }
  const otherPlanSnapshots = createReplaySnapshotsFromProjection({
    stockCode: '000166',
    stockName: 'test',
    period: 'day',
    planId: 'plan-b',
    planName: 'Plan B',
    planNote: 'Plan B note',
    baseDate,
    points: historical,
    rows: projection.rows,
    inputMaWindow: inputWindow,
    existingSnapshots: [],
    now: '2026-07-08T12:10:00.000Z',
  });
  assert.equal(
    mergeReplaySnapshots(snapshots, otherPlanSnapshots, historical).length,
    4,
    'replay snapshots from different plans should not overwrite each other',
  );
  assert.equal(
    mergeReplaySnapshots(
      snapshots,
      [
        {
          ...snapshots[0],
          predictedClose: snapshots[0].predictedClose + 1,
          updatedAt: '2026-07-08T13:00:00.000Z',
        },
      ],
      historical,
    ).length,
    2,
  );

  const reviewRows = buildReplayReviewRows(snapshots, [...historical, ...future]);
  assert.equal(reviewRows.length, 2);
  assert.equal(reviewRows[0].status, 'ready');
  assertAlmostEqual(
    reviewRows[0].actualClose,
    88,
    'replay actual close should come from later real K-line',
  );
  assertAlmostEqual(
    reviewRows[0].closeDiff,
    snapshots[0].predictedClose - 88,
    'replay close diff',
  );

  const actualMa40 = average([...historical.slice(-39), future[0]].map((point) => point.close));
  assertAlmostEqual(reviewRows[0].maComparisons[40].actual, actualMa40, 'replay actual MA40');
  assertAlmostEqual(
    reviewRows[0].maComparisons[40].diff,
    snapshots[0].predictedMaValues['40'] - actualMa40,
    'replay MA40 diff',
  );

  const summary = summarizeReplayRows(reviewRows);
  assert.equal(summary.total, 2);
  assert.equal(summary.ready, 2);
  assert.equal(summary.pending, 0);
  assert.equal(typeof summary.closeMae, 'number');

  const mergedRows = buildReplayReviewRows(
    mergeReplaySnapshots(
      snapshots,
      [
        ...otherPlanSnapshots,
        {
          ...snapshots[0],
          id: '000166:day:legacy:2026-07-07:2026-07-08:MA40',
          planId: undefined,
          planName: undefined,
        },
      ],
      [...historical, ...future],
    ),
    [...historical, ...future],
  );
  assert.equal(filterReplayRowsByPlan(mergedRows, 'all', 'plan-a').length, 5);
  assert.equal(filterReplayRowsByPlan(mergedRows, 'active', 'plan-a').length, 2);
  assert.equal(filterReplayRowsByPlan(mergedRows, 'plan:plan-b', 'plan-a').length, 2);
  assert.equal(filterReplayRowsByPlan(mergedRows, 'legacy', 'plan-a').length, 1);
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

function resetLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

main();
