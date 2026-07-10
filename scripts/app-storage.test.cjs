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

function makeReplaySnapshot(id, updatedAt, predictedClose) {
  return {
    id,
    updatedAt,
    predictedClose,
  };
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

test('mergeAppStorage reconciles divergent replay buckets by snapshot ID', () => {
  const { mergeAppStorage } = loadStorageModule();
  const replayKey = 'prediction-ma:replay:000166:month:v1';
  const sharedId = '000166:month:plan-a:2026-06-30:2026-10-31:MA40';
  const persistedOnlyId = '000166:month:plan-a:2026-06-30:2026-11-30:MA40';
  const rendererOnlyId = '000166:month:plan-b:2026-06-30:2026-12-31:MA40';

  const merged = mergeAppStorage(
    {
      [replayKey]: JSON.stringify([
        makeReplaySnapshot(sharedId, '2026-07-10T00:00:00.000Z', 4.8),
        makeReplaySnapshot(persistedOnlyId, '2026-07-10T00:00:00.000Z', 4.9),
      ]),
    },
    {
      [replayKey]: JSON.stringify([
        makeReplaySnapshot(sharedId, '2026-07-11T00:00:00.000Z', 5.1),
        makeReplaySnapshot(rendererOnlyId, '2026-07-11T00:00:00.000Z', 5.2),
      ]),
    },
  );
  const snapshots = JSON.parse(merged[replayKey]);

  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.id).sort(),
    [persistedOnlyId, rendererOnlyId, sharedId].sort(),
  );
  assert.equal(snapshots.find((snapshot) => snapshot.id === sharedId).predictedClose, 5.1);
});

test('replay reconciliation keeps valid siblings when either array contains malformed entries', () => {
  const { mergeAppStorage } = loadStorageModule();
  const replayKey = 'prediction-ma:replay:000166:month:v1';
  const persistedId = '000166:month:plan-a:2026-06-30:2026-10-31:MA40';
  const rendererId = '000166:month:plan-b:2026-06-30:2026-11-30:MA40';

  const merged = JSON.parse(
    mergeAppStorage(
      {
        [replayKey]: JSON.stringify([
          makeReplaySnapshot(persistedId, '2026-07-10T00:00:00.000Z', 4.8),
          null,
        ]),
      },
      {
        [replayKey]: JSON.stringify([
          makeReplaySnapshot(rendererId, '2026-07-11T00:00:00.000Z', 5.1),
        ]),
      },
    )[replayKey],
  );

  assert.deepEqual(
    merged.map((snapshot) => snapshot.id).sort(),
    [persistedId, rendererId].sort(),
  );
});

test('replay reconciliation preserves a valid persisted array when renderer JSON is invalid', () => {
  const { mergeAppStorage } = loadStorageModule();
  const replayKey = 'prediction-ma:replay:000166:month:v1';
  const persisted = makeReplaySnapshot(
    '000166:month:plan-a:2026-06-30:2026-10-31:MA40',
    '2026-07-10T00:00:00.000Z',
    4.8,
  );

  const merged = mergeAppStorage(
    { [replayKey]: JSON.stringify([persisted]) },
    { [replayKey]: '{invalid-renderer-json' },
  );

  assert.deepEqual(JSON.parse(merged[replayKey]), [persisted]);
});

test('replay reconciliation preserves a valid renderer array when persisted JSON is invalid', () => {
  const { mergeAppStorage } = loadStorageModule();
  const replayKey = 'prediction-ma:replay:000166:month:v1';
  const renderer = makeReplaySnapshot(
    '000166:month:plan-b:2026-06-30:2026-11-30:MA40',
    '2026-07-11T00:00:00.000Z',
    5.1,
  );

  const merged = mergeAppStorage(
    { [replayKey]: '{invalid-persisted-json' },
    { [replayKey]: JSON.stringify([renderer]) },
  );

  assert.deepEqual(JSON.parse(merged[replayKey]), [renderer]);
});

test('replay reconciliation deterministically preserves persisted data when both sides are malformed', () => {
  const { mergeAppStorage } = loadStorageModule();
  const replayKey = 'prediction-ma:replay:000166:month:v1';
  const persisted = '{invalid-persisted-json';

  const merged = mergeAppStorage(
    { [replayKey]: persisted },
    { [replayKey]: '{invalid-renderer-json' },
  );

  assert.equal(merged[replayKey], persisted);
});

test('replay reconciliation prefers valid timestamps and has an order-independent fallback', () => {
  const { mergeAppStorage } = loadStorageModule();
  const replayKey = 'prediction-ma:replay:000166:month:v1';
  const validId = '000166:month:plan-a:2026-06-30:2026-10-31:MA40';
  const fallbackId = '000166:month:plan-a:2026-06-30:2026-11-30:MA40';
  const valid = makeReplaySnapshot(validId, '2026-07-10T00:00:00.000Z', 4.8);
  const invalid = makeReplaySnapshot(validId, 'not-a-timestamp', 5.1);
  const fallbackA = makeReplaySnapshot(fallbackId, 'invalid-a', 4.9);
  const fallbackB = makeReplaySnapshot(fallbackId, 'invalid-b', 5.2);

  const forward = JSON.parse(
    mergeAppStorage(
      { [replayKey]: JSON.stringify([invalid, fallbackA]) },
      { [replayKey]: JSON.stringify([valid, fallbackB]) },
    )[replayKey],
  );
  const reverse = JSON.parse(
    mergeAppStorage(
      { [replayKey]: JSON.stringify([valid, fallbackB]) },
      { [replayKey]: JSON.stringify([invalid, fallbackA]) },
    )[replayKey],
  );

  assert.deepEqual(forward, reverse);
  assert.equal(forward.find((snapshot) => snapshot.id === validId).predictedClose, 4.8);
});

test('replay reconciliation treats the supported no-plan ID as its canonical legacy ID', () => {
  const { mergeAppStorage } = loadStorageModule();
  const replayKey = 'prediction-ma:replay:000166:month:v1';
  const legacyId = '000166:month:2026-06-30:2026-10-31:MA40';
  const canonicalId = '000166:month:owner~legacy:2026-06-30:2026-10-31:MA40';
  const fields = {
    stockCode: '000166',
    period: 'month',
    baseDate: '2026-06-30',
    targetDate: '2026-10-31',
    inputMaWindow: 40,
  };

  const merged = JSON.parse(
    mergeAppStorage(
      {
        [replayKey]: JSON.stringify([
          {
            ...fields,
            id: legacyId,
            updatedAt: '2026-07-12T00:00:00.000Z',
            predictedClose: 5.3,
          },
        ]),
      },
      {
        [replayKey]: JSON.stringify([
          {
            ...fields,
            id: canonicalId,
            updatedAt: '2026-07-11T00:00:00.000Z',
            predictedClose: 5.1,
          },
        ]),
      },
    )[replayKey],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, canonicalId);
  assert.equal(merged[0].predictedClose, 5.3);
});

test('identical legacy replay buckets are still migrated to canonical owner IDs', () => {
  const { mergeAppStorage } = loadStorageModule();
  const replayKey = 'prediction-ma:replay:000166:month:v1';
  const snapshot = {
    id: '000166:month:legacy:2026-06-30:2026-10-31:MA40',
    stockCode: '000166',
    period: 'month',
    baseDate: '2026-06-30',
    targetDate: '2026-10-31',
    inputMaWindow: 40,
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
  const value = JSON.stringify([snapshot]);

  const merged = mergeAppStorage({ [replayKey]: value }, { [replayKey]: value });

  assert.equal(
    JSON.parse(merged[replayKey])[0].id,
    '000166:month:owner~legacy:2026-06-30:2026-10-31:MA40',
  );
});

test('a replay bucket present on only one side is still migrated to canonical owner IDs', () => {
  const { mergeAppStorage } = loadStorageModule();
  const replayKey = 'prediction-ma:replay:000166:month:v1';
  const snapshot = {
    id: '000166:month:legacy:2026-06-30:2026-10-31:MA40',
    stockCode: '000166',
    period: 'month',
    baseDate: '2026-06-30',
    targetDate: '2026-10-31',
    inputMaWindow: 40,
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
  const value = JSON.stringify([snapshot]);

  const persistedOnly = mergeAppStorage({ [replayKey]: value }, {});
  const rendererOnly = mergeAppStorage({}, { [replayKey]: value });

  assert.equal(
    JSON.parse(persistedOnly[replayKey])[0].id,
    '000166:month:owner~legacy:2026-06-30:2026-10-31:MA40',
  );
  assert.equal(
    JSON.parse(rendererOnly[replayKey])[0].id,
    '000166:month:owner~legacy:2026-06-30:2026-10-31:MA40',
  );
});

test('a plan literally named legacy cannot collide with a no-plan replay snapshot', () => {
  const { mergeAppStorage } = loadStorageModule();
  const replayKey = 'prediction-ma:replay:000166:month:v1';
  const collidingOldId = '000166:month:legacy:2026-06-30:2026-10-31:MA40';
  const fields = {
    stockCode: '000166',
    period: 'month',
    baseDate: '2026-06-30',
    targetDate: '2026-10-31',
    inputMaWindow: 40,
  };

  const merged = JSON.parse(
    mergeAppStorage(
      {
        [replayKey]: JSON.stringify([
          {
            ...fields,
            id: collidingOldId,
            planId: 'legacy',
            updatedAt: '2026-07-10T00:00:00.000Z',
            predictedClose: 4.8,
          },
        ]),
      },
      {
        [replayKey]: JSON.stringify([
          {
            ...fields,
            id: collidingOldId,
            updatedAt: '2026-07-11T00:00:00.000Z',
            predictedClose: 5.1,
          },
        ]),
      },
    )[replayKey],
  );

  assert.deepEqual(
    merged.map((snapshot) => snapshot.id).sort(),
    [
      '000166:month:owner~legacy:2026-06-30:2026-10-31:MA40',
      '000166:month:owner~plan~legacy:2026-06-30:2026-10-31:MA40',
    ].sort(),
  );
});

test('replay reconciliation rejects only a sibling with an unpaired-surrogate plan ID', () => {
  const { mergeAppStorage } = loadStorageModule();
  const replayKey = 'prediction-ma:replay:000166:month:v1';
  const malformedPlanId = `broken-${String.fromCharCode(0xd800)}`;
  const valid = {
    id: '000166:month:plan-a:2026-06-30:2026-10-31:MA40',
    stockCode: '000166',
    period: 'month',
    planId: 'plan-a',
    baseDate: '2026-06-30',
    targetDate: '2026-10-31',
    inputMaWindow: 40,
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
  const malformed = {
    ...valid,
    id: `000166:month:${malformedPlanId}:2026-06-30:2026-11-30:MA40`,
    planId: malformedPlanId,
    targetDate: '2026-11-30',
  };

  const merged = mergeAppStorage(
    { [replayKey]: JSON.stringify([valid, malformed]) },
    { [replayKey]: '[]' },
  );
  const snapshots = JSON.parse(merged[replayKey]);

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].targetDate, '2026-10-31');
  assert.equal(
    snapshots[0].id,
    '000166:month:owner~plan~plan-a:2026-06-30:2026-10-31:MA40',
  );
});

test('unpaired-surrogate plan IDs are rejected before incomplete identity fields are used', () => {
  const { mergeAppStorage } = loadStorageModule();
  const replayKey = 'prediction-ma:replay:000166:month:v1';
  const malformedPlanId = `broken-${String.fromCharCode(0xd800)}`;
  const valid = makeReplaySnapshot(
    '000166:month:plan-a:2026-06-30:2026-10-31:MA40',
    '2026-07-10T00:00:00.000Z',
    4.8,
  );
  const malformed = {
    id: 'malformed-incomplete-snapshot',
    planId: malformedPlanId,
    updatedAt: '2026-07-11T00:00:00.000Z',
  };

  const merged = mergeAppStorage(
    { [replayKey]: JSON.stringify([valid, malformed]) },
    { [replayKey]: '[]' },
  );

  assert.deepEqual(JSON.parse(merged[replayKey]), [valid]);
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

test('bootstrap persists the union of divergent renderer and Electron replay history', async (t) => {
  const { createAppStorageStore } = loadStorageModule();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gupiao-replay-bootstrap-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const store = createAppStorageStore(directory);
  const replayKey = 'prediction-ma:replay:000166:month:v1';
  const sharedId = '000166:month:plan-a:2026-06-30:2026-10-31:MA40';
  const persistedOnlyId = '000166:month:plan-a:2026-06-30:2026-11-30:MA40';
  const rendererOnlyId = '000166:month:plan-b:2026-06-30:2026-12-31:MA40';
  await store.completeLegacyMigration({
    [replayKey]: JSON.stringify([
      makeReplaySnapshot(sharedId, '2026-07-12T00:00:00.000Z', 5.3),
      makeReplaySnapshot(persistedOnlyId, '2026-07-10T00:00:00.000Z', 4.9),
    ]),
  });

  const canonical = await store.bootstrap({
    [replayKey]: JSON.stringify([
      makeReplaySnapshot(sharedId, '2026-07-11T00:00:00.000Z', 5.1),
      makeReplaySnapshot(rendererOnlyId, '2026-07-11T00:00:00.000Z', 5.2),
    ]),
  });
  const snapshots = JSON.parse(canonical[replayKey]);

  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.id).sort(),
    [persistedOnlyId, rendererOnlyId, sharedId].sort(),
  );
  assert.equal(snapshots.find((snapshot) => snapshot.id === sharedId).predictedClose, 5.3);
  assert.deepEqual(await store.load(), canonical);
});
