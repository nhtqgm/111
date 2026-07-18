import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  bootstrapCloudHistoryOutboxStorage,
  cloudHistoryOutboxKey,
  createForecastHistorySaveQueue,
  loadCloudHistoryOutbox,
  saveCloudHistoryOutbox,
} from '../src/utils/cloudHistoryStorage.ts';
import type { ForecastHistorySnapshot } from '../src/utils/forecastHistory.ts';

test('failed forecast-history saves remain durable and retry after restart', async () => {
  const storage = memoryStorage();
  const failedQueue = createForecastHistorySaveQueue({
    accountId: 'user-a',
    debounceMs: 0,
    save: async () => { throw new Error('offline'); },
    persist: (snapshot) => saveCloudHistoryOutbox('user-a', snapshot, storage),
  });

  failedQueue.schedule([history('2026-07-17', '2026-07-16T10:00:00.000Z')]);
  await failedQueue.flush();

  assert.equal(failedQueue.getState().status, 'error');
  assert.equal(loadCloudHistoryOutbox('user-a', storage).snapshots.length, 1);

  const sent: ForecastHistorySnapshot[][] = [];
  const pending = loadCloudHistoryOutbox('user-a', storage);
  const restoredQueue = createForecastHistorySaveQueue({
    accountId: 'user-a',
    debounceMs: 0,
    initialSnapshots: pending.snapshots,
    initialLastSavedAt: pending.lastSavedAt,
    save: async (snapshots) => { sent.push(snapshots); },
    persist: (snapshot) => saveCloudHistoryOutbox('user-a', snapshot, storage),
  });
  await restoredQueue.flush();

  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].targetDate, '2026-07-17');
  assert.equal(restoredQueue.getState().pendingCount, 0);
  assert.equal(loadCloudHistoryOutbox('user-a', storage).snapshots.length, 0);
});

test('history outbox keeps the newest snapshot per id without dropping other dates', () => {
  const storage = memoryStorage();
  saveCloudHistoryOutbox('user-a', {
    snapshots: [
      history('2026-07-16', '2026-07-15T10:00:00.000Z'),
      history('2026-07-17', '2026-07-16T10:00:00.000Z'),
      { ...history('2026-07-17', '2026-07-16T11:00:00.000Z'), predictedClose: 9.2 },
    ],
    lastSavedAt: null,
  }, storage);

  const restored = loadCloudHistoryOutbox('user-a', storage);

  assert.equal(restored.snapshots.length, 2);
  assert.equal(restored.snapshots.find((item) => item.targetDate === '2026-07-17')?.predictedClose, 9.2);
});

test('history outboxes are isolated by cloud account', () => {
  const storage = memoryStorage();
  saveCloudHistoryOutbox('user-a', { snapshots: [history('2026-07-17')], lastSavedAt: null }, storage);
  saveCloudHistoryOutbox('user-b', { snapshots: [history('2026-07-18')], lastSavedAt: null }, storage);

  assert.notEqual(cloudHistoryOutboxKey('user-a'), cloudHistoryOutboxKey('user-b'));
  assert.equal(loadCloudHistoryOutbox('user-a', storage).snapshots[0].targetDate, '2026-07-17');
  assert.equal(loadCloudHistoryOutbox('user-b', storage).snapshots[0].targetDate, '2026-07-18');
});

test('history outbox is restored through the Electron durable storage bridge', async () => {
  const storage = memoryStorage();
  const canonicalValue = JSON.stringify({
    schema: 'gupiao-cloud-history-outbox/v1',
    accountId: 'user-a',
    snapshots: [history('2026-07-17')],
    lastSavedAt: null,
    updatedAt: '2026-07-18T10:00:00.000Z',
  });
  const received: Record<string, string>[] = [];
  await bootstrapCloudHistoryOutboxStorage(storage, {
    async bootstrap(snapshot) {
      received.push(snapshot);
      return { [cloudHistoryOutboxKey('user-a')]: canonicalValue };
    },
    async save() {},
  });

  assert.deepEqual(Object.keys(received[0]), []);
  assert.equal(loadCloudHistoryOutbox('user-a', storage).snapshots[0].targetDate, '2026-07-17');
});

test('Supabase history RPC upserts one snapshot id and never deletes older dates', () => {
  const sql = fs.readFileSync('supabase/20260711_normalized_predictions.sql', 'utf8');
  const start = sql.indexOf('create or replace function public.upsert_my_forecast_history');
  const end = sql.indexOf('revoke all on function public.get_my_prediction_workspace');
  const historyRpc = sql.slice(start, end);

  assert.match(historyRpc, /on conflict \(user_id, snapshot_id\) do update/i);
  assert.match(historyRpc, /excluded\.payload->>'savedAt'/i);
  assert.doesNotMatch(historyRpc, /delete from public\.user_forecast_history/i);
});

function history(
  targetDate: string,
  savedAt = '2026-07-16T10:00:00.000Z',
): ForecastHistorySnapshot {
  return {
    schema: 'gupiao-forecast-history/v1',
    id: `688571:day:${targetDate}:MA40`,
    stockCode: '688571',
    period: 'day',
    targetDate,
    inputMaWindow: 40,
    inputMaValue: 9.15,
    predictedClose: 9.17,
    predictedMaValues: { 5: 9, 10: 9, 20: 9, 40: 9.15, 60: 9 },
    note: '',
    savedAt,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key(index: number) { return [...values.keys()][index] ?? null; },
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };
}
