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

test('savePredictionDraft keeps the latest edit through a page refresh', async (t) => {
  const previousLocalStorage = globalThis.localStorage;
  const previousWindow = globalThis.window;
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: previousLocalStorage,
    });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  });

  const { predictionPlanKey, savePredictionDraft } = await import('../src/utils/predictions.ts');
  const rows = [
    {
      targetDate: '2026-07-10',
      predictedMa40: '9.2000',
      predictedMaValues: { 40: '9.2000' },
      note: '',
    },
  ];

  savePredictionDraft('688571', 'day', '2026-07-09', rows);

  assert.deepEqual(JSON.parse(storage.getItem(predictionPlanKey('688571', 'day')) ?? '[]'), rows);
  const workspace = JSON.parse(storage.getItem('prediction-ma40:last-workspace') ?? '{}');
  assert.equal(workspace.stockCode, '688571');
  assert.equal(workspace.period, 'day');
  assert.equal(workspace.baseDate, '2026-07-09');
  assert.equal(typeof workspace.updatedAt, 'string');
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
