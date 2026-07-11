import type { PeriodType, PredictionPoint } from '../types.ts';

export type CloudPredictionMetric = 'ma5' | 'ma10' | 'ma20' | 'ma40' | 'ma60' | 'note';

export interface CloudPredictionValueMutation {
  stockCode: string;
  period: PeriodType;
  targetDate: string;
  metric: CloudPredictionMetric;
  value: string | null;
}

const metrics: Array<{ metric: CloudPredictionMetric; window?: number }> = [
  { metric: 'ma5', window: 5 },
  { metric: 'ma10', window: 10 },
  { metric: 'ma20', window: 20 },
  { metric: 'ma40', window: 40 },
  { metric: 'ma60', window: 60 },
  { metric: 'note' },
];

export function createPredictionValueMutations(
  scope: { stockCode: string; period: PeriodType },
  beforeRows: PredictionPoint[],
  afterRows: PredictionPoint[],
): CloudPredictionValueMutation[] {
  const beforeByDate = new Map(beforeRows.map((row) => [row.targetDate, row]));
  const afterByDate = new Map(afterRows.map((row) => [row.targetDate, row]));
  const targetDates = [...new Set([...beforeByDate.keys(), ...afterByDate.keys()])].sort();

  return targetDates.flatMap((targetDate) =>
    metrics.flatMap(({ metric, window }) => {
      const before = valueForMetric(beforeByDate.get(targetDate), metric, window);
      const after = valueForMetric(afterByDate.get(targetDate), metric, window);
      if (before === after) return [];
      return [{
        stockCode: scope.stockCode,
        period: scope.period,
        targetDate,
        metric,
        value: after || null,
      }];
    }),
  );
}

export function createPredictionValueSaveQueue(options: {
  accountId: string;
  debounceMs?: number;
  save: (mutations: CloudPredictionValueMutation[]) => Promise<void>;
}) {
  let accountId = options.accountId;
  let pending = new Map<string, CloudPredictionValueMutation>();
  let active: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let lastError: Error | null = null;

  const start = async () => {
    if (active || !pending.size) return;
    const current = [...pending.values()];
    pending = new Map();
    const requestGeneration = generation;
    const requestAccountId = accountId;
    active = options.save(current)
      .then(() => { lastError = null; })
      .catch((error: unknown) => {
        if (generation !== requestGeneration || accountId !== requestAccountId) return;
        current.forEach((mutation) => pending.set(mutationKey(mutation), mutation));
        lastError = error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        active = null;
        if (generation === requestGeneration && accountId === requestAccountId && pending.size) arm();
      });
    await active;
  };

  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void start();
    }, options.debounceMs ?? 700);
  };

  return {
    schedule(mutations: CloudPredictionValueMutation[]) {
      mutations.forEach((mutation) => pending.set(mutationKey(mutation), { ...mutation }));
      if (mutations.length) arm();
    },
    async flush() {
      if (timer) clearTimeout(timer);
      timer = null;
      await start();
      if (active) await active;
    },
    switchAccount(nextAccountId: string) {
      generation += 1;
      accountId = nextAccountId;
      pending = new Map();
      lastError = null;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    getLastError: () => lastError,
  };
}

function valueForMetric(row: PredictionPoint | undefined, metric: CloudPredictionMetric, window?: number) {
  if (!row) return '';
  if (metric === 'note') return row.note.trim();
  const value = row.predictedMaValues[String(window)] ?? (window === 40 ? row.predictedMa40 : '');
  return value.trim();
}

function mutationKey(mutation: CloudPredictionValueMutation) {
  return [mutation.stockCode, mutation.period, mutation.targetDate, mutation.metric].join(':');
}
