import assert from 'node:assert/strict';
import test from 'node:test';

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
