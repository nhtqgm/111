import assert from 'node:assert/strict';
import test from 'node:test';

async function loadPeriodRefreshModule() {
  return await import('../src/utils/periodRefresh.ts');
}

test('online refresh requests day, week, and month K-lines in one operation', async () => {
  const { refreshAllKLinePeriods } = await loadPeriodRefreshModule();
  const calls: string[] = [];

  const results = await refreshAllKLinePeriods(async (period) => {
    calls.push(period);
    return `${period}-data`;
  });

  assert.deepEqual([...calls].sort(), ['day', 'month', 'week']);
  assert.deepEqual(
    results.map((result) => [result.period, result.status, result.data]),
    [
      ['day', 'success', 'day-data'],
      ['week', 'success', 'week-data'],
      ['month', 'success', 'month-data'],
    ],
  );
});

test('a failed period does not discard successful updates for the other two periods', async () => {
  const { refreshAllKLinePeriods } = await loadPeriodRefreshModule();

  const results = await refreshAllKLinePeriods(async (period) => {
    if (period === 'week') throw new Error('week source unavailable');
    return period;
  });

  assert.equal(results.filter((result) => result.status === 'success').length, 2);
  assert.equal(results.find((result) => result.period === 'week')?.status, 'failed');
  assert.match(results.find((result) => result.period === 'week')?.error ?? '', /week source unavailable/);
});
