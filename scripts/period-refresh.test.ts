import assert from 'node:assert/strict';
import fs from 'node:fs';
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

test('A-share auto refresh is due at open and close, but not before open or on closures', async () => {
  const {
    getDueAStockRefreshEvent,
  } = await import('../src/utils/marketAutoRefresh.ts');

  assert.equal(
    getDueAStockRefreshEvent(new Date('2026-07-17T01:29:00.000Z')),
    null,
  );
  assert.deepEqual(
    getDueAStockRefreshEvent(new Date('2026-07-17T01:30:00.000Z')),
    { id: '2026-07-17:open', date: '2026-07-17', phase: 'open' },
  );
  assert.deepEqual(
    getDueAStockRefreshEvent(new Date('2026-07-17T07:10:00.000Z')),
    { id: '2026-07-17:close', date: '2026-07-17', phase: 'close' },
  );
  assert.equal(
    getDueAStockRefreshEvent(new Date('2026-06-19T01:30:00.000Z')),
    null,
  );
});

test('failed automatic refreshes can retry, while a completed session event is not repeated', async () => {
  const {
    isAStockRefreshEventFresh,
    shouldAttemptAStockRefresh,
  } = await import('../src/utils/marketAutoRefresh.ts');
  const event = { id: '2026-07-17:close', date: '2026-07-17', phase: 'close' as const };

  assert.equal(shouldAttemptAStockRefresh(event, null, { eventId: event.id, at: 0 }, 299_999), false);
  assert.equal(shouldAttemptAStockRefresh(event, null, { eventId: event.id, at: 0 }, 300_000), true);
  assert.equal(shouldAttemptAStockRefresh(event, event.id, null), false);
  assert.equal(isAStockRefreshEventFresh(event, '2026-07-16'), false);
  assert.equal(isAStockRefreshEventFresh(event, '2026-07-17'), true);
  assert.equal(
    isAStockRefreshEventFresh({ ...event, id: '2026-07-17:open', phase: 'open' }, null),
    true,
  );
});

test('the app enforces automatic open and close refreshes without a user toggle', () => {
  const app = fs.readFileSync('src/App.tsx', 'utf8');

  assert.match(app, /getDueAStockRefreshEvent\(\)/);
  assert.match(app, /window\.setInterval\(\(\) => void checkMarketSession\(\), MARKET_AUTO_REFRESH_CHECK_MS\)/);
  assert.match(app, /window\.addEventListener\('focus', onFocus\)/);
  assert.match(app, /document\.addEventListener\('visibilitychange', onVisibilityChange\)/);
  assert.match(app, /automaticMarketRefreshRunnerRef\.current\(event\.phase\)/);
  assert.match(app, /trigger: phase/);
  assert.doesNotMatch(app, /autoRefreshEnabled|setAutoRefreshEnabled/);
});
