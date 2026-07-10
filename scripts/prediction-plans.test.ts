import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLAN_LIMIT,
  getActivePlanKey,
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

function makePlan(index: number, overrides: Partial<PredictionPlan> = {}): PredictionPlan {
  const timestamp = new Date(Date.UTC(2026, 0, index + 1)).toISOString();
  return {
    id: `plan-${index}`,
    name: `Plan ${index}`,
    stockCode: '000166',
    period: 'month',
    inputMaWindow: 40,
    predictions: [],
    note: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    source: 'manual',
    ...overrides,
  };
}

test('loadPredictionPlans rejects foreign-owned stored plans instead of reassigning them', () => {
  const storage = new MemoryStorage();
  installStorage(storage);
  const ownedPlan = makePlan(0);
  const foreignPlan = makePlan(1, { stockCode: '600000' });
  storage.setItem(
    getPredictionPlansKey('000166', 'month'),
    JSON.stringify([ownedPlan, foreignPlan]),
  );

  const result = loadPredictionPlans('000166', 'month', '2026-01-31', [], 0);

  assert.deepEqual(result.plans.map((plan) => plan.id), [ownedPlan.id]);
  assert.equal(result.plans[0].stockCode, '000166');
});

test('loadPredictionPlans rejects wrong-period stored plans instead of reassigning them', () => {
  const storage = new MemoryStorage();
  installStorage(storage);
  const ownedPlan = makePlan(0);
  const wrongPeriodPlan = makePlan(1, { period: 'day' });
  storage.setItem(
    getPredictionPlansKey('000166', 'month'),
    JSON.stringify([ownedPlan, wrongPeriodPlan]),
  );

  const result = loadPredictionPlans('000166', 'month', '2026-01-31', [], 0);

  assert.deepEqual(result.plans.map((plan) => plan.id), [ownedPlan.id]);
  assert.equal(result.plans[0].period, 'month');
});

test('loadPredictionPlans preserves all existing plans beyond the creation limit', () => {
  const storage = new MemoryStorage();
  installStorage(storage);
  const storedPlans = Array.from({ length: PLAN_LIMIT + 1 }, (_, index) => makePlan(index));
  storage.setItem(
    getPredictionPlansKey('000166', 'month'),
    JSON.stringify(storedPlans),
  );

  const result = loadPredictionPlans('000166', 'month', '2026-01-31', [], 0);

  assert.equal(result.plans.length, 31);
  assert.equal(hasPredictionPlanCapacity(result.plans.slice(0, PLAN_LIMIT)), false);
  assert.equal(hasPredictionPlanCapacity(result.plans), false);
});

test('loadPredictionPlans fills ownership omitted by legacy stored plans', () => {
  const storage = new MemoryStorage();
  installStorage(storage);
  const legacyPlan = makePlan(0) as Partial<PredictionPlan>;
  delete legacyPlan.stockCode;
  delete legacyPlan.period;
  storage.setItem(
    getPredictionPlansKey('000166', 'month'),
    JSON.stringify([legacyPlan]),
  );

  const result = loadPredictionPlans('000166', 'month', '2026-01-31', [], 0);

  assert.equal(result.plans[0].stockCode, '000166');
  assert.equal(result.plans[0].period, 'month');
});

test('normalizePredictionPlanExport rejects inner stock and period ownership conflicts', () => {
  const envelope = {
    version: 'prediction-plan-v1',
    exportedAt: '2026-01-31T00:00:00.000Z',
    stockCode: '000166',
    period: 'month',
    baseDate: '2026-01-31',
    plan: makePlan(0),
  };

  assert.equal(
    normalizePredictionPlanExport({
      ...envelope,
      plan: { ...envelope.plan, stockCode: '600000' },
    }),
    null,
  );
  assert.equal(
    normalizePredictionPlanExport({
      ...envelope,
      plan: { ...envelope.plan, period: 'day' },
    }),
    null,
  );
});

test('plan and active-plan saves queue complete Electron snapshots', async () => {
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
  const plan = makePlan(0);
  const planKey = getPredictionPlansKey('000166', 'month');
  const activeKey = getActivePlanKey('000166', 'month');

  await savePredictionPlans('000166', 'month', [plan]);
  await saveActivePlanId('000166', 'month', plan.id);

  assert.equal(saved.length, 2);
  assert.deepEqual(JSON.parse(saved[0][planKey]), [plan]);
  assert.deepEqual(JSON.parse(saved[1][planKey]), [plan]);
  assert.equal(saved[1][activeKey], plan.id);
});

test('savePredictionPlans writes every supplied plan beyond the creation limit', async () => {
  const storage = new MemoryStorage();
  installStorage(storage);
  const plans = Array.from({ length: 31 }, (_, index) => makePlan(index));
  const planKey = getPredictionPlansKey('000166', 'month');

  await savePredictionPlans('000166', 'month', plans);

  assert.equal(JSON.parse(storage.getItem(planKey) ?? '[]').length, 31);
});

test('savePredictionPlans rejects conflicting supplied ownership without writing', () => {
  const storage = new MemoryStorage();
  installStorage(storage);
  const planKey = getPredictionPlansKey('000166', 'month');
  const foreignPlan = makePlan(0, { stockCode: '600000' });

  assert.throws(
    () => savePredictionPlans('000166', 'month', [foreignPlan]),
    /ownership/i,
  );
  assert.equal(storage.getItem(planKey), null);
});

test('savePredictionPlans rejects a conflicting supplied period without writing', () => {
  const storage = new MemoryStorage();
  installStorage(storage);
  const planKey = getPredictionPlansKey('000166', 'month');
  const wrongPeriodPlan = makePlan(0, { period: 'day' });

  assert.throws(
    () => savePredictionPlans('000166', 'month', [wrongPeriodPlan]),
    /ownership/i,
  );
  assert.equal(storage.getItem(planKey), null);
});
