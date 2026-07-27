import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildForecastCloseChartRows,
  buildForecastCloseTableRows,
  getForecastCloseCell,
  getLatestActualCloseContext,
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
    [],
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

test('the latest real close remains visible when reset leaves no draft, history, or issued batch', () => {
  const actualCloseContext = getLatestActualCloseContext(
    [
      { date: '2026-07-28', close: 4.70 },
      { date: '2026-07-25', close: 4.61 },
      { date: '2026-07-27', close: 4.66 },
    ],
    '2026-07-27',
  );
  assert.deepEqual(actualCloseContext, {
    actualDate: '2026-07-27',
    actualClose: 4.66,
  });

  const tableRows = buildForecastCloseTableRows(
    [],
    [],
    [],
    (targetDate) => targetDate,
    actualCloseContext,
  );
  assert.equal(tableRows.length, 1);
  assert.equal(tableRows[0].targetDate, '2026-07-27');
  assert.equal(tableRows[0].row, null);
  assert.equal(tableRows[0].issuedRow, undefined);
  assert.equal(tableRows[0].historyRow, undefined);
  assert.equal(tableRows[0].actualCloseContext, actualCloseContext);
  assert.deepEqual(
    getForecastCloseCell(
      null,
      undefined,
      undefined,
      actualCloseContext ?? undefined,
    ),
    {
      kind: 'actual',
      label: '真实收盘价',
      value: 4.66,
    },
  );

  const chartRows = buildForecastCloseChartRows({
    projectionRows: [],
    issuedRows: [],
    historyRows: [],
    actualCloseContexts: actualCloseContext ? [actualCloseContext] : [],
  });
  assert.deepEqual(chartRows.actual, [{
    targetDate: '2026-07-27',
    value: 4.66,
  }]);
  assert.deepEqual(chartRows.locked, []);
  assert.deepEqual(chartRows.provisional, []);
});

test('actual market context is skipped when the period already has a completed projection', () => {
  const tableRows = buildForecastCloseTableRows(
    [{
      ...projectionRow,
      actualClose: 4.66,
      isForecast: false,
    }],
    [],
    [],
    () => '2026-W31',
    {
      actualDate: '2026-07-31',
      actualClose: 4.66,
    },
  );

  assert.equal(tableRows.length, 1);
  assert.equal(tableRows[0].targetDate, '2026-07-27');
  assert.equal(tableRows[0].actualCloseContext, undefined);
});

test('chart actuals are deduplicated by period and settlement wins over fallback context', () => {
  const chartRows = buildForecastCloseChartRows({
    projectionRows: [{
      ...projectionRow,
      targetDate: '2026-07-30',
      actualClose: 4.64,
      isForecast: false,
    }],
    issuedRows: [{
      ...issuedRow,
      targetDate: '2026-07-31',
      settlement: {
        actualDate: '2026-07-31',
        actualClose: 4.65,
      },
    }],
    historyRows: [{
      targetDate: '2026-07-31',
      actualDate: '2026-07-30',
      predictedClose: 8.88,
      actualClose: 4.63,
    }],
    actualCloseContexts: [{
      actualDate: '2026-07-27',
      actualClose: 4.66,
    }],
    getPeriodKey: monthPeriodKey,
  });

  assert.deepEqual(chartRows.actual, [{
    targetDate: '2026-07-31',
    value: 4.65,
  }]);
});

test('chart period deduplication keeps different daily sessions independent', () => {
  const chartRows = buildForecastCloseChartRows({
    projectionRows: [{
      ...projectionRow,
      targetDate: '2026-07-28',
      actualClose: 4.67,
      isForecast: false,
    }],
    issuedRows: [],
    historyRows: [],
    actualCloseContexts: [{
      actualDate: '2026-07-27',
      actualClose: 4.66,
    }],
    getPeriodKey: dayPeriodKey,
  });

  assert.deepEqual(chartRows.actual, [
    { targetDate: '2026-07-27', value: 4.66 },
    { targetDate: '2026-07-28', value: 4.67 },
  ]);
});

test('legacy history can create a completed table row without a draft or issued batch', () => {
  const legacyHistory = {
    targetDate: '2026-07-27',
    actualDate: '2026-07-27',
    predictedClose: 23.12,
    actualClose: 4.66,
    revision: 'legacy-r1',
  };
  const tableRows = buildForecastCloseTableRows(
    [],
    [],
    [legacyHistory],
    dayPeriodKey,
  );

  assert.equal(tableRows.length, 1);
  assert.equal(tableRows[0].row, null);
  assert.equal(tableRows[0].issuedRow, undefined);
  assert.equal(tableRows[0].historyRow, legacyHistory);
  assert.equal(tableRows[0].actualCloseContext, undefined);
  assert.deepEqual(
    getForecastCloseCell(null, undefined, legacyHistory),
    {
      kind: 'actual',
      label: '真实收盘价',
      value: 4.66,
    },
  );
});

test('completed legacy history suppresses a redundant context row in the same period', () => {
  const legacyHistory = {
    targetDate: '2025-01-31',
    actualDate: '2025-01-27',
    predictedClose: 8.88,
    actualClose: 4.66,
  };
  const tableRows = buildForecastCloseTableRows(
    [],
    [],
    [legacyHistory],
    monthPeriodKey,
    {
      actualDate: '2025-01-27',
      actualClose: 4.66,
    },
  );

  assert.equal(tableRows.length, 1);
  assert.equal(tableRows[0].historyRow, legacyHistory);
  assert.equal(tableRows[0].actualCloseContext, undefined);
});

test('context stays standalone instead of changing an open row in the same week or month', () => {
  const cases = [
    {
      periodKey: weekPeriodKey,
      targetDate: '2026-06-19',
      actualDate: '2026-06-18',
    },
    {
      periodKey: monthPeriodKey,
      targetDate: '2025-01-31',
      actualDate: '2025-01-27',
    },
  ];

  for (const { periodKey, targetDate, actualDate } of cases) {
    const openRow = {
      ...projectionRow,
      targetDate,
    };
    const tableRows = buildForecastCloseTableRows(
      [openRow],
      [],
      [],
      periodKey,
      {
        actualDate,
        actualClose: 4.66,
      },
    );
    const forecastEntry = tableRows.find((entry) => entry.row === openRow);
    const contextEntry = tableRows.find(
      (entry) => entry.actualCloseContext !== undefined,
    );

    assert.equal(tableRows.length, 2);
    assert.equal(forecastEntry?.actualCloseContext, undefined);
    assert.deepEqual(
      getForecastCloseCell(
        forecastEntry?.row ?? null,
        forecastEntry?.issuedRow,
        forecastEntry?.historyRow,
        forecastEntry?.actualCloseContext,
      ),
      {
        kind: 'provisional',
        label: '实时暂估',
        value: 23.14,
      },
    );
    assert.equal(contextEntry?.row, null);
    assert.equal(contextEntry?.issuedRow, undefined);
    assert.equal(contextEntry?.historyRow, undefined);
    assert.equal(
      getForecastCloseCell(
        contextEntry?.row ?? null,
        contextEntry?.issuedRow,
        contextEntry?.historyRow,
        contextEntry?.actualCloseContext,
      ).kind,
      'actual',
    );
  }
});

test('context stays standalone instead of changing an unsettled issued row', () => {
  const openProjection = {
    ...projectionRow,
    targetDate: '2026-07-31',
  };
  const unsettledIssued = {
    ...issuedRow,
    targetDate: '2026-07-31',
    periodKey: '2026-07',
  };
  const tableRows = buildForecastCloseTableRows(
    [openProjection],
    [unsettledIssued],
    [],
    monthPeriodKey,
    {
      actualDate: '2026-07-27',
      actualClose: 4.66,
    },
  );
  const issuedEntry = tableRows.find((entry) => entry.issuedRow === unsettledIssued);
  const contextEntry = tableRows.find(
    (entry) => entry.actualCloseContext !== undefined,
  );

  assert.equal(tableRows.length, 2);
  assert.equal(issuedEntry?.actualCloseContext, undefined);
  assert.equal(
    getForecastCloseCell(
      issuedEntry?.row ?? null,
      issuedEntry?.issuedRow,
      issuedEntry?.historyRow,
      issuedEntry?.actualCloseContext,
    ).kind,
    'provisional',
  );
  assert.equal(contextEntry?.row, null);
  assert.equal(contextEntry?.issuedRow, undefined);
});

test('settlement, completed projection, history, and standalone context have strict priority', () => {
  const settledIssued = {
    ...issuedRow,
    settlement: {
      actualDate: '2026-07-27',
      actualClose: 4.69,
    },
  };
  const completedProjection = {
    ...projectionRow,
    actualClose: 4.68,
    isForecast: false,
  };
  const history = {
    targetDate: '2026-07-27',
    actualDate: '2026-07-27',
    predictedClose: 8.88,
    actualClose: 4.67,
  };
  const context = {
    actualDate: '2026-07-27',
    actualClose: 4.66,
  };

  assert.equal(
    getForecastCloseCell(
      completedProjection,
      settledIssued,
      history,
      context,
    ).value,
    4.69,
  );
  assert.equal(
    getForecastCloseCell(completedProjection, undefined, history, context).value,
    4.68,
  );
  assert.equal(
    getForecastCloseCell(null, undefined, history, context).value,
    4.67,
  );
  assert.equal(
    getForecastCloseCell(null, undefined, undefined, context).value,
    4.66,
  );
  assert.deepEqual(
    getForecastCloseCell(projectionRow, undefined, undefined, context),
    {
      kind: 'provisional',
      label: '实时暂估',
      value: 23.14,
    },
  );
});

test('a settled issued row suppresses context even when their values differ', () => {
  const settledIssued = {
    ...issuedRow,
    targetDate: '2026-07-31',
    periodKey: '2026-07',
    settlement: {
      actualDate: '2026-07-31',
      actualClose: 4.65,
    },
  };
  const tableRows = buildForecastCloseTableRows(
    [],
    [settledIssued],
    [],
    monthPeriodKey,
    {
      actualDate: '2026-07-27',
      actualClose: 4.66,
    },
  );

  assert.equal(tableRows.length, 1);
  assert.equal(tableRows[0].issuedRow, settledIssued);
  assert.equal(tableRows[0].actualCloseContext, undefined);
  assert.equal(
    getForecastCloseCell(
      tableRows[0].row,
      tableRows[0].issuedRow,
      tableRows[0].historyRow,
      tableRows[0].actualCloseContext,
    ).value,
    4.65,
  );
});

function dayPeriodKey(date: string) {
  return date;
}

function monthPeriodKey(date: string) {
  return date.slice(0, 7);
}

function weekPeriodKey(date: string) {
  const parsed = new Date(`${date}T00:00:00Z`);
  const day = parsed.getUTCDay() || 7;
  parsed.setUTCDate(parsed.getUTCDate() - day + 1);
  return parsed.toISOString().slice(0, 10);
}
