# Prediction Plan and Replay Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the stable `main` branch persistence/update behavior into the preview branch and make prediction plans plus replay safe across stock, period, browser, and Electron boundaries.

**Architecture:** Merge `main` first, then keep plan rules in `predictionPlans.ts`, replay rules in `replay.ts`, Electron synchronization in `electronStorage.ts`, and timer mechanics in a small `stableAutosave.ts` utility. `App.tsx` remains the coordinator and derives the visible prediction rows from the active plan.

**Tech Stack:** React 19, TypeScript 5.9, Vite 8, Electron 22, ECharts 6, Node built-in test runner, GitHub Actions/Pages.

---

## File Map

- Modify `src/App.tsx`: integrate stable update/backup behavior, coordinate plans, replay, autosave, context switching, filters, and UI limits.
- Modify `src/styles.css`: preserve the compact stable layout and add only the plan/replay controls needed by the integrated UI.
- Modify `src/utils/predictionPlans.ts`: ownership validation, non-destructive limits, plan import/export, storage synchronization.
- Modify `src/utils/replay.ts`: ownership validation, period matching, frozen resolved snapshots, note capture, storage synchronization, filter semantics.
- Create `src/utils/stableAutosave.ts`: one stable interval whose callback can be refreshed without restarting the interval.
- Modify `src/utils/electronStorage.ts`: retain stable `main` behavior and expose testable synchronization used by plan/replay writes.
- Modify `src/main.tsx`, `electron/app-storage.cjs`, `electron/main.cjs`, `electron/preload.cjs`, and `src/electron.d.ts`: take the stable versions from `main` unless merge conflict resolution is required.
- Modify `package.json`, `package-lock.json`, `tsconfig.json`, `public/update.json`, and `public/version.json`: take version 0.2.8 and stable scripts/configuration from `main` while preserving preview TypeScript inclusions.
- Modify `.github/workflows/pages.yml` and `.github/workflows/preview-pages.yml`: preserve combined Pages publishing and preview isolation.
- Create `scripts/prediction-plans.test.ts`: plan ownership, limits, cloning, migration, import/export, and sync tests.
- Create `scripts/replay.test.ts`: period matching, lifecycle, ownership, filters, notes, and sync tests.
- Create `scripts/stable-autosave.test.ts`: interval stability and callback freshness tests.
- Modify `scripts/verify-ma-periods.mjs`: preserve all existing MA checks and integrated feature checks.

### Task 1: Add an integration guard and merge the stable baseline

**Files:**
- Create: `scripts/preview-integration.test.ts`
- Modify through merge: files changed on `main`
- Resolve: `src/App.tsx`
- Resolve: `src/styles.css`
- Resolve: `.github/workflows/pages.yml`
- Resolve: `tsconfig.json`

- [ ] **Step 1: Write the failing stable-baseline test**

Create `scripts/preview-integration.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('preview branch exposes Electron storage and update metadata from main', async () => {
  const storage = await import('../src/utils/electronStorage.ts').catch(() => ({}));
  assert.equal(typeof storage.collectAppStorage, 'function');
  assert.equal(typeof storage.queueElectronStorageSync, 'function');

  const update = JSON.parse(
    await readFile(new URL('../public/update.json', import.meta.url), 'utf8'),
  );
  assert.equal(typeof update.version, 'string');
  assert.match(update.version, /^0\.2\.8$/);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node --test scripts/preview-integration.test.ts
```

Expected: failure because the preview branch does not yet contain `src/utils/electronStorage.ts` or the 0.2.8 update metadata.

- [ ] **Step 3: Commit the failing guard**

```powershell
git add scripts/preview-integration.test.ts
git commit -m "test: guard preview stable baseline"
```

- [ ] **Step 4: Merge `main` without touching the main worktree**

```powershell
git merge --no-ff main
```

Resolve conflicts with these rules:

```text
package/version/update/storage/Electron behavior: main
plan management/replay UI and utilities: preview
compact top layout and current chart/table layout: main plus preview controls
Pages combined artifact and branch-isolated preview path: preview workflow behavior
TypeScript JSON module support and all included source files: union of both branches
```

The final `src/App.tsx` import group must contain both stable and preview dependencies:

```ts
import packageJson from '../package.json';
import { persistElectronStorage } from './utils/electronStorage';
import {
  copyPredictionPlan,
  createEmptyPlan,
  createPredictionPlanExport,
  hasPredictionPlanCapacity,
  importPredictionPlan,
  loadPredictionPlans,
  normalizePredictionPlanExport,
  renamePredictionPlan,
  resolveActivePlanId,
  saveActivePlanId,
  savePredictionPlans,
  type PredictionPlan,
} from './utils/predictionPlans';
import {
  buildReplayReviewRows,
  createReplaySnapshotsFromProjection,
  createReplaySnapshotsFromProjection,
  filterReplayRowsByPlan,
  loadReplaySnapshots,
  mergeReplaySnapshots,
  saveReplaySnapshots,
  summarizeReplayRows,
  type ReplayPlanFilter,
  type ReplayReviewRow,
  type ReplaySnapshot,
} from './utils/replay';
```

- [ ] **Step 5: Run the baseline tests and build**

```powershell
npm run test:storage
node --test scripts/preview-integration.test.ts
npm run verify:ma
npm run build
```

Expected: all commands exit 0. Conflict markers must not remain:

```powershell
rg -n "^(<<<<<<<|=======|>>>>>>>)" . --glob '!node_modules/**' --glob '!dist/**'
```

Expected: no matches.

- [ ] **Step 6: Commit the merge resolution**

```powershell
git add src/App.tsx src/styles.css .github/workflows/pages.yml tsconfig.json
git commit
```

### Task 2: Make plan storage ownership-safe and non-destructive

**Files:**
- Create: `scripts/prediction-plans.test.ts`
- Modify: `src/utils/predictionPlans.ts`

- [ ] **Step 1: Write failing ownership and limit tests**

Create `scripts/prediction-plans.test.ts` with these imports and helpers:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { KLinePoint } from '../src/types.ts';
import {
  getPredictionPlansKey,
  hasPredictionPlanCapacity,
  loadPredictionPlans,
  normalizePredictionPlanExport,
  saveActivePlanId,
  savePredictionPlans,
  type PredictionPlan,
} from '../src/utils/predictionPlans.ts';

class MemoryStorage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const points: KLinePoint[] = [
  makePoint('2026-05-29', 4.50),
  makePoint('2026-06-30', 4.60),
];

function makePoint(date: string, close: number): KLinePoint {
  return {
    date, open: close, close, high: close, low: close,
    volume: 0, amount: 0, amplitude: 0, pctChange: 0, change: 0, turnover: 0,
  };
}

function makePlan(name: string): PredictionPlan {
  return {
    id: name,
    name,
    stockCode: '000166',
    period: 'month',
    inputMaWindow: 40,
    predictions: [],
    note: '',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    source: 'manual',
  };
}

test.beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(), configurable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: { appStorageApi: undefined }, configurable: true,
  });
});
```

Add these tests:

```ts
test('load rejects a plan that explicitly belongs to another stock', () => {
  const key = getPredictionPlansKey('000166', 'month');
  localStorage.setItem(key, JSON.stringify([{
    ...makePlan('wrong-owner'),
    stockCode: '600000',
    period: 'month',
  }]));

  const loaded = loadPredictionPlans('000166', 'month', '2026-06-30', points, 2);
  assert.equal(loaded.plans.some((plan) => plan.name === 'wrong-owner'), false);
  assert.equal(loaded.plans.every((plan) => plan.stockCode === '000166'), true);
});

test('loading more than 30 existing plans never silently truncates them', () => {
  const plans = Array.from({ length: 31 }, (_, index) => makePlan(`plan-${index}`));
  localStorage.setItem(getPredictionPlansKey('000166', 'month'), JSON.stringify(plans));

  const loaded = loadPredictionPlans('000166', 'month', '2026-06-30', points, 2);
  assert.equal(loaded.plans.length, 31);
  assert.equal(hasPredictionPlanCapacity(loaded.plans), false);
});

test('plan export rejects conflicting inner ownership', () => {
  const value = {
    version: 'prediction-plan-v1',
    exportedAt: '2026-07-10T00:00:00.000Z',
    stockCode: '000166',
    period: 'month',
    baseDate: '2026-06-30',
    plan: { ...makePlan('bad'), stockCode: '600000' },
  };

  assert.equal(normalizePredictionPlanExport(value), null);
});
```

Add the synchronization test:

```ts
test('plan and active-plan writes queue Electron persistence', async () => {
  const saved: Record<string, string>[] = [];
  window.appStorageApi = {
    async bootstrap(snapshot) { return snapshot; },
    async save(snapshot) { saved.push(snapshot); },
  };

  await savePredictionPlans('000166', 'month', [makePlan('plan-a')]);
  await saveActivePlanId('000166', 'month', 'plan-a');

  assert.equal(saved.length >= 1, true);
  assert.equal(
    JSON.parse(saved.at(-1)?.[getPredictionPlansKey('000166', 'month')] ?? '[]')[0].id,
    'plan-a',
  );
});
```

- [ ] **Step 2: Run the tests and verify RED**

```powershell
node --test scripts/prediction-plans.test.ts
```

Expected failures: wrong-owner data is reassigned, 31 plans become 30,
`hasPredictionPlanCapacity` is missing, conflicting export ownership is
accepted, and storage writes do not trigger Electron synchronization.

- [ ] **Step 3: Implement explicit ownership validation**

Add these rules to `src/utils/predictionPlans.ts`:

```ts
export function hasPredictionPlanCapacity(plans: PredictionPlan[]) {
  return plans.length < PLAN_LIMIT;
}

function hasConflictingPlanOwnership(
  value: unknown,
  stockCode: string,
  period: PeriodType,
) {
  const candidate = value as Partial<PredictionPlan> | null;
  if (!candidate || typeof candidate !== 'object') return true;
  if (
    typeof candidate.stockCode === 'string' &&
    normalizeStockCode(candidate.stockCode) !== normalizeStockCode(stockCode)
  ) return true;
  if (candidate.period !== undefined && candidate.period !== period) return true;
  return false;
}
```

Filter explicit conflicts before normalization. Remove `limitPlans` from load
and save paths. Keep `PLAN_LIMIT` only as a creation/import guard. Make
`savePredictionPlans` throw when any supplied plan conflicts with the target
bucket instead of dropping or rewriting it.

Validate both the export envelope and `candidate.plan` ownership in
`normalizePredictionPlanExport`.

- [ ] **Step 4: Synchronize plan and active-plan writes to Electron**

Import and call the queue after local writes:

```ts
import { queueElectronStorageSync } from './electronStorage.ts';

export function saveActivePlanId(stockCode: string, period: PeriodType, activePlanId: string) {
  localStorage.setItem(getActivePlanKey(stockCode, period), activePlanId);
  return queueElectronStorageSync();
}

export function savePredictionPlans(
  stockCode: string,
  period: PeriodType,
  plans: PredictionPlan[],
) {
  // validate and write the full bucket without truncation
  localStorage.setItem(getPredictionPlansKey(stockCode, period), JSON.stringify(plans));
  return queueElectronStorageSync();
}
```

- [ ] **Step 5: Verify GREEN**

```powershell
node --test scripts/prediction-plans.test.ts
```

Expected: all plan tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/utils/predictionPlans.ts scripts/prediction-plans.test.ts
git commit -m "fix: isolate prediction plan storage"
```

### Task 3: Match replay data by period and freeze resolved snapshots

**Files:**
- Create: `scripts/replay.test.ts`
- Modify: `src/utils/replay.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write failing period, filter, lifecycle, and ownership tests**

Create `scripts/replay.test.ts` with these imports and helpers:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { KLinePoint } from '../src/types.ts';
import {
  REPLAY_SNAPSHOT_SCHEMA,
  buildReplayReviewRows,
  filterReplayRowsByPlan,
  loadReplaySnapshots,
  mergeReplaySnapshots,
  saveReplaySnapshots,
  type ReplaySnapshot,
} from '../src/utils/replay.ts';
import type { Ma40ProjectionRow } from '../src/utils/movingAverage.ts';

class MemoryStorage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function makePoint(date: string, close: number): KLinePoint {
  return {
    date, open: close, close, high: close, low: close,
    volume: 0, amount: 0, amplitude: 0, pctChange: 0, change: 0, turnover: 0,
  };
}

function makeSnapshot(overrides: Partial<ReplaySnapshot> = {}): ReplaySnapshot {
  return {
    schema: REPLAY_SNAPSHOT_SCHEMA,
    id: '000166:month:plan-a:2026-06-30:2026-10-31:MA40',
    stockCode: '000166',
    period: 'month',
    planId: 'plan-a',
    planName: 'Plan A',
    baseDate: '2026-06-30',
    targetDate: '2026-10-31',
    inputMaWindow: 40,
    inputMaValue: 4.83,
    predictedClose: 4.80,
    predictedMaValues: { 5: 4.7, 10: 4.75, 20: 4.8, 40: 4.83, 60: 4.9 },
    baseClose: 4.6,
    baseMaValues: { 5: 4.5, 10: 4.55, 20: 4.6, 40: 4.65, 60: 4.7 },
    note: 'plan note',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

test.beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(), configurable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: { appStorageApi: undefined }, configurable: true,
  });
});
```

Add these tests:

```ts
test('monthly replay matches the final trading date in the target month', () => {
  const snapshot = makeSnapshot({ period: 'month', targetDate: '2026-10-31' });
  const rows = buildReplayReviewRows([snapshot], [
    makePoint('2026-09-30', 4.50),
    makePoint('2026-10-29', 4.70),
    makePoint('2026-10-30', 4.80),
  ]);
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[0].actualClose, 4.80);
});

test('weekly replay matches the final trading date in the same market week', () => {
  const snapshot = makeSnapshot({ period: 'week', targetDate: '2026-07-03' });
  const rows = buildReplayReviewRows([snapshot], [
    makePoint('2026-07-02', 4.60),
    makePoint('2026-07-03', 4.65),
  ]);
  assert.equal(rows[0].actualClose, 4.65);
});

test('active filter with no active plan returns no rows', () => {
  const rows = buildReplayReviewRows([makeSnapshot()], []);
  assert.deepEqual(filterReplayRowsByPlan(rows, 'active', null), []);
});

test('a resolved snapshot cannot be overwritten by a later save', () => {
  const existing = makeSnapshot({ predictedClose: 4.80, targetDate: '2026-10-31' });
  const incoming = makeSnapshot({ predictedClose: 5.10, targetDate: '2026-10-31' });
  const merged = mergeReplaySnapshots(
    [existing],
    [incoming],
    [makePoint('2026-10-30', 4.75)],
  );
  assert.equal(merged[0].predictedClose, 4.80);
});

test('a pending snapshot is updated without changing createdAt', () => {
  const existing = makeSnapshot({ predictedClose: 4.80, createdAt: 'first' });
  const incoming = makeSnapshot({ predictedClose: 5.10, createdAt: 'second' });
  const merged = mergeReplaySnapshots([existing], [incoming], []);
  assert.equal(merged[0].predictedClose, 5.10);
  assert.equal(merged[0].createdAt, 'first');
});
```

Add explicit ownership and synchronization tests:

```ts
test('load rejects replay snapshots owned by another stock', () => {
  localStorage.setItem(
    'prediction-ma:replay:000166:month:v1',
    JSON.stringify([makeSnapshot({ stockCode: '600000' })]),
  );
  assert.deepEqual(loadReplaySnapshots('000166', 'month'), []);
});

test('saving replay snapshots queues Electron persistence', async () => {
  const saved: Record<string, string>[] = [];
  window.appStorageApi = {
    async bootstrap(snapshot) { return snapshot; },
    async save(snapshot) { saved.push(snapshot); },
  };
  await saveReplaySnapshots('000166', 'month', [makeSnapshot()]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]['prediction-ma:replay:000166:month:v1'] !== undefined, true);
});
```

Add the note-capture test:

```ts
test('snapshot captures the plan note instead of a legacy row note', () => {
  const row = {
    targetDate: '2026-07-31',
    predictedMa40: '4.8300',
    predictedMaValues: { 40: '4.8300' },
    note: 'legacy row note',
    actualClose: null,
    derivedClose: 4.80,
    ma40: 4.83,
    maValues: { 5: 4.7, 10: 4.75, 20: 4.8, 40: 4.83, 60: 4.9 },
    calculation: {
      reverse: { inputWindow: 40, predictedMa: 4.83 },
      movingAverages: {},
    },
  } as Ma40ProjectionRow;

  const snapshots = createReplaySnapshotsFromProjection({
    stockCode: '000166',
    period: 'month',
    planId: 'plan-a',
    planName: 'Plan A',
    planNote: 'plan-level note',
    baseDate: '2026-06-30',
    points: [makePoint('2026-06-30', 4.60)],
    rows: [row],
    inputMaWindow: 40,
    existingSnapshots: [],
    now: '2026-07-10T00:00:00.000Z',
  });

  assert.equal(snapshots[0].note, 'plan-level note');
});
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test scripts/replay.test.ts
```

Expected failures: exact-date matching leaves month/week rows pending, active
filter returns all rows, resolved snapshots are overwritten, wrong-owner
snapshots load, and row notes are used instead of the plan note.

- [ ] **Step 3: Implement one actual-point resolver**

Add and use a single resolver for both close and MA lookup:

```ts
export function findReplayActualPoint(
  snapshot: Pick<ReplaySnapshot, 'period' | 'targetDate'>,
  points: KLinePoint[],
) {
  const matches = points.filter((point) => isSameReplayPeriod(
    point.date,
    snapshot.targetDate,
    snapshot.period,
  ));
  return matches.sort((a, b) => a.date.localeCompare(b.date)).at(-1) ?? null;
}

function isSameReplayPeriod(actualDate: string, targetDate: string, period: PeriodType) {
  if (period === 'day') return actualDate === targetDate;
  if (period === 'month') return actualDate.slice(0, 7) === targetDate.slice(0, 7);
  return getIsoWeekKey(actualDate) === getIsoWeekKey(targetDate);
}
```

In `buildReplayReviewRows`, obtain `actualPoint` once, use
`actualPoint?.close`, and obtain every actual MA value using
`actualPoint?.date`. Never combine close and MA values from different points.

- [ ] **Step 4: Freeze resolved snapshots and keep pending updates mutable**

Change the merge signature and rule:

```ts
export function mergeReplaySnapshots(
  existingSnapshots: ReplaySnapshot[],
  incomingSnapshots: ReplaySnapshot[],
  points: KLinePoint[],
) {
  const byId = new Map(existingSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  for (const incoming of incomingSnapshots) {
    const existing = byId.get(incoming.id);
    if (existing && findReplayActualPoint(existing, points)) continue;
    byId.set(incoming.id, {
      ...incoming,
      createdAt: existing?.createdAt ?? incoming.createdAt,
    });
  }
  return Array.from(byId.values()).sort(compareSnapshots);
}
```

Pass `data.points` from `App.tsx`.

- [ ] **Step 5: Correct ownership, notes, filter, and storage sync**

Implement these concrete rules:

```ts
if (filter === 'active') {
  return activePlanId ? rows.filter((row) => row.planId === activePlanId) : [];
}
```

Reject explicit snapshot ownership conflicts before normalization. Add
`planNote` to `createReplaySnapshotsFromProjection` arguments and assign:

```ts
note: planNote ?? '',
```

After replay localStorage writes, return `queueElectronStorageSync()`.

- [ ] **Step 6: Verify GREEN and commit**

```powershell
node --test scripts/replay.test.ts
git add src/utils/replay.ts src/App.tsx scripts/replay.test.ts
git commit -m "fix: stabilize replay matching and history"
```

Expected: all replay tests pass.

### Task 4: Use a stable autosave interval and flush before context changes

**Files:**
- Create: `src/utils/stableAutosave.ts`
- Create: `scripts/stable-autosave.test.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write the failing scheduler test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStableAutosave,
  runWorkspaceTransition,
} from '../src/utils/stableAutosave.ts';

test('autosave keeps one interval and invokes the latest callback', () => {
  let scheduled: (() => void) | null = null;
  let setCount = 0;
  let clearCount = 0;
  const calls: string[] = [];
  const scheduler = createStableAutosave(
    () => calls.push('first'),
    30000,
    {
      setInterval(callback) { setCount += 1; scheduled = callback; return 7; },
      clearInterval(id) { assert.equal(id, 7); clearCount += 1; },
    },
  );

  scheduler.update(() => calls.push('latest'));
  scheduled?.();
  scheduler.dispose();

  assert.equal(setCount, 1);
  assert.equal(clearCount, 1);
  assert.deepEqual(calls, ['latest']);
});

test('workspace transition flushes dirty state before changing context', () => {
  const calls: string[] = [];
  runWorkspaceTransition(true, () => calls.push('save'), () => calls.push('change'));
  assert.deepEqual(calls, ['save', 'change']);
});
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test scripts/stable-autosave.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the scheduler**

Create `src/utils/stableAutosave.ts`:

```ts
export interface StableIntervalApi {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(id: unknown): void;
}

export function createStableAutosave(
  initialCallback: () => void,
  intervalMs: number,
  api: StableIntervalApi,
) {
  let callback = initialCallback;
  const intervalId = api.setInterval(() => callback(), intervalMs);
  return {
    update(nextCallback: () => void) { callback = nextCallback; },
    dispose() { api.clearInterval(intervalId); },
  };
}

export function runWorkspaceTransition(
  hasUnsavedChanges: boolean,
  flush: () => void,
  change: () => void,
) {
  if (hasUnsavedChanges) flush();
  change();
}
```

- [ ] **Step 4: Integrate one scheduler instance in React**

In `App.tsx`, create the scheduler only once and refresh its callback after
every render:

```ts
const autosaveRef = useRef<ReturnType<typeof createStableAutosave> | null>(null);

useEffect(() => {
  const scheduler = createStableAutosave(
    () => saveCurrentWorkspace({ notice: 'auto' }),
    30000,
    {
      setInterval: (callback, delay) => window.setInterval(callback, delay),
      clearInterval: (id) => window.clearInterval(id as number),
    },
  );
  autosaveRef.current = scheduler;
  return () => scheduler.dispose();
}, []);

useEffect(() => {
  autosaveRef.current?.update(() => saveCurrentWorkspace({ notice: 'auto' }));
});
```

Remove the dependency-driven interval effect.

- [ ] **Step 5: Flush dirty state before stock, period, or plan changes**

Extend notice type with `silent`, suppress toast for silent saves, and route UI
changes through these handlers:

```ts
function flushBeforeContextChange() {
  if (hasUnsavedChanges) saveCurrentWorkspace({ force: true, notice: 'silent' });
}

function changePeriod(nextPeriod: PeriodType) {
  if (nextPeriod === period) return;
  runWorkspaceTransition(hasUnsavedChanges, flushBeforeContextChange, () => {
    setPeriod(nextPeriod);
  });
}

function loadStockCode() {
  runWorkspaceTransition(hasUnsavedChanges, flushBeforeContextChange, () => {
    setQueryCode(stockCode);
  });
}

function selectActivePlan(planId: string) {
  if (!plans.some((plan) => plan.id === planId) || planId === activePlanId) return;
  runWorkspaceTransition(hasUnsavedChanges, flushBeforeContextChange, () => {
    setActivePlanId(planId);
    if (data) void saveActivePlanId(data.code, period, planId);
  });
}
```

- [ ] **Step 6: Verify GREEN and commit**

```powershell
node --test scripts/stable-autosave.test.ts
npm run build
git add src/utils/stableAutosave.ts scripts/stable-autosave.test.ts src/App.tsx
git commit -m "fix: keep autosave stable across edits"
```

### Task 5: Repair plan/replay UI state and expose both export modes

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Extend: `scripts/prediction-plans.test.ts`
- Extend: `scripts/replay.test.ts`

- [ ] **Step 1: Add failing pure-state tests**

Export and test a replay-filter validator:

```ts
test('stale replay plan filter falls back to the active plan', () => {
  assert.equal(
    resolveReplayPlanFilter('plan:deleted', 'current', new Set(['current']), false),
    'active',
  );
});
```

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --test scripts/prediction-plans.test.ts scripts/replay.test.ts
```

Expected: `resolveReplayPlanFilter` is missing.

- [ ] **Step 3: Make current plan names authoritative**

Build replay selector names in this order:

```ts
const namesByPlanId = new Map(plans.map((plan) => [plan.id, plan.name]));
for (const row of replayRows) {
  if (row.planId && !namesByPlanId.has(row.planId)) {
    namesByPlanId.set(row.planId, row.planName?.trim() || '历史方案');
  }
}
```

Validate `replayPlanFilter` whenever stock, period, plan options, or active plan
changes. Clear replay detail selection when the validated filter removes it.

Implement the validator in `src/utils/replay.ts`:

```ts
export function resolveReplayPlanFilter(
  filter: ReplayPlanFilter,
  activePlanId: string | null,
  knownPlanIds: ReadonlySet<string>,
  hasLegacyRows: boolean,
): ReplayPlanFilter {
  const fallback: ReplayPlanFilter = activePlanId ? 'active' : 'all';
  if (filter === 'all') return 'all';
  if (filter === 'active') return activePlanId ? 'active' : 'all';
  if (filter === 'legacy') return hasLegacyRows ? 'legacy' : fallback;
  return knownPlanIds.has(filter.slice('plan:'.length)) ? filter : fallback;
}
```

- [ ] **Step 4: Enforce the visible plan limit**

At the start of create, duplicate, and plan-import handlers:

```ts
if (!hasPredictionPlanCapacity(plans)) {
  showToast(`每只股票的每个周期最多保留 ${PLAN_LIMIT} 个方案，请先删除一个方案`, 'warning');
  return;
}
```

Import `PLAN_LIMIT`. Existing buckets above the limit remain visible but cannot
add another plan.

- [ ] **Step 5: Separate current-plan export from full backup**

Keep the existing full-backup button labeled `导出全部数据`. Add a separate
button in the plan toolbar:

```tsx
<button type="button" className="ghost compact" onClick={exportPredictions}>
  导出当前方案
</button>
```

Use `packageJson.version` in both export envelopes instead of a hard-coded
version. Full backup import continues to replace only application-owned keys
and then synchronizes them to Electron before reload.

Handle asynchronous Electron sync failures without discarding in-memory or
browser-local data:

```ts
const replayWrite = mergedSnapshots
  ? saveReplaySnapshots(data.code, period, mergedSnapshots)
  : Promise.resolve();
void Promise.all([
  savePredictionPlans(data.code, period, plans),
  saveActivePlanId(data.code, period, activePlanId),
  replayWrite,
]).catch(() => {
  showToast('数据已保存在当前页面，但 EXE 持久化失败，请再次点击保存', 'warning');
});
```

- [ ] **Step 6: Stop mirroring new notes into every row**

Use:

```ts
function updateNote(value: string) {
  updateActivePlan((plan) => ({ ...plan, note: value }));
}
```

When resetting rows, keep `plan.note` only on the plan. Legacy row notes remain
readable during migration but are not rewritten.

- [ ] **Step 7: Verify focused tests, build, and commit**

```powershell
node --test scripts/prediction-plans.test.ts scripts/replay.test.ts
npm run build
git add src/App.tsx src/styles.css src/utils/predictionPlans.ts src/utils/replay.ts scripts/prediction-plans.test.ts scripts/replay.test.ts
git commit -m "fix: align plan and replay workspace controls"
```

### Task 6: Verify storage, MA calculations, migration, and backups together

**Files:**
- Modify: `scripts/app-storage.test.cjs`
- Modify: `scripts/electron-storage.test.ts`
- Modify: `scripts/verify-ma-periods.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add failing integrated-storage cases**

Add a test snapshot containing all new key families:

```ts
const snapshot = {
  'prediction-ma:plans:000166:month:v1': '[{"id":"plan-a"}]',
  'prediction-ma:active-plan:000166:month:v1': 'plan-a',
  'prediction-ma:replay:000166:month:v1': '[{"id":"replay-a"}]',
};
```

Add this case to `scripts/electron-storage.test.ts`:

```ts
test('plan and replay buckets survive collection and restore together', async () => {
  const { collectAppStorage, restoreAppStorage } = await loadStorageModule();
  const storage = new MemoryStorage();
  Object.entries(snapshot).forEach(([key, value]) => storage.setItem(key, value));
  storage.setItem('unrelated', 'keep');

  assert.deepEqual(collectAppStorage(storage), snapshot);
  restoreAppStorage(storage, snapshot);

  assert.deepEqual(collectAppStorage(storage), snapshot);
  assert.equal(storage.getItem('unrelated'), 'keep');
});
```

Add this case to `scripts/app-storage.test.cjs`:

```js
test('Electron store persists plan and replay buckets in one snapshot', async (t) => {
  const { createAppStorageStore } = loadStorageModule();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gupiao-plan-replay-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const store = createAppStorageStore(directory);
  await store.replace(snapshot);

  assert.deepEqual(await store.load(), snapshot);
});
```

- [ ] **Step 2: Run the complete storage suite and verify RED or existing coverage**

```powershell
npm run test:storage
```

If a new assertion already passes because the prefix policy covers it, retain
the test as regression coverage and continue. Any actual failure must be fixed
at the storage boundary rather than special-cased in `App.tsx`.

- [ ] **Step 3: Extend MA verification without changing formulas**

Keep the established rule for every MA window:

```text
MA(N) = (current derived close + previous N-1 individual closes) / N
derived close = predicted MA(N) * N - previous N-1 individual closes
```

Call `verifyPlanProjectionConsistency()` from `main()` and add:

```js
function verifyPlanProjectionConsistency() {
  const baseDate = '2026-06-30';
  const points = makeMonthEndsEnding(baseDate, 80);
  const rows = generatePredictionRows(points, 'month', baseDate, 1).map((row) => ({
    ...row,
    predictedMaValues: { 40: '4.8300' },
  }));
  const planA = createDefaultPlan('000166', 'month', rows, 'manual');
  const planB = copyPredictionPlan(planA, [planA]);
  const projectionA = buildMa40Projection(points, planA.predictions, baseDate, 40);
  const projectionB = buildMa40Projection(points, planB.predictions, baseDate, 40);

  assertAlmostEqual(
    projectionA.rows[0].derivedClose,
    projectionB.rows[0].derivedClose,
    'plan identity must not change reverse close math',
  );
  for (const windowSize of MA_WINDOWS) {
    assertAlmostEqual(
      projectionA.rows[0].maValues[windowSize],
      projectionB.rows[0].maValues[windowSize],
      `plan identity must not change MA${windowSize}`,
    );
  }
}
```

Update existing replay calls to pass `planNote` and pass the real points array
as the third argument to `mergeReplaySnapshots`. Keep the assertion that every
saved `predictedMaValues` entry equals the corresponding projection row value.

- [ ] **Step 4: Run all non-browser verification**

Set the final storage script in `package.json` after every referenced test file
exists:

```json
"test:storage": "node --test scripts/app-storage.test.cjs scripts/electron-storage.test.ts scripts/preview-integration.test.ts scripts/prediction-plans.test.ts scripts/replay.test.ts scripts/stable-autosave.test.ts"
```

Then run:

```powershell
npm run test:storage
npm run verify:ma
npm run build
```

Expected: zero failed tests and build exit code 0.

- [ ] **Step 5: Commit**

```powershell
git add scripts package.json package-lock.json
git commit -m "test: cover integrated plan replay persistence"
```

### Task 7: Perform browser regression testing at desktop and mobile widths

**Files:**
- No production file unless a browser test reveals a reproducible defect
- Store temporary screenshots/logs under `F:\codexCache\tmp`

- [ ] **Step 1: Start a clean preview server**

```powershell
npm run dev -- --host 127.0.0.1 --port 4187
```

Expected: Vite reports `http://127.0.0.1:4187/`.

- [ ] **Step 2: Verify the desktop workflow with Playwright**

At 1440x900:

```text
load 000166 month K
enter MA40 4.8300 in the first forecast row
confirm derived close and MA5/10/20/40/60 are populated
create a second plan and verify the first plan retains its value
copy, rename, switch, and delete a plan
manually save and confirm one pending replay record
save the same pending forecast again and confirm the record count does not grow
change the forecast value and confirm the pending record updates
filter replay by current, all, explicit plan, and legacy when available
export current plan and export full backup through distinct controls
refresh and confirm active plan, values, notes, and replay records remain
```

- [ ] **Step 3: Verify period and stock isolation**

```text
switch month to week and confirm a separate plan bucket
switch back to month and confirm the original active plan and values
load another stock code and confirm no 000166 plans or replay rows appear
return to 000166 and confirm its data remains
```

- [ ] **Step 4: Verify mobile layout**

At 390x844, confirm no incoherent overlap, the compact header remains usable,
the plan toolbar scrolls or wraps without clipping text, the prediction table
can be expanded, and the replay modal remains closable and scrollable.

- [ ] **Step 5: Capture evidence and stop all sessions**

Save screenshots under:

```text
F:\codexCache\tmp\gupiao-plan-replay-desktop.png
F:\codexCache\tmp\gupiao-plan-replay-mobile.png
```

Stop the Vite process and close the Playwright session before continuing.

### Task 8: Final review, push, and deploy only the preview branch

**Files:**
- Review all changed files
- No main-branch changes

- [ ] **Step 1: Audit the final diff and branch isolation**

```powershell
git status --short
git diff main...HEAD --stat
git diff --check
git -C F:\anacondaCode\gupiao status --short
git -C F:\anacondaCode\gupiao branch --show-current
```

Expected: preview worktree contains only intended changes; the main worktree is
still on `main` with its pre-existing user changes untouched.

- [ ] **Step 2: Run fresh final verification**

```powershell
npm run test:storage
npm run verify:ma
npm run build
```

Expected: all commands exit 0 with no failed tests.

- [ ] **Step 3: Review requirements line by line**

Confirm:

```text
stable 0.2.8 persistence/update behavior retained
plan ownership isolated by stock and period
active plan persisted per bucket
no silent plan truncation
one stable 30-second autosave interval
dirty state flushed before context changes
plan and replay writes synchronized to Electron
day/week/month replay matching correct
pending snapshots update and resolved snapshots freeze
filters cannot expose unrelated records
current names override stale snapshot names
plan note is authoritative
current-plan export and full backup are both visible
main branch and main Pages site remain untouched
```

- [ ] **Step 4: Commit any final verified adjustment**

```powershell
git add src/App.tsx src/styles.css src/utils/predictionPlans.ts src/utils/replay.ts src/utils/stableAutosave.ts scripts package.json package-lock.json
git commit -m "fix: complete plan replay stabilization"
```

Skip this commit when there are no remaining changes.

- [ ] **Step 5: Push the preview branch**

```powershell
git push origin codex-plan-replay-integrated-v1
```

- [ ] **Step 6: Verify GitHub Actions and deployed preview**

Confirm the branch workflow completes successfully, then verify HTTP 200 and
the tested UI at:

```text
https://nhtqgm.github.io/111/preview/codex-plan-replay-integrated-v1/
```

Do not trigger or redeploy the root `https://nhtqgm.github.io/111/` site from
this task.
