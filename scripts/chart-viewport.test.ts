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

test('chart viewport persists independently for each stock and K-line period', async () => {
  const { chartViewportStorageKey, loadChartViewport, saveChartViewport } = await loadViewportModule();
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

  const storedDay = JSON.parse(storage.getItem(chartViewportStorageKey('000166', 'day')) ?? '{}');
  assert.equal(storedDay.userAdjusted, true);
  assert.equal(typeof storedDay.updatedAt, 'string');
  assert.notEqual(
    chartViewportStorageKey('000166', 'day'),
    chartViewportStorageKey('000166', 'month'),
  );
});

test('a newer manual viewport always receives a later timestamp for Electron merging', async () => {
  const { chartViewportStorageKey, saveChartViewport } = await loadViewportModule();
  const storage = new MemoryStorage();
  const key = chartViewportStorageKey('000166', 'day');
  storage.setItem(
    key,
    JSON.stringify({
      startDate: '2026-07-01',
      endDate: '2026-07-10',
      userAdjusted: true,
      updatedAt: '2099-01-01T00:00:00.000Z',
    }),
  );

  saveChartViewport(
    '000166',
    'day',
    { startDate: '2026-07-02', endDate: '2026-07-13' },
    storage,
  );

  const stored = JSON.parse(storage.getItem(key) ?? '{}');
  assert.ok(stored.updatedAt > '2099-01-01T00:00:00.000Z');
});

test('malformed or invalid persisted chart viewport is ignored', async () => {
  const { loadChartViewport, chartViewportStorageKey } = await loadViewportModule();
  const storage = new MemoryStorage();
  storage.setItem(
    chartViewportStorageKey('000166', 'day'),
    JSON.stringify({
      startDate: '2026-07-20',
      endDate: '2026-07-10',
      userAdjusted: true,
      updatedAt: '2026-07-12T00:00:00.000Z',
    }),
  );
  storage.setItem(
    chartViewportStorageKey('000166', 'month'),
    JSON.stringify({
      startDate: '2026-01-01',
      endDate: '2026-06-30',
      userAdjusted: false,
      updatedAt: '2026-07-12T00:00:00.000Z',
    }),
  );

  assert.equal(loadChartViewport('000166', 'day', storage), null);
  assert.equal(loadChartViewport('000166', 'month', storage), null);
});

test('legacy automatic viewport cache is ignored so first use stays forecast-centered', async () => {
  const { legacyChartViewportStorageKey, loadChartViewport } = await loadViewportModule();
  const storage = new MemoryStorage();
  storage.setItem(
    legacyChartViewportStorageKey,
    JSON.stringify({
      '000166:day': { startDate: '2025-01-01', endDate: '2025-02-01' },
    }),
  );

  assert.equal(loadChartViewport('000166', 'day', storage), null);
});

test('EXE bootstrap restores only manual chart viewports and leaves prediction storage untouched', async () => {
  const { bootstrapChartViewportStorage, chartViewportStorageKey } = await loadViewportModule();
  const storage = new MemoryStorage();
  const dayKey = chartViewportStorageKey('000166', 'day');
  const weekKey = chartViewportStorageKey('000166', 'week');
  const predictionKey = 'prediction-ma:000166:day:v2';
  const localDay = JSON.stringify({
    startDate: '2026-07-01',
    endDate: '2026-07-10',
    userAdjusted: true,
    updatedAt: '2026-07-12T08:00:00.000Z',
  });
  const remoteWeek = JSON.stringify({
    startDate: '2026-06-05',
    endDate: '2026-07-10',
    userAdjusted: true,
    updatedAt: '2026-07-12T09:00:00.000Z',
  });
  storage.setItem(dayKey, localDay);
  storage.setItem(predictionKey, 'local prediction data');

  const api = {
    async bootstrap(snapshot: Record<string, string>) {
      assert.deepEqual(snapshot, { [dayKey]: localDay });
      return {
        [dayKey]: localDay,
        [weekKey]: remoteWeek,
        [predictionKey]: 'remote prediction data',
      };
    },
    async save() {},
  };

  await bootstrapChartViewportStorage(storage, api);

  assert.equal(storage.getItem(dayKey), localDay);
  assert.equal(storage.getItem(weekKey), remoteWeek);
  assert.equal(storage.getItem(predictionKey), 'local prediction data');
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
