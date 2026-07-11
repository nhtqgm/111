const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadStorageModule() {
  try {
    return require('../electron/app-storage.cjs');
  } catch {
    return {};
  }
}

test('filterAppStorage keeps only application string values', () => {
  const { filterAppStorage } = loadStorageModule();
  assert.equal(typeof filterAppStorage, 'function');

  assert.deepEqual(
    filterAppStorage({
      'prediction-ma:000166:month:v2': '[{"targetDate":"2026-07-31"}]',
      'prediction-ma40:last-workspace': '{"stockCode":"000166"}',
      unrelated: 'do-not-save',
      'prediction-ma:invalid-value': { value: 1 },
    }),
    {
      'prediction-ma:000166:month:v2': '[{"targetDate":"2026-07-31"}]',
      'prediction-ma40:last-workspace': '{"stockCode":"000166"}',
    },
  );
});

test('mergeAppStorage preserves filled predictions and newer timestamped caches', () => {
  const { mergeAppStorage } = loadStorageModule();
  assert.equal(typeof mergeAppStorage, 'function');

  const predictionKey = 'prediction-ma:000166:month:v2';
  const cacheKey = 'prediction-ma40:kline-cache:000166:month:v1';
  const existingPredictions = JSON.stringify([
    {
      targetDate: '2026-07-31',
      predictedMa40: '4.8300',
      predictedMaValues: { 40: '4.8300' },
      note: '',
    },
  ]);
  const incomingEmptyPredictions = JSON.stringify([
    {
      targetDate: '2026-07-31',
      predictedMa40: '',
      predictedMaValues: {},
      note: '',
    },
  ]);

  const merged = mergeAppStorage(
    {
      [predictionKey]: existingPredictions,
      [cacheKey]: JSON.stringify({ updatedAt: '2026-07-01T00:00:00.000Z', data: { points: [] } }),
    },
    {
      [predictionKey]: incomingEmptyPredictions,
      [cacheKey]: JSON.stringify({ updatedAt: '2026-07-10T00:00:00.000Z', data: { points: [1] } }),
      'prediction-ma40:last-workspace': JSON.stringify({
        stockCode: '000166',
        updatedAt: '2026-07-10T00:00:00.000Z',
      }),
    },
  );

  assert.equal(merged[predictionKey], existingPredictions);
  assert.deepEqual(JSON.parse(merged[cacheKey]).data.points, [1]);
  assert.equal(JSON.parse(merged['prediction-ma40:last-workspace']).stockCode, '000166');
});

test('mergeAppStorage prefers a newer non-empty prediction table over an older fuller table', () => {
  const { mergeAppStorage } = loadStorageModule();
  assert.equal(typeof mergeAppStorage, 'function');

  const predictionKey = 'prediction-ma:688571:day:v2';
  const olderFullerTable = JSON.stringify(
    Array.from({ length: 30 }, (_, index) => ({
      targetDate: `2026-07-${String(index + 10).padStart(2, '0')}`,
      predictedMa40: '9.1000',
      predictedMaValues: { 40: '9.1000' },
    })),
  );
  const newerCurrentTable = JSON.stringify([
    {
      targetDate: '2026-07-10',
      predictedMa40: '9.2000',
      predictedMaValues: { 40: '9.2000' },
    },
    {
      targetDate: '2026-07-13',
      predictedMa40: '9.1300',
      predictedMaValues: { 40: '9.1300' },
    },
    {
      targetDate: '2026-07-14',
      predictedMa40: '9.1300',
      predictedMaValues: { 40: '9.1300' },
    },
  ]);

  const merged = mergeAppStorage(
    {
      [predictionKey]: olderFullerTable,
      'prediction-ma40:last-workspace': JSON.stringify({
        stockCode: '688571',
        period: 'day',
        updatedAt: '2026-07-11T12:00:00.000Z',
      }),
    },
    {
      [predictionKey]: newerCurrentTable,
      'prediction-ma40:last-workspace': JSON.stringify({
        stockCode: '688571',
        period: 'day',
        updatedAt: '2026-07-11T12:24:00.000Z',
      }),
    },
  );

  assert.equal(merged[predictionKey], newerCurrentTable);
  assert.equal(JSON.parse(merged[predictionKey])[0].predictedMa40, '9.2000');
});

test('app storage store persists snapshots and keeps rolling backups', async (t) => {
  const { createAppStorageStore } = loadStorageModule();
  assert.equal(typeof createAppStorageStore, 'function');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gupiao-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const store = createAppStorageStore(directory, { maxBackups: 2 });
  const first = {
    'prediction-ma:000166:month:v2': JSON.stringify([{ predictedMa40: '4.8300' }]),
  };
  const second = {
    ...first,
    'prediction-ma40:last-workspace': JSON.stringify({
      stockCode: '000166',
      updatedAt: '2026-07-10T00:00:00.000Z',
    }),
  };

  await store.replace(first);
  await store.replace(second);
  assert.deepEqual(await store.load(), second);
  assert.equal(fs.existsSync(path.join(directory, 'app-cache-v1.json')), true);
  assert.equal(fs.readdirSync(path.join(directory, 'backups')).length, 1);
});

test('legacy migration merges old local storage only once', async (t) => {
  const { createAppStorageStore } = loadStorageModule();
  assert.equal(typeof createAppStorageStore, 'function');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gupiao-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const store = createAppStorageStore(directory);
  assert.equal(await store.needsLegacyMigration(), true);
  await store.completeLegacyMigration({
    'prediction-ma:000166:month:v2': JSON.stringify([{ predictedMa40: '4.8300' }]),
  });
  assert.equal(await store.needsLegacyMigration(), false);
  assert.equal(
    JSON.parse((await store.load())['prediction-ma:000166:month:v2'])[0].predictedMa40,
    '4.8300',
  );
});

test('bootstrap returns canonical data when an online UI arrives with an empty table', async (t) => {
  const { createAppStorageStore } = loadStorageModule();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gupiao-bootstrap-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const store = createAppStorageStore(directory);
  assert.equal(typeof store.bootstrap, 'function');
  const predictionKey = 'prediction-ma:000166:month:v2';
  const filled = JSON.stringify([{ predictedMa40: '4.8300', predictedMaValues: { 40: '4.8300' } }]);
  const empty = JSON.stringify([{ predictedMa40: '', predictedMaValues: {} }]);
  await store.completeLegacyMigration({ [predictionKey]: filled });

  const canonical = await store.bootstrap({
    [predictionKey]: empty,
    'prediction-ma40:last-workspace': JSON.stringify({
      stockCode: '000166',
      updatedAt: '2026-07-10T00:00:00.000Z',
    }),
  });

  assert.equal(canonical[predictionKey], filled);
  assert.equal(JSON.parse(canonical['prediction-ma40:last-workspace']).stockCode, '000166');
  assert.deepEqual(await store.load(), canonical);
});
