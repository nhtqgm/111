import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildForecastCloseChartRows,
  buildForecastCloseTableRows,
  getForecastCloseCell,
  getLatestCompletedTargetDate,
  getLatestSettledTargetDate,
} from '../src/utils/forecastCloseDisplay.ts';

const projectionRow = {
  targetDate: '2026-07-27',
  actualClose: null,
  derivedClose: 23.14,
  isForecast: true,
};
const issuedRow = {
  targetDate: '2026-07-27',
  predictedClose: 23.12,
  settlement: null,
};

test('an open target shows the live estimate while preserving the locked close', () => {
  const chartRows = buildForecastCloseChartRows({
    projectionRows: [projectionRow],
    issuedRows: [issuedRow],
    historyRows: [],
  });

  assert.deepEqual(chartRows.locked, [{ targetDate: '2026-07-27', value: 23.12 }]);
  assert.deepEqual(chartRows.provisional, [{ targetDate: '2026-07-27', value: 23.14 }]);
  assert.deepEqual(chartRows.actual, []);
  assert.deepEqual(getForecastCloseCell(projectionRow, issuedRow), {
    kind: 'provisional',
    label: '实时暂估',
    value: 23.14,
  });
});

test('a settled target replaces the live estimate with the final actual close', () => {
  const settledProjection = {
    ...projectionRow,
    actualClose: 4.66,
    isForecast: false,
  };
  const settledIssued = {
    ...issuedRow,
    settlement: {
      actualDate: '2026-07-27',
      actualClose: 4.66,
    },
  };
  const chartRows = buildForecastCloseChartRows({
    projectionRows: [settledProjection],
    issuedRows: [settledIssued],
    historyRows: [],
  });

  assert.deepEqual(chartRows.locked, [{ targetDate: '2026-07-27', value: 23.12 }]);
  assert.deepEqual(chartRows.provisional, []);
  assert.deepEqual(chartRows.actual, [{ targetDate: '2026-07-27', value: 4.66 }]);
  assert.deepEqual(getForecastCloseCell(settledProjection, settledIssued), {
    kind: 'actual',
    label: '真实收盘价',
    value: 4.66,
  });
  assert.equal(getLatestSettledTargetDate([settledIssued]), '2026-07-27');
});

test('an unissued completed draft still switches from provisional to actual on the chart', () => {
  const chartRows = buildForecastCloseChartRows({
    projectionRows: [{
      ...projectionRow,
      actualClose: 4.66,
      isForecast: false,
    }],
    issuedRows: [],
    historyRows: [],
  });

  assert.deepEqual(chartRows.provisional, []);
  assert.deepEqual(chartRows.actual, [{ targetDate: '2026-07-27', value: 4.66 }]);
});

test('only the most recent settled target is retained for the input table', () => {
  assert.equal(
    getLatestSettledTargetDate([
      {
        ...issuedRow,
        targetDate: '2026-07-25',
        settlement: { actualDate: '2026-07-25', actualClose: 4.61 },
      },
      {
        ...issuedRow,
        targetDate: '2026-07-27',
        settlement: { actualDate: '2026-07-27', actualClose: 4.66 },
      },
      {
        ...issuedRow,
        targetDate: '2026-07-28',
      },
    ]),
    '2026-07-27',
  );
});

test('a settled issued row remains in the table when its editable draft is missing', () => {
  const settledIssued = {
    ...issuedRow,
    periodKey: '2026-07-27',
    settlement: {
      actualDate: '2026-07-27',
      actualClose: 4.66,
    },
  };
  const tableRows = buildForecastCloseTableRows(
    [],
    [settledIssued],
    (targetDate) => targetDate,
  );

  assert.equal(tableRows.length, 1);
  assert.equal(tableRows[0].targetDate, '2026-07-27');
  assert.equal(tableRows[0].row, null);
  assert.equal(tableRows[0].issuedRow, settledIssued);
});

test('the latest completed draft is retained even when it was not issued', () => {
  assert.equal(
    getLatestCompletedTargetDate(
      [
        {
          ...projectionRow,
          targetDate: '2026-07-27',
          actualClose: 4.66,
          isForecast: false,
        },
        {
          ...projectionRow,
          targetDate: '2026-07-28',
        },
      ],
      [],
    ),
    '2026-07-27',
  );
});
