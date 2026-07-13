import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import type { StockKLineResponse } from '../src/types.ts';

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

const sampleData: StockKLineResponse = {
  code: '000166',
  name: 'Test Stock',
  market: 0,
  sourceName: 'Tencent unadjusted',
  sourceProvider: 'tencent',
  adjustment: 'bfq',
  points: [
    {
      date: '2026-07-09',
      open: 4.5,
      close: 4.6,
      high: 4.7,
      low: 4.4,
      volume: 1000,
      amount: 4600,
      amplitude: 6.52,
      pctChange: 1.1,
      change: 0.05,
      turnover: 0.2,
    },
    {
      date: '2026-07-10',
      open: 4.6,
      close: 4.65,
      high: 4.75,
      low: 4.55,
      volume: 1200,
      amount: 5580,
      amplitude: 4.35,
      pctChange: 1.09,
      change: 0.05,
      turnover: 0.24,
    },
  ],
};

async function loadCacheModule() {
  try {
    return await import('../src/utils/kLineCache.ts');
  } catch {
    return {};
  }
}

test('K-line history survives save and reload with its quote basis intact', async () => {
  const module = await loadCacheModule();
  assert.equal(typeof module.saveKLineCache, 'function');
  assert.equal(typeof module.loadKLineCache, 'function');

  const storage = new MemoryStorage();
  const writes: Record<string, string>[] = [];
  const api = {
    async bootstrap(snapshot: Record<string, string>) {
      writes.push(snapshot);
      return snapshot;
    },
    async save() {},
  };

  await module.saveKLineCache(sampleData, 'day', storage, api);
  const restored = module.loadKLineCache('000166', 'day', storage);

  assert.equal(restored?.stockCode, '000166');
  assert.equal(restored?.period, 'day');
  assert.equal(restored?.data.adjustment, 'bfq');
  assert.deepEqual(restored?.data.points, sampleData.points);
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0]), ['prediction-ma40:kline-cache:000166:day:v1']);
});

test('malformed or mismatched K-line cache entries are ignored', async () => {
  const module = await loadCacheModule();
  assert.equal(typeof module.loadKLineCache, 'function');

  const storage = new MemoryStorage();
  storage.setItem(
    'prediction-ma40:kline-cache:000166:day:v1',
    JSON.stringify({
      schema: 'gupiao-kline-cache/v1',
      stockCode: '600000',
      period: 'day',
      updatedAt: '2026-07-13T00:00:00.000Z',
      data: sampleData,
    }),
  );
  assert.equal(module.loadKLineCache('000166', 'day', storage), null);

  storage.setItem(
    'prediction-ma40:kline-cache:000166:day:v1',
    JSON.stringify({
      schema: 'gupiao-kline-cache/v1',
      stockCode: '000166',
      period: 'day',
      updatedAt: '2026-07-13T00:00:00.000Z',
      data: {
        ...sampleData,
        points: [{ ...sampleData.points[0], high: 4.3 }],
      },
    }),
  );
  assert.equal(module.loadKLineCache('000166', 'day', storage), null);
});

test('last viewed stock and period persist without prediction values', async () => {
  const module = await loadCacheModule();
  assert.equal(typeof module.saveLastKLineScope, 'function');
  assert.equal(typeof module.loadLastKLineScope, 'function');

  const storage = new MemoryStorage();
  await module.saveLastKLineScope('000166', 'week', storage);

  assert.deepEqual(module.loadLastKLineScope(storage), {
    stockCode: '000166',
    period: 'week',
  });
  assert.equal(storage.getItem('prediction-ma:000166:week:v2'), null);
});

test('Electron bootstrap restores only valid K-line cache records', async () => {
  const module = await loadCacheModule();
  assert.equal(typeof module.bootstrapKLineCacheStorage, 'function');

  const storage = new MemoryStorage();
  storage.setItem('prediction-ma:000166:day:v2', 'local prediction must stay untouched');
  const cacheKey = 'prediction-ma40:kline-cache:000166:day:v1';
  const scopeKey = 'prediction-ma40:kline-cache:last-scope:v1';
  const storedCache = JSON.stringify({
    schema: 'gupiao-kline-cache/v1',
    stockCode: '000166',
    period: 'day',
    updatedAt: '2026-07-13T00:00:00.000Z',
    data: sampleData,
  });
  const storedScope = JSON.stringify({
    schema: 'gupiao-kline-cache-scope/v1',
    stockCode: '000166',
    period: 'day',
    updatedAt: '2026-07-13T00:00:00.000Z',
  });
  const received: Record<string, string>[] = [];
  const api = {
    async bootstrap(snapshot: Record<string, string>) {
      received.push(snapshot);
      return {
        [cacheKey]: storedCache,
        [scopeKey]: storedScope,
        'prediction-ma:600000:month:v2': 'remote prediction must not be restored',
      };
    },
    async save() {},
  };

  await module.bootstrapKLineCacheStorage(storage, api);

  assert.deepEqual(received, [{}]);
  assert.equal(storage.getItem(cacheKey), storedCache);
  assert.equal(storage.getItem(scopeKey), storedScope);
  assert.equal(storage.getItem('prediction-ma:000166:day:v2'), 'local prediction must stay untouched');
  assert.equal(storage.getItem('prediction-ma:600000:month:v2'), null);
});

test('the application restores cached history before render and saves every successful refresh', () => {
  const mainSource = fs.readFileSync('src/main.tsx', 'utf8');
  const appSource = fs.readFileSync('src/App.tsx', 'utf8');

  assert.match(mainSource, /bootstrapKLineCacheStorage\(\)/);
  assert.match(appSource, /loadLastKLineScope\(\)/);
  assert.match(appSource, /loadKLineCache\(queryCode, period\)/);
  assert.match(appSource, /saveKLineCache\(filtered\.data, result\.period\)/);
  assert.match(appSource, /saveLastKLineScope\(.*nextPeriod/s);
});

test('an offline cloud workspace request cannot clear already restored market history', () => {
  const appSource = fs.readFileSync('src/App.tsx', 'utf8');
  const loadStart = appSource.indexOf('async function loadCloudWorkspace');
  const loadEnd = appSource.indexOf('function saveCurrentWorkspace', loadStart);
  const loadWorkspaceSource = appSource.slice(loadStart, loadEnd);

  assert.ok(loadStart >= 0 && loadEnd > loadStart);
  assert.doesNotMatch(loadWorkspaceSource, /setData\(null\)/);
  assert.doesNotMatch(loadWorkspaceSource, /setDataPeriod\(null\)/);
});
