import type { PeriodType, PredictionPoint } from '../types.ts';
import {
  getWorkspacePredictions,
  setWorkspacePredictions,
  type CloudWorkspace,
} from './cloudWorkspace.ts';

export type CloudPredictionMetric = 'ma5' | 'ma10' | 'ma20' | 'ma40' | 'ma60' | 'note';

export interface CloudPredictionValueMutation {
  stockCode: string;
  period: PeriodType;
  targetDate: string;
  metric: CloudPredictionMetric;
  value: string | null;
  editedAt: string;
}

export type CloudPredictionSaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface CloudPredictionSaveState {
  status: CloudPredictionSaveStatus;
  pendingCount: number;
  lastSavedAt: string | null;
  error: Error | null;
}

export interface CloudPredictionQueueSnapshot {
  mutations: CloudPredictionValueMutation[];
  lastSavedAt: string | null;
}

const metrics: Array<{ metric: CloudPredictionMetric; window?: number }> = [
  { metric: 'ma5', window: 5 },
  { metric: 'ma10', window: 10 },
  { metric: 'ma20', window: 20 },
  { metric: 'ma40', window: 40 },
  { metric: 'ma60', window: 60 },
  { metric: 'note' },
];

// Edit stamps arbitrate multi-device writes server-side, so they must never
// move backwards — not across rapid same-millisecond edits, and not on devices
// whose wall clock lags the server. Seed with every server timestamp we see.
let lastEditedAtMs = 0;

export function advancePredictionEditClock(timestamp: string | number | null | undefined) {
  const parsed = typeof timestamp === 'number' ? timestamp : timestamp ? Date.parse(timestamp) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > lastEditedAtMs) lastEditedAtMs = parsed;
}

export function nextPredictionEditedAt() {
  lastEditedAtMs = Math.max(Date.now(), lastEditedAtMs + 1);
  return new Date(lastEditedAtMs).toISOString();
}

// Rows save_my_prediction_values kept because the cloud already held a newer
// edit. The returned value is the surviving one, so the caller can converge
// its local view. Malformed rows are dropped rather than trusted.
export function normalizeRejectedPredictionRows(data: unknown): CloudPredictionValueMutation[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((row) => {
    const candidate = (row ?? {}) as Record<string, unknown>;
    if (
      !row || typeof row !== 'object' ||
      typeof candidate.r_stock_code !== 'string' ||
      !/^\d{6}$/.test(candidate.r_stock_code) ||
      !['day', 'week', 'month'].includes(candidate.r_period as string) ||
      typeof candidate.r_target_date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}/.test(candidate.r_target_date) ||
      !['ma5', 'ma10', 'ma20', 'ma40', 'ma60', 'note'].includes(candidate.r_metric as string) ||
      typeof candidate.r_edited_at !== 'string' ||
      !Number.isFinite(Date.parse(candidate.r_edited_at))
    ) {
      return [];
    }
    const record = row as {
      r_stock_code: string;
      r_period: PeriodType;
      r_target_date: string;
      r_metric: CloudPredictionMetric;
      r_value: unknown;
      r_edited_at: string;
    };
    advancePredictionEditClock(record.r_edited_at);
    const value = typeof record.r_value === 'string' ? record.r_value : '';
    return [{
      stockCode: record.r_stock_code,
      period: record.r_period,
      targetDate: record.r_target_date.slice(0, 10),
      metric: record.r_metric,
      value: value.trim() ? value : null,
      editedAt: record.r_edited_at,
    }];
  });
}

export function createPredictionValueMutations(
  scope: { stockCode: string; period: PeriodType },
  beforeRows: PredictionPoint[],
  afterRows: PredictionPoint[],
  options?: { editedAt?: string },
): CloudPredictionValueMutation[] {
  const beforeByDate = new Map(beforeRows.map((row) => [row.targetDate, row]));
  const afterByDate = new Map(afterRows.map((row) => [row.targetDate, row]));
  const targetDates = [...new Set([...beforeByDate.keys(), ...afterByDate.keys()])].sort();
  let editedAt: string | null = options?.editedAt ?? null;

  return targetDates.flatMap((targetDate) =>
    metrics.flatMap(({ metric, window }) => {
      const before = valueForMetric(beforeByDate.get(targetDate), metric, window);
      const after = valueForMetric(afterByDate.get(targetDate), metric, window);
      if (before === after) return [];
      editedAt ??= nextPredictionEditedAt();
      return [{
        stockCode: scope.stockCode,
        period: scope.period,
        targetDate,
        metric,
        value: after || null,
        editedAt,
      }];
    }),
  );
}

export function applyPredictionValueMutationsToWorkspace(
  workspace: CloudWorkspace,
  mutations: CloudPredictionValueMutation[],
) {
  const grouped = new Map<string, CloudPredictionValueMutation[]>();
  mutations.forEach((mutation) => {
    const key = `${mutation.stockCode}:${mutation.period}`;
    grouped.set(key, [...(grouped.get(key) ?? []), mutation]);
  });

  let next = workspace;
  grouped.forEach((scopeMutations) => {
    const first = scopeMutations[0];
    if (!first) return;
    const scope = { stockCode: first.stockCode, period: first.period };
    const rows = applyPredictionValueMutationsToRows(
      getWorkspacePredictions(next, scope),
      scopeMutations,
    );
    next = setWorkspacePredictions(next, scope, rows);
  });
  return next;
}

export function applyPredictionValueMutationsToRows(
  rows: PredictionPoint[],
  mutations: CloudPredictionValueMutation[],
) {
  const rowsByDate = new Map(rows.map((row) => [row.targetDate, cloneRow(row)]));
  mutations.forEach((mutation) => {
    const row = rowsByDate.get(mutation.targetDate) ?? emptyRow(mutation.targetDate);
    rowsByDate.set(mutation.targetDate, applyMutation(row, mutation));
  });
  return [...rowsByDate.values()].sort((left, right) => left.targetDate.localeCompare(right.targetDate));
}

export function createPredictionValueSaveQueue(options: {
  accountId: string;
  debounceMs?: number;
  initialMutations?: CloudPredictionValueMutation[];
  initialLastSavedAt?: string | null;
  save: (mutations: CloudPredictionValueMutation[]) => Promise<CloudPredictionValueMutation[] | void>;
  persist?: (snapshot: CloudPredictionQueueSnapshot) => void;
  onStateChange?: (state: CloudPredictionSaveState) => void;
  onRejected?: (mutations: CloudPredictionValueMutation[]) => void;
}) {
  let accountId = options.accountId;
  let pending = toMutationMap(options.initialMutations ?? []);
  let activeBatch: Map<string, CloudPredictionValueMutation> | null = null;
  let active: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let lastError: Error | null = null;
  let lastSavedAt = options.initialLastSavedAt ?? null;
  let status: CloudPredictionSaveStatus = pending.size ? 'pending' : lastSavedAt ? 'saved' : 'idle';

  const outstandingMutations = () => {
    const outstanding = new Map(activeBatch ?? []);
    pending.forEach((mutation, key) => outstanding.set(key, mutation));
    return [...outstanding.values()].sort((left, right) => mutationKey(left).localeCompare(mutationKey(right)));
  };

  const state = (): CloudPredictionSaveState => ({
    status,
    pendingCount: outstandingMutations().length,
    lastSavedAt,
    error: lastError,
  });

  const notify = () => {
    const current = state();
    options.persist?.({ mutations: outstandingMutations(), lastSavedAt });
    options.onStateChange?.(current);
  };

  const setStatus = (next: CloudPredictionSaveStatus) => {
    status = next;
    notify();
  };

  const start = async () => {
    if (active || !pending.size) return;
    const current = pending;
    pending = new Map();
    activeBatch = current;
    const requestGeneration = generation;
    const requestAccountId = accountId;
    lastError = null;
    setStatus('saving');
    active = options.save([...current.values()])
      .then((rejected) => {
        if (generation !== requestGeneration || accountId !== requestAccountId) return;
        activeBatch = null;
        lastError = null;
        lastSavedAt = new Date().toISOString();
        setStatus(pending.size ? 'pending' : 'saved');
        if (Array.isArray(rejected) && rejected.length) {
          // The server kept a newer edit for these cells. Let the app converge
          // its local view — unless the user already re-edited the same cell,
          // in which case the pending mutation is the newer truth.
          const fresh = rejected.filter((mutation) => !pending.has(mutationKey(mutation)));
          if (fresh.length) options.onRejected?.(fresh);
        }
      })
      .catch((error: unknown) => {
        if (generation !== requestGeneration || accountId !== requestAccountId) return;
        const restored = new Map(current);
        pending.forEach((mutation, key) => restored.set(key, mutation));
        pending = restored;
        activeBatch = null;
        lastError = error instanceof Error ? error : new Error(String(error));
        setStatus('error');
      })
      .finally(() => {
        active = null;
        if (generation !== requestGeneration || accountId !== requestAccountId) return;
        if (pending.size && status !== 'error') arm();
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

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    while (pending.size || active) {
      await start();
      if (active) await active;
      if (status === 'error') break;
    }
  };

  notify();
  if (pending.size) arm();

  return {
    schedule(mutations: CloudPredictionValueMutation[]) {
      mutations.forEach((mutation) => pending.set(mutationKey(mutation), { ...mutation }));
      if (!mutations.length) return;
      lastError = null;
      setStatus(active ? 'saving' : 'pending');
      arm();
    },
    flush,
    retry() {
      if (!pending.size) return;
      lastError = null;
      setStatus('pending');
      arm();
    },
    markAllSaved() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = new Map();
      activeBatch = null;
      lastError = null;
      lastSavedAt = new Date().toISOString();
      setStatus('saved');
    },
    switchAccount(nextAccountId: string) {
      generation += 1;
      accountId = nextAccountId;
      pending = new Map();
      activeBatch = null;
      lastError = null;
      lastSavedAt = null;
      if (timer) clearTimeout(timer);
      timer = null;
      status = 'idle';
      options.onStateChange?.(state());
    },
    getState: state,
    getLastError: () => lastError,
  };
}

function valueForMetric(row: PredictionPoint | undefined, metric: CloudPredictionMetric, window?: number) {
  if (!row) return '';
  if (metric === 'note') return row.note.trim();
  const value = row.predictedMaValues[String(window)] ?? (window === 40 ? row.predictedMa40 : '');
  return value.trim();
}

function applyMutation(row: PredictionPoint, mutation: CloudPredictionValueMutation): PredictionPoint {
  const value = mutation.value ?? '';
  if (mutation.metric === 'note') return { ...row, note: value };

  const windowSize = mutation.metric.slice(2);
  const predictedMaValues = { ...row.predictedMaValues };
  if (value) predictedMaValues[windowSize] = value;
  else delete predictedMaValues[windowSize];
  return {
    ...row,
    predictedMa40: windowSize === '40' ? value : row.predictedMa40,
    predictedMaValues,
  };
}

function emptyRow(targetDate: string): PredictionPoint {
  return { targetDate, predictedMa40: '', predictedMaValues: {}, note: '' };
}

function cloneRow(row: PredictionPoint): PredictionPoint {
  return { ...row, predictedMaValues: { ...row.predictedMaValues } };
}

function toMutationMap(mutations: CloudPredictionValueMutation[]) {
  const values = new Map<string, CloudPredictionValueMutation>();
  mutations.forEach((mutation) => values.set(mutationKey(mutation), { ...mutation }));
  return values;
}

function mutationKey(mutation: CloudPredictionValueMutation) {
  return [mutation.stockCode, mutation.period, mutation.targetDate, mutation.metric].join(':');
}
