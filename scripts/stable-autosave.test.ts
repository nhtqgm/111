import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createStableAutosave,
  runWorkspaceTransition,
  type StableIntervalApi,
} from '../src/utils/stableAutosave.ts';

function createIntervalApi() {
  const intervalId = { name: 'autosave-interval' };
  const setCalls: Array<{ callback: () => void; intervalMs: number }> = [];
  const clearedIds: unknown[] = [];
  const api: StableIntervalApi = {
    setInterval(callback, intervalMs) {
      setCalls.push({ callback, intervalMs });
      return intervalId;
    },
    clearInterval(id) {
      clearedIds.push(id);
    },
  };

  return { api, clearedIds, intervalId, setCalls };
}

test('createStableAutosave installs exactly one interval', () => {
  const { api, setCalls } = createIntervalApi();

  createStableAutosave(() => {}, 30000, api);

  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0].intervalMs, 30000);
});

test('update replaces the callback without installing or restarting an interval', () => {
  const { api, clearedIds, setCalls } = createIntervalApi();
  const scheduler = createStableAutosave(() => {}, 30000, api);

  scheduler.update(() => {});
  scheduler.update(() => {});

  assert.equal(setCalls.length, 1);
  assert.equal(clearedIds.length, 0);
});

test('the interval invokes the latest callback', () => {
  const { api, setCalls } = createIntervalApi();
  const calls: string[] = [];
  const scheduler = createStableAutosave(() => calls.push('initial'), 30000, api);

  scheduler.update(() => calls.push('latest'));
  setCalls[0].callback();

  assert.deepEqual(calls, ['latest']);
});

test('dispose clears the exact interval once', () => {
  const { api, clearedIds, intervalId } = createIntervalApi();
  const scheduler = createStableAutosave(() => {}, 30000, api);

  scheduler.dispose();
  scheduler.dispose();

  assert.deepEqual(clearedIds, [intervalId]);
});

test('a dirty workspace transition flushes before changing context', () => {
  const calls: string[] = [];

  runWorkspaceTransition(
    true,
    () => calls.push('flush'),
    () => calls.push('change'),
  );

  assert.deepEqual(calls, ['flush', 'change']);
});

test('a clean workspace transition skips the flush and changes context', () => {
  const calls: string[] = [];

  runWorkspaceTransition(
    false,
    () => calls.push('flush'),
    () => calls.push('change'),
  );

  assert.deepEqual(calls, ['change']);
});
