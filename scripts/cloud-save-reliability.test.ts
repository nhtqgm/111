import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { PredictionPoint } from '../src/types.ts';
import * as outboxModule from '../src/utils/cloudOutbox.ts';
import * as storageModule from '../src/utils/cloudPredictionStorage.ts';
import { createEmptyCloudWorkspace, getWorkspacePredictions } from '../src/utils/cloudWorkspace.ts';

const mutation = {
  stockCode: '000166',
  period: 'day' as const,
  targetDate: '2026-07-14',
  metric: 'ma40' as const,
  value: '9.1500',
};

test('failed prediction saves remain durable and are retried after restart', async () => {
  const persisted: Array<{
    mutations: typeof mutation[];
    lastSavedAt: string | null;
  }> = [];
  const states: Array<{ status: string; pendingCount: number }> = [];
  const queue = storageModule.createPredictionValueSaveQueue({
    accountId: 'account-719',
    debounceMs: 0,
    initialMutations: [mutation],
    save: async () => {
      throw new Error('offline');
    },
    persist: (snapshot) => persisted.push(snapshot),
    onStateChange: (state) => states.push(state),
  });

  await queue.flush();

  assert.equal(queue.getState().status, 'error');
  assert.equal(queue.getState().pendingCount, 1);
  assert.deepEqual(persisted.at(-1)?.mutations, [mutation]);
  assert.equal(states.at(-1)?.status, 'error');

  const retried: typeof mutation[][] = [];
  const restoredQueue = storageModule.createPredictionValueSaveQueue({
    accountId: 'account-719',
    debounceMs: 0,
    initialMutations: persisted.at(-1)?.mutations ?? [],
    save: async (mutations) => {
      retried.push(mutations);
    },
    persist: (snapshot) => persisted.push(snapshot),
  });

  await restoredQueue.flush();

  assert.deepEqual(retried, [[mutation]]);
  assert.equal(restoredQueue.getState().status, 'saved');
  assert.equal(restoredQueue.getState().pendingCount, 0);
  assert.deepEqual(persisted.at(-1)?.mutations, []);
  assert.ok(persisted.at(-1)?.lastSavedAt);
});

test('pending mutations are applied over the downloaded cloud workspace', () => {
  assert.equal(typeof storageModule.applyPredictionValueMutationsToWorkspace, 'function');
  const workspace = createEmptyCloudWorkspace();
  const restored = storageModule.applyPredictionValueMutationsToWorkspace!(workspace, [mutation]);
  const rows = getWorkspacePredictions(restored, { stockCode: '000166', period: 'day' });

  assert.deepEqual(rows, [
    {
      targetDate: '2026-07-14',
      predictedMa40: '9.1500',
      predictedMaValues: { '40': '9.1500' },
      note: '',
    } satisfies PredictionPoint,
  ]);
});

test('cloud outbox storage is isolated by account and retains last save time', () => {
  assert.equal(typeof outboxModule.cloudPredictionOutboxKey, 'function');
  assert.equal(typeof outboxModule.saveCloudPredictionOutbox, 'function');
  assert.equal(typeof outboxModule.loadCloudPredictionOutbox, 'function');

  const storage = new MemoryStorage();
  outboxModule.saveCloudPredictionOutbox!('account-719', {
    mutations: [mutation],
    lastSavedAt: '2026-07-13T10:00:00.000Z',
  }, storage, undefined);

  assert.deepEqual(outboxModule.loadCloudPredictionOutbox!('account-719', storage), {
    mutations: [mutation],
    lastSavedAt: '2026-07-13T10:00:00.000Z',
  });
  assert.deepEqual(outboxModule.loadCloudPredictionOutbox!('account-185', storage), {
    mutations: [],
    lastSavedAt: null,
  });
});

test('detaching an account does not overwrite its durable pending outbox', () => {
  const persisted: Array<{
    mutations: typeof mutation[];
    lastSavedAt: string | null;
  }> = [];
  const queue = storageModule.createPredictionValueSaveQueue({
    accountId: 'account-719',
    initialMutations: [mutation],
    save: async () => undefined,
    persist: (snapshot) => persisted.push(snapshot),
  });

  const beforeDetach = persisted.at(-1);
  queue.switchAccount('');

  assert.deepEqual(beforeDetach?.mutations, [mutation]);
  assert.deepEqual(persisted.at(-1)?.mutations, [mutation]);
});

test('the app restores pending edits before rendering and exposes save status with retry', () => {
  const main = fs.readFileSync('src/main.tsx', 'utf8');
  const app = fs.readFileSync('src/App.tsx', 'utf8');

  assert.match(main, /bootstrapCloudPredictionOutboxStorage\(\)/);
  assert.match(app, /loadCloudPredictionOutbox\(user\.id\)/);
  assert.match(app, /applyPredictionValueMutationsToWorkspace\(.*outbox\.mutations/s);
  assert.match(app, /className=\{`cloud-save-indicator \$\{cloudSaveState\.status\}`\}/);
  assert.match(app, /cloudPredictionSaveQueueRef\.current\?\.retry\(\)/);
});

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
