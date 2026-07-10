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

async function loadStorageModule() {
  try {
    return await import('../src/utils/electronStorage.ts');
  } catch {
    return {};
  }
}

test('collect and restore use only application storage keys', async () => {
  const { collectAppStorage, restoreAppStorage } = await loadStorageModule();
  assert.equal(typeof collectAppStorage, 'function');
  assert.equal(typeof restoreAppStorage, 'function');

  const storage = new MemoryStorage();
  storage.setItem('prediction-ma:old', 'old');
  storage.setItem('unrelated', 'keep');

  restoreAppStorage(storage, {
    'prediction-ma:new': 'new',
    unrelated: 'replace-attempt',
  });

  assert.deepEqual(collectAppStorage(storage), { 'prediction-ma:new': 'new' });
  assert.equal(storage.getItem('prediction-ma:old'), null);
  assert.equal(storage.getItem('unrelated'), 'keep');
});

test('transactional restore replaces app keys, preserves unrelated keys, and persists once', async () => {
  const { restoreAppStorageTransaction } = await loadStorageModule();
  assert.equal(typeof restoreAppStorageTransaction, 'function');

  const storage = new MemoryStorage();
  storage.setItem('prediction-ma:old', 'old');
  storage.setItem('prediction-ma:stale', 'stale');
  storage.setItem('unrelated', 'keep');
  const saved: Record<string, string>[] = [];
  const api = {
    async bootstrap(snapshot: Record<string, string>) {
      return snapshot;
    },
    async save(snapshot: Record<string, string>) {
      saved.push({ ...snapshot });
    },
  };

  await restoreAppStorageTransaction(
    storage,
    {
      'prediction-ma:new': 'new',
      unrelated: 'replace-attempt',
      'prediction-ma:invalid': 42,
    },
    api,
  );

  assert.equal(storage.getItem('prediction-ma:old'), null);
  assert.equal(storage.getItem('prediction-ma:stale'), null);
  assert.equal(storage.getItem('prediction-ma:new'), 'new');
  assert.equal(storage.getItem('prediction-ma:invalid'), null);
  assert.equal(storage.getItem('unrelated'), 'keep');
  assert.deepEqual(saved, [{ 'prediction-ma:new': 'new' }]);
});

test('transactional restore rejects an empty backup without removing existing app keys', async () => {
  const { EmptyAppStorageSnapshotError, restoreAppStorageTransaction } =
    await loadStorageModule();
  assert.equal(typeof EmptyAppStorageSnapshotError, 'function');
  assert.equal(typeof restoreAppStorageTransaction, 'function');

  const storage = new MemoryStorage();
  storage.setItem('prediction-ma:current', 'current');
  let saveCount = 0;
  const api = {
    async bootstrap(snapshot: Record<string, string>) {
      return snapshot;
    },
    async save() {
      saveCount += 1;
    },
  };

  await assert.rejects(
    () => restoreAppStorageTransaction(storage, {}, api),
    EmptyAppStorageSnapshotError,
  );

  assert.equal(storage.getItem('prediction-ma:current'), 'current');
  assert.equal(saveCount, 0);
});

test('transactional restore rejects a non-app-only backup without removing existing app keys', async () => {
  const { EmptyAppStorageSnapshotError, restoreAppStorageTransaction } =
    await loadStorageModule();
  assert.equal(typeof EmptyAppStorageSnapshotError, 'function');
  assert.equal(typeof restoreAppStorageTransaction, 'function');

  const storage = new MemoryStorage();
  storage.setItem('prediction-ma:current', 'current');
  storage.setItem('unrelated', 'keep');

  await assert.rejects(
    () => restoreAppStorageTransaction(storage, { unrelated: 'replace-attempt' }),
    EmptyAppStorageSnapshotError,
  );

  assert.equal(storage.getItem('prediction-ma:current'), 'current');
  assert.equal(storage.getItem('unrelated'), 'keep');
});

test('transactional restore rolls browser and Electron storage back after persistence rejects', async () => {
  const { AppStorageRestoreError, restoreAppStorageTransaction } = await loadStorageModule();
  assert.equal(typeof AppStorageRestoreError, 'function');
  assert.equal(typeof restoreAppStorageTransaction, 'function');

  const storage = new MemoryStorage();
  storage.setItem('prediction-ma:current', 'current');
  storage.setItem('prediction-ma:other', 'other');
  storage.setItem('unrelated', 'keep');
  const saved: Record<string, string>[] = [];
  const api = {
    async bootstrap(snapshot: Record<string, string>) {
      return snapshot;
    },
    async save(snapshot: Record<string, string>) {
      saved.push({ ...snapshot });
      if (saved.length === 1) throw new Error('EXE write failed');
    },
  };

  await assert.rejects(
    () =>
      restoreAppStorageTransaction(
        storage,
        { 'prediction-ma:imported': 'imported' },
        api,
      ),
    AppStorageRestoreError,
  );

  assert.equal(storage.getItem('prediction-ma:imported'), null);
  assert.equal(storage.getItem('prediction-ma:current'), 'current');
  assert.equal(storage.getItem('prediction-ma:other'), 'other');
  assert.equal(storage.getItem('unrelated'), 'keep');
  assert.deepEqual(saved, [
    { 'prediction-ma:imported': 'imported' },
    {
      'prediction-ma:current': 'current',
      'prediction-ma:other': 'other',
    },
  ]);
});

test('bootstrapElectronStorage restores the canonical Electron snapshot', async () => {
  const { bootstrapElectronStorage } = await loadStorageModule();
  assert.equal(typeof bootstrapElectronStorage, 'function');

  const storage = new MemoryStorage();
  storage.setItem('prediction-ma:current', 'empty');
  const received: Record<string, string>[] = [];
  const api = {
    async bootstrap(snapshot: Record<string, string>) {
      received.push(snapshot);
      return { 'prediction-ma:canonical': 'filled' };
    },
    async save() {},
  };

  await bootstrapElectronStorage(storage, api);

  assert.deepEqual(received, [{ 'prediction-ma:current': 'empty' }]);
  assert.deepEqual(storage.getItem('prediction-ma:canonical'), 'filled');
  assert.equal(storage.getItem('prediction-ma:current'), null);
});

test('persistElectronStorage sends the complete application snapshot', async () => {
  const { persistElectronStorage } = await loadStorageModule();
  assert.equal(typeof persistElectronStorage, 'function');

  const storage = new MemoryStorage();
  storage.setItem('prediction-ma:000166:day:v2', 'day-data');
  storage.setItem('prediction-ma:000166:month:v2', 'month-data');
  storage.setItem('unrelated', 'ignore');
  const saved: Record<string, string>[] = [];
  const api = {
    async bootstrap(snapshot: Record<string, string>) {
      return snapshot;
    },
    async save(snapshot: Record<string, string>) {
      saved.push(snapshot);
    },
  };

  await persistElectronStorage(storage, api);

  assert.deepEqual(saved, [
    {
      'prediction-ma:000166:day:v2': 'day-data',
      'prediction-ma:000166:month:v2': 'month-data',
    },
  ]);
});

test('queueElectronStorageSync collapses duplicate writes in the same turn', async () => {
  const { queueElectronStorageSync } = await loadStorageModule();
  assert.equal(typeof queueElectronStorageSync, 'function');

  const storage = new MemoryStorage();
  storage.setItem('prediction-ma:000166:month:v2', 'data');
  let saveCount = 0;
  const api = {
    async bootstrap(snapshot: Record<string, string>) {
      return snapshot;
    },
    async save() {
      saveCount += 1;
    },
  };

  await Promise.all([
    queueElectronStorageSync(storage, api),
    queueElectronStorageSync(storage, api),
  ]);

  assert.equal(saveCount, 1);
});

test('queueElectronStorageSync flushes changes requested during an active save', async () => {
  const { queueElectronStorageSync } = await loadStorageModule();
  const storage = new MemoryStorage();
  storage.setItem('prediction-ma:000166:month:v2', 'first');
  const saved: Record<string, string>[] = [];
  let releaseFirstSave = () => {};
  const firstSaveBlocked = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  const api = {
    async bootstrap(snapshot: Record<string, string>) {
      return snapshot;
    },
    async save(snapshot: Record<string, string>) {
      saved.push(snapshot);
      if (saved.length === 1) await firstSaveBlocked;
    },
  };

  const first = queueElectronStorageSync(storage, api);
  await new Promise((resolve) => setTimeout(resolve, 0));
  storage.setItem('prediction-ma:000166:month:v2', 'second');
  const second = queueElectronStorageSync(storage, api);
  releaseFirstSave();
  await Promise.all([first, second]);

  assert.equal(saved.length, 2);
  assert.equal(saved[1]['prediction-ma:000166:month:v2'], 'second');
});
