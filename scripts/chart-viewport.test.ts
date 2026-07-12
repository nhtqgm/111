import assert from 'node:assert/strict';
import test from 'node:test';

class MemoryStorage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

async function loadViewportModule() {
  return await import('../src/utils/chartViewport.ts');
}

function dates(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`);
}

test('initial viewport centers the forecast start between completed and forecast periods', async () => {
  const { getForecastCenteredZoomRange } = await loadViewportModule();
  const xAxis = [...dates(30, 'history-'), '2026-07-10', ...dates(10, 'forecast-')];

  assert.deepEqual(getForecastCenteredZoomRange(xAxis, '2026-07-10'), {
    start: 50,
    end: 100,
  });
});

test('initial viewport uses the same centering rule for day, week, and month date strings', async () => {
  const { getForecastCenteredZoomRange } = await loadViewportModule();
  const cases = [
    ['2026-07-10', ['2026-07-08', '2026-07-09', '2026-07-10', '2026-07-13', '2026-07-14']],
    ['2026-07-10', ['2026-06-26', '2026-07-03', '2026-07-10', '2026-07-17', '2026-07-24']],
    ['2026-07-31', ['2026-05-29', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30']],
  ] as const;

  cases.forEach(([baseDate, xAxis]) => {
    assert.deepEqual(getForecastCenteredZoomRange(xAxis, baseDate), { start: 0, end: 100 });
  });
});

test('viewport falls back to the complete axis when there is no future forecast period', async () => {
  const { getForecastCenteredZoomRange } = await loadViewportModule();

  assert.deepEqual(getForecastCenteredZoomRange(['2026-07-09', '2026-07-10'], '2026-07-10'), {
    start: 0,
    end: 100,
  });
});

test('viewport retains the user zoom when a chart rerenders with the same data domain', async () => {
  const { getStableChartZoomRange } = await loadViewportModule();

  assert.deepEqual(
    getStableChartZoomRange(
      'day:2026-07-10:2026-01-01|2026-07-10|2026-08-10',
      'day:2026-07-10:2026-01-01|2026-07-10|2026-08-10',
      { start: 34, end: 62 },
      { start: 50, end: 100 },
    ),
    { start: 34, end: 62 },
  );
});

test('viewport uses the centered default when the chart data domain changes', async () => {
  const { getStableChartZoomRange } = await loadViewportModule();

  assert.deepEqual(
    getStableChartZoomRange(
      'day:2026-07-10:2026-01-01|2026-07-10|2026-08-10',
      'week:2026-07-10:2026-01-02|2026-07-10|2026-08-14',
      { start: 34, end: 62 },
      { start: 48, end: 92 },
    ),
    { start: 48, end: 92 },
  );
});

test('chart viewport persists independently for each stock and K-line period', async () => {
  const { loadChartViewport, saveChartViewport } = await loadViewportModule();
  const storage = new MemoryStorage();

  saveChartViewport(
    '000166',
    'day',
    { startDate: '2026-07-10', endDate: '2026-07-20' },
    storage,
  );
  saveChartViewport(
    '000166',
    'month',
    { startDate: '2025-01-31', endDate: '2026-06-30' },
    storage,
  );

  assert.deepEqual(loadChartViewport('000166', 'day', storage), {
    startDate: '2026-07-10',
    endDate: '2026-07-20',
  });
  assert.deepEqual(loadChartViewport('000166', 'month', storage), {
    startDate: '2025-01-31',
    endDate: '2026-06-30',
  });
  assert.equal(loadChartViewport('688571', 'day', storage), null);
});

test('malformed or invalid persisted chart viewport is ignored', async () => {
  const { loadChartViewport, chartViewportStorageKey } = await loadViewportModule();
  const storage = new MemoryStorage();
  storage.setItem(
    chartViewportStorageKey,
    JSON.stringify({
      '000166:day': { startDate: '2026-07-20', endDate: '2026-07-10' },
      '000166:month': { startDate: 'bad', endDate: 90 },
    }),
  );

  assert.equal(loadChartViewport('000166', 'day', storage), null);
  assert.equal(loadChartViewport('000166', 'month', storage), null);
});

test('persisted dates are mapped back to the current axis after history changes', async () => {
  const { getChartViewportFromZoomRange, getPersistedChartZoomRange } = await loadViewportModule();
  const xAxis = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'];
  const defaultRange = { start: 0, end: 100 };

  assert.deepEqual(getChartViewportFromZoomRange(xAxis, { start: 25, end: 75 }), {
    startDate: '2026-07-02',
    endDate: '2026-07-04',
  });

  assert.deepEqual(
    getPersistedChartZoomRange(
      xAxis,
      { startDate: '2026-07-02', endDate: '2026-07-04' },
      defaultRange,
    ),
    { start: 25, end: 75 },
  );

  assert.deepEqual(
    getPersistedChartZoomRange(
      ['2026-07-01', '2026-07-02', '2026-07-03'],
      { startDate: '2025-01-01', endDate: '2025-01-02' },
      defaultRange,
    ),
    defaultRange,
  );
});

test('empty forecast-close scatter slots stay gaps instead of becoming zero-value markers', async () => {
  const { toScatterChartValue } = await import('../src/utils/chartPoints.ts');

  assert.equal(toScatterChartValue(undefined), '-');
  assert.equal(toScatterChartValue(9.2), 9.2);
});
