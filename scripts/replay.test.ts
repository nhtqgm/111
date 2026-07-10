import assert from 'node:assert/strict';
import test from 'node:test';

import type { KLinePoint } from '../src/types.ts';
import type { Ma40ProjectionRow, MaWindow } from '../src/utils/movingAverage.ts';
import * as replay from '../src/utils/replay.ts';
import type { ReplaySnapshot } from '../src/utils/replay.ts';

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

function installStorage(
  storage: MemoryStorage,
  appStorageApi?: {
    bootstrap(snapshot: Record<string, string>): Promise<Record<string, string>>;
    save(snapshot: Record<string, string>): Promise<void>;
  },
) {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { appStorageApi },
  });
}

function makePoint(date: string, close: number): KLinePoint {
  return {
    date,
    open: close,
    close,
    high: close,
    low: close,
    volume: 0,
    amount: 0,
    amplitude: 0,
    pctChange: 0,
    change: 0,
    turnover: 0,
  };
}

function makePointsEnding(endDate: string, count: number) {
  const end = new Date(`${endDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (count - index - 1));
    return makePoint(date.toISOString().slice(0, 10), index + 1);
  });
}

function makeSnapshot(overrides: Partial<ReplaySnapshot> = {}): ReplaySnapshot {
  return {
    schema: replay.REPLAY_SNAPSHOT_SCHEMA,
    id: '000166:month:plan-a:2026-06-30:2026-10-31:MA40',
    stockCode: '000166',
    period: 'month',
    planId: 'plan-a',
    planName: 'Plan A',
    baseDate: '2026-06-30',
    targetDate: '2026-10-31',
    inputMaWindow: 40,
    inputMaValue: 4.83,
    predictedClose: 4.8,
    predictedMaValues: { 5: 4.7, 10: 4.75, 20: 4.8, 40: 4.83, 60: 4.9 },
    baseClose: 4.6,
    baseMaValues: { 5: 4.5, 10: 4.55, 20: 4.6, 40: 4.65, 60: 4.7 },
    note: 'plan note',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

function makeProjectionRow(): Ma40ProjectionRow {
  return {
    targetDate: '2026-07-31',
    predictedMa40: '4.8300',
    predictedMaValues: { 40: '4.8300' },
    note: 'legacy row note',
    actualClose: null,
    derivedClose: 4.8,
    ma40: 4.83,
    maValues: { 5: 4.7, 10: 4.75, 20: 4.8, 40: 4.83, 60: 4.9 },
    calculation: {
      reverse: {
        inputWindow: 40,
        predictedMa: 4.83,
        previousValues: [],
        previousSum: null,
        derivedClose: 4.8,
        reason: null,
      },
      movingAverages: {} as Ma40ProjectionRow['calculation']['movingAverages'],
    },
  };
}

function getReplayStorageKey(stockCode = '000166', period = 'month') {
  return `prediction-ma:replay:${stockCode}:${period}:v1`;
}

function getActualPointResolver() {
  const resolver = (
    replay as typeof replay & {
      findReplayActualPoint?: (
        snapshot: Pick<ReplaySnapshot, 'period' | 'targetDate'>,
        points: KLinePoint[],
      ) => KLinePoint | null;
    }
  ).findReplayActualPoint;
  assert.equal(typeof resolver, 'function');
  return resolver;
}

test.beforeEach(() => {
  installStorage(new MemoryStorage());
});

test('exports one replay actual-point resolver', () => {
  assert.equal(typeof getActualPointResolver(), 'function');
});

test('monthly replay resolves to the latest trading point in the target month', () => {
  const snapshot = makeSnapshot({ period: 'month', targetDate: '2026-10-31' });
  const points = [
    makePoint('2026-10-30', 4.8),
    makePoint('2026-09-30', 4.5),
    makePoint('2026-10-29', 4.7),
  ];

  const actualPoint = getActualPointResolver()(snapshot, points);
  const rows = replay.buildReplayReviewRows([snapshot], points);

  assert.equal(actualPoint?.date, '2026-10-30');
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[0].actualClose, 4.8);
});

test('weekly replay resolves to the latest trading point in the same ISO week', () => {
  const snapshot = makeSnapshot({ period: 'week', targetDate: '2026-07-05' });
  const points = [makePoint('2026-07-02', 4.6), makePoint('2026-07-03', 4.65)];

  const actualPoint = getActualPointResolver()(snapshot, points);
  const rows = replay.buildReplayReviewRows([snapshot], points);

  assert.equal(actualPoint?.date, '2026-07-03');
  assert.equal(rows[0].actualClose, 4.65);
});

test('weekly replay uses the ISO week-year across a calendar-year boundary', () => {
  const snapshot = makeSnapshot({ period: 'week', targetDate: '2027-01-03' });
  const points = [
    makePoint('2026-12-31', 4.65),
    makePoint('2027-01-04', 5.1),
  ];

  const actualPoint = getActualPointResolver()(snapshot, points);

  assert.equal(actualPoint?.date, '2026-12-31');
});

test('daily replay remains exact-date only', () => {
  const snapshot = makeSnapshot({ period: 'day', targetDate: '2026-10-31' });
  const rows = replay.buildReplayReviewRows([snapshot], [makePoint('2026-10-30', 4.8)]);

  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].actualClose, null);
});

test('active filter with no active plan returns no rows', () => {
  const rows = replay.buildReplayReviewRows([makeSnapshot()], []);

  assert.deepEqual(replay.filterReplayRowsByPlan(rows, 'active', null), []);
});

test('a resolved snapshot cannot be overwritten by a later save', () => {
  const existing = makeSnapshot({ predictedClose: 4.8, targetDate: '2026-10-31' });
  const incoming = makeSnapshot({
    predictedClose: 5.1,
    targetDate: '2026-10-31',
    updatedAt: '2026-07-11T00:00:00.000Z',
  });

  const merged = replay.mergeReplaySnapshots(
    [existing],
    [incoming],
    [makePoint('2026-10-30', 4.75)],
  );

  assert.equal(merged[0], existing);
  assert.equal(merged[0].predictedClose, 4.8);
});

test('a pending snapshot is updated without changing createdAt', () => {
  const existing = makeSnapshot({ predictedClose: 4.8, createdAt: 'first' });
  const incoming = makeSnapshot({ predictedClose: 5.1, createdAt: 'second' });

  const merged = replay.mergeReplaySnapshots([existing], [incoming], []);

  assert.equal(merged[0].predictedClose, 5.1);
  assert.equal(merged[0].createdAt, 'first');
});

test('load rejects replay snapshots with explicit conflicting ownership', () => {
  const storage = new MemoryStorage();
  installStorage(storage);
  storage.setItem(
    getReplayStorageKey(),
    JSON.stringify([
      makeSnapshot({ id: 'foreign-stock', stockCode: '600000' }),
      makeSnapshot({ id: 'wrong-period', period: 'day' }),
    ]),
  );

  assert.deepEqual(replay.loadReplaySnapshots('000166', 'month'), []);
});

test('load rejects malformed entries while migrating legacy plain snapshots', () => {
  const storage = new MemoryStorage();
  installStorage(storage);
  const owned = makeSnapshot();
  const legacy = {
    ...makeSnapshot({
      id: '000166:month:plan-a:2026-06-30:2026-11-30:MA40',
      targetDate: '2026-11-30',
    }),
  } as Partial<ReplaySnapshot>;
  delete legacy.stockCode;
  delete legacy.period;
  storage.setItem(
    getReplayStorageKey(),
    JSON.stringify([owned, legacy, null, 'not-a-snapshot', 42, true, []]),
  );

  const loaded = replay.loadReplaySnapshots('000166', 'month');

  assert.deepEqual(
    loaded.map((snapshot) => snapshot.id).sort(),
    [
      '000166:month:owner~plan~plan-a:2026-06-30:2026-10-31:MA40',
      '000166:month:owner~plan~plan-a:2026-06-30:2026-11-30:MA40',
    ],
  );
  const migrated = loaded.find((snapshot) => snapshot.targetDate === '2026-11-30');
  assert.equal(migrated?.stockCode, '000166');
  assert.equal(migrated?.period, 'month');
});

test('load and save reject snapshot IDs that conflict with normalized fields', () => {
  const storage = new MemoryStorage();
  installStorage(storage);
  const key = getReplayStorageKey();
  const conflictingId = makeSnapshot({
    id: '000166:month:plan-b:2026-06-30:2026-10-31:MA40',
  });
  const existingRaw = JSON.stringify([conflictingId]);
  storage.setItem(key, existingRaw);

  assert.deepEqual(replay.loadReplaySnapshots('000166', 'month'), []);
  assert.throws(
    () => replay.saveReplaySnapshots('000166', 'month', [conflictingId]),
    /id/i,
  );
  assert.equal(storage.getItem(key), existingRaw);
});

test('load migrates the supported legacy no-plan snapshot ID to its canonical form', () => {
  const storage = new MemoryStorage();
  installStorage(storage);
  const legacy = makeSnapshot({
    id: '000166:month:2026-06-30:2026-10-31:MA40',
    planId: undefined,
    planName: undefined,
  });
  storage.setItem(getReplayStorageKey(), JSON.stringify([legacy]));

  const loaded = replay.loadReplaySnapshots('000166', 'month');

  assert.equal(loaded.length, 1);
  assert.equal(
    loaded[0].id,
    '000166:month:owner~legacy:2026-06-30:2026-10-31:MA40',
  );
  assert.equal(loaded[0].planId, undefined);
});

test('save migrates all supported legacy no-plan snapshot IDs', async () => {
  const supportedIds = [
    '000166:month:2026-06-30:2026-10-31:MA40',
    '000166:month:legacy:2026-06-30:2026-10-31:MA40',
  ];

  for (const id of supportedIds) {
    const storage = new MemoryStorage();
    installStorage(storage);
    const legacy = makeSnapshot({
      id,
      planId: undefined,
      planName: undefined,
    });

    await replay.saveReplaySnapshots('000166', 'month', [legacy]);

    const saved = JSON.parse(storage.getItem(getReplayStorageKey()) ?? '[]');
    assert.equal(saved.length, 1);
    assert.equal(
      saved[0].id,
      '000166:month:owner~legacy:2026-06-30:2026-10-31:MA40',
    );
  }
});

test('new no-plan snapshots use the canonical legacy ID form', () => {
  const snapshots = replay.createReplaySnapshotsFromProjection({
    stockCode: '000166',
    period: 'month',
    planId: null,
    planName: null,
    planNote: '',
    baseDate: '2026-06-30',
    points: [makePoint('2026-06-30', 4.6)],
    rows: [makeProjectionRow()],
    inputMaWindow: 40,
    existingSnapshots: [],
    now: '2026-07-10T00:00:00.000Z',
  });

  assert.equal(
    snapshots[0].id,
    '000166:month:owner~legacy:2026-06-30:2026-07-31:MA40',
  );
});

test('load migrates the just-introduced no-plan legacy ID to the tagged owner form', () => {
  const storage = new MemoryStorage();
  installStorage(storage);
  const snapshot = makeSnapshot({
    id: '000166:month:legacy:2026-06-30:2026-10-31:MA40',
    planId: undefined,
    planName: undefined,
  });
  storage.setItem(getReplayStorageKey(), JSON.stringify([snapshot]));

  const loaded = replay.loadReplaySnapshots('000166', 'month');

  assert.equal(loaded.length, 1);
  assert.equal(
    loaded[0].id,
    '000166:month:owner~legacy:2026-06-30:2026-10-31:MA40',
  );
});

test('planned and no-plan snapshots use distinct owner namespaces for plan ID legacy', () => {
  const common = {
    stockCode: '000166',
    period: 'month' as const,
    baseDate: '2026-06-30',
    points: [makePoint('2026-06-30', 4.6)],
    rows: [makeProjectionRow()],
    inputMaWindow: 40 as const,
    existingSnapshots: [],
    now: '2026-07-10T00:00:00.000Z',
  };
  const planned = replay.createReplaySnapshotsFromProjection({
    ...common,
    planId: 'legacy',
    planName: 'Legacy Plan',
    planNote: '',
  })[0];
  const noPlan = replay.createReplaySnapshotsFromProjection({
    ...common,
    planId: null,
    planName: null,
    planNote: '',
  })[0];

  assert.equal(
    planned.id,
    '000166:month:owner~plan~legacy:2026-06-30:2026-07-31:MA40',
  );
  assert.equal(
    noPlan.id,
    '000166:month:owner~legacy:2026-06-30:2026-07-31:MA40',
  );
  assert.notEqual(planned.id, noPlan.id);
});

test('plan owner IDs encode plan identifiers inside the canonical segment', () => {
  const snapshots = replay.createReplaySnapshotsFromProjection({
    stockCode: '000166',
    period: 'month',
    planId: 'legacy:alpha beta',
    planName: 'Encoded Plan',
    planNote: '',
    baseDate: '2026-06-30',
    points: [makePoint('2026-06-30', 4.6)],
    rows: [makeProjectionRow()],
    inputMaWindow: 40,
    existingSnapshots: [],
    now: '2026-07-10T00:00:00.000Z',
  });

  assert.equal(
    snapshots[0].id,
    '000166:month:owner~plan~legacy%3Aalpha%20beta:2026-06-30:2026-07-31:MA40',
  );
});

test('load deduplicates canonical snapshot IDs by valid updatedAt regardless of array order', () => {
  const older = makeSnapshot({
    predictedClose: 4.8,
    updatedAt: '2026-07-10T00:00:00.000Z',
  });
  const newer = makeSnapshot({
    predictedClose: 5.1,
    updatedAt: '2026-07-11T00:00:00.000Z',
  });

  const load = (snapshots: ReplaySnapshot[]) => {
    const storage = new MemoryStorage();
    installStorage(storage);
    storage.setItem(getReplayStorageKey(), JSON.stringify(snapshots));
    return replay.loadReplaySnapshots('000166', 'month');
  };
  const forward = load([older, newer]);
  const reverse = load([newer, older]);

  assert.equal(forward.length, 1);
  assert.equal(reverse.length, 1);
  assert.equal(forward[0].predictedClose, 5.1);
  assert.deepEqual(forward, reverse);
});

test('save deduplicates canonical snapshot IDs by valid updatedAt', async () => {
  const storage = new MemoryStorage();
  installStorage(storage);
  const older = makeSnapshot({
    predictedClose: 4.8,
    updatedAt: '2026-07-10T00:00:00.000Z',
  });
  const newer = makeSnapshot({
    predictedClose: 5.1,
    updatedAt: '2026-07-11T00:00:00.000Z',
  });

  await replay.saveReplaySnapshots('000166', 'month', [newer, older]);

  const saved = JSON.parse(storage.getItem(getReplayStorageKey()) ?? '[]');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].predictedClose, 5.1);
});

test('duplicate IDs with unusable updatedAt values have an order-independent fallback', () => {
  const first = makeSnapshot({ predictedClose: 4.8, updatedAt: 'invalid-a' });
  const second = makeSnapshot({ predictedClose: 5.1, updatedAt: 'invalid-b' });

  const load = (snapshots: ReplaySnapshot[]) => {
    const storage = new MemoryStorage();
    installStorage(storage);
    storage.setItem(getReplayStorageKey(), JSON.stringify(snapshots));
    return replay.loadReplaySnapshots('000166', 'month');
  };

  assert.deepEqual(load([first, second]), load([second, first]));
  assert.equal(load([first, second]).length, 1);
});

test('save rejects conflicting replay ownership without changing storage', () => {
  const conflicts = [
    makeSnapshot({ stockCode: '600000' }),
    makeSnapshot({ period: 'day' }),
  ];

  for (const conflict of conflicts) {
    const storage = new MemoryStorage();
    installStorage(storage);
    const key = getReplayStorageKey();
    const existingRaw = JSON.stringify([makeSnapshot({ id: 'existing' })]);
    storage.setItem(key, existingRaw);

    assert.throws(
      () => replay.saveReplaySnapshots('000166', 'month', [conflict]),
      /ownership/i,
    );
    assert.equal(storage.getItem(key), existingRaw);
  }
});

test('save rejects malformed replay entries without changing storage', () => {
  const malformedEntries: unknown[] = [null, 'not-a-snapshot', 42, true, []];

  for (const malformedEntry of malformedEntries) {
    const storage = new MemoryStorage();
    installStorage(storage);
    const key = getReplayStorageKey();
    const existingRaw = JSON.stringify([makeSnapshot({ id: 'existing' })]);
    storage.setItem(key, existingRaw);

    assert.throws(
      () =>
        replay.saveReplaySnapshots(
          '000166',
          'month',
          [malformedEntry] as unknown as ReplaySnapshot[],
        ),
      /plain object/i,
    );
    assert.equal(storage.getItem(key), existingRaw);
  }
});

test('invalid calendar dates never resolve or freeze snapshots for any period', () => {
  for (const period of ['day', 'week', 'month'] as const) {
    const existing = makeSnapshot({
      period,
      baseDate: '2026-02-28',
      targetDate: '2026-02-29',
      predictedClose: 4.8,
    });
    const incoming = makeSnapshot({
      period,
      baseDate: '2026-02-28',
      targetDate: '2026-02-29',
      predictedClose: 5.1,
    });
    const invalidPoint = makePoint('2026-02-29', 4.75);

    assert.equal(getActualPointResolver()(existing, [invalidPoint]), null);
    assert.equal(
      replay.mergeReplaySnapshots([existing], [incoming], [invalidPoint])[0].predictedClose,
      5.1,
    );
  }
});

test('an invalid base date prevents a snapshot from resolving or freezing', () => {
  const existing = makeSnapshot({
    period: 'day',
    baseDate: '2026-02-29',
    targetDate: '2026-03-02',
    predictedClose: 4.8,
  });
  const incoming = makeSnapshot({
    period: 'day',
    baseDate: '2026-02-29',
    targetDate: '2026-03-02',
    predictedClose: 5.1,
  });
  const point = makePoint('2026-03-02', 4.75);

  assert.equal(getActualPointResolver()(existing, [point]), null);
  assert.equal(
    replay.mergeReplaySnapshots([existing], [incoming], [point])[0].predictedClose,
    5.1,
  );
});

test('invalid actual dates are ignored even when their month or ISO week would match', () => {
  const monthly = makeSnapshot({
    period: 'month',
    baseDate: '2026-01-31',
    targetDate: '2026-02-28',
  });
  const weekly = makeSnapshot({
    period: 'week',
    baseDate: '2026-02-22',
    targetDate: '2026-03-01',
  });

  assert.equal(
    getActualPointResolver()(monthly, [makePoint('2026-02-30', 4.75)]),
    null,
  );
  assert.equal(
    getActualPointResolver()(weekly, [makePoint('2026-02-29', 4.75)]),
    null,
  );
});

test('invalid-dated actual points do not contaminate resolved MA values', () => {
  const snapshot = makeSnapshot({
    period: 'day',
    baseDate: '2026-02-20',
    targetDate: '2026-02-27',
  });
  const points = [
    makePoint('2026-02-23', 1),
    makePoint('2026-02-24', 2),
    makePoint('2026-02-29', 100),
    makePoint('2026-02-25', 3),
    makePoint('2026-02-26', 4),
    makePoint('2026-02-27', 5),
  ];

  const row = replay.buildReplayReviewRows([snapshot], points)[0];

  assert.equal(row.actualClose, 5);
  assert.equal(row.maComparisons[5].actual, 3);
});

test('valid leap-day dates resolve normally', () => {
  const snapshot = makeSnapshot({
    period: 'day',
    baseDate: '2024-02-28',
    targetDate: '2024-02-29',
  });
  const point = makePoint('2024-02-29', 4.75);

  assert.equal(getActualPointResolver()(snapshot, [point])?.date, '2024-02-29');
  assert.equal(replay.buildReplayReviewRows([snapshot], [point])[0].status, 'ready');
});

test('load and save reject snapshots with invalid base or target dates', () => {
  const invalidSnapshots = [
    makeSnapshot({
      id: '000166:day:plan-a:2026-02-29:2026-03-02:MA40',
      period: 'day',
      baseDate: '2026-02-29',
      targetDate: '2026-03-02',
    }),
    makeSnapshot({
      id: '000166:day:plan-a:2026-02-28:2026-02-29:MA40',
      period: 'day',
      baseDate: '2026-02-28',
      targetDate: '2026-02-29',
    }),
  ];

  for (const snapshot of invalidSnapshots) {
    const storage = new MemoryStorage();
    installStorage(storage);
    const key = getReplayStorageKey('000166', 'day');
    const existingRaw = JSON.stringify([snapshot]);
    storage.setItem(key, existingRaw);

    assert.deepEqual(replay.loadReplaySnapshots('000166', 'day'), []);
    assert.throws(
      () => replay.saveReplaySnapshots('000166', 'day', [snapshot]),
      /date/i,
    );
    assert.equal(storage.getItem(key), existingRaw);
  }
});

test('snapshot creation rejects invalid base and target calendar dates', () => {
  const args = {
    stockCode: '000166',
    period: 'month' as const,
    planId: 'plan-a',
    planName: 'Plan A',
    planNote: '',
    points: [makePoint('2026-01-31', 4.6)],
    rows: [makeProjectionRow()],
    inputMaWindow: 40 as const,
    existingSnapshots: [],
    now: '2026-01-10T00:00:00.000Z',
  };

  assert.throws(
    () => replay.createReplaySnapshotsFromProjection({ ...args, baseDate: '2026-02-29' }),
    /date/i,
  );
  assert.throws(
    () =>
      replay.createReplaySnapshotsFromProjection({
        ...args,
        baseDate: '2026-01-31',
        rows: [{ ...makeProjectionRow(), targetDate: '2026-02-29' }],
      }),
    /date/i,
  );
});

test('saving replay snapshots queues Electron persistence', async () => {
  const storage = new MemoryStorage();
  const saved: Record<string, string>[] = [];
  installStorage(storage, {
    async bootstrap(snapshot) {
      return snapshot;
    },
    async save(snapshot) {
      saved.push(snapshot);
    },
  });

  await replay.saveReplaySnapshots('000166', 'month', [makeSnapshot()]);

  assert.equal(saved.length, 1);
  assert.deepEqual(JSON.parse(saved[0][getReplayStorageKey()]), [
    {
      ...makeSnapshot(),
      id: '000166:month:owner~plan~plan-a:2026-06-30:2026-10-31:MA40',
    },
  ]);
});

test('snapshot captures the plan note instead of a legacy row note', () => {
  const snapshots = replay.createReplaySnapshotsFromProjection({
    stockCode: '000166',
    period: 'month',
    planId: 'plan-a',
    planName: 'Plan A',
    planNote: 'plan-level note',
    baseDate: '2026-06-30',
    points: [makePoint('2026-06-30', 4.6)],
    rows: [makeProjectionRow()],
    inputMaWindow: 40,
    existingSnapshots: [],
    now: '2026-07-10T00:00:00.000Z',
  });

  assert.equal(snapshots[0].note, 'plan-level note');
});

test('actual close and every actual MA use the same resolved trading date', () => {
  const points = makePointsEnding('2026-10-30', 65);
  const snapshot = makeSnapshot({ period: 'month', targetDate: '2026-10-31' });

  const row = replay.buildReplayReviewRows([snapshot], points)[0];

  assert.equal(row.actualClose, points.at(-1)?.close);
  for (const windowSize of [5, 10, 20, 40, 60] as MaWindow[]) {
    const window = points.slice(-windowSize);
    const expected = window.reduce((total, point) => total + point.close, 0) / windowSize;
    assert.equal(row.maComparisons[windowSize].actual, expected);
  }
});
