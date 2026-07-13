import type { CloudPredictionValueMutation } from './cloudPredictionStorage.ts';
import type { ElectronStorageApi, StorageLike } from './electronStorage.ts';

const OUTBOX_SCHEMA = 'gupiao-cloud-prediction-outbox/v1';
const OUTBOX_PREFIX = 'prediction-ma:cloud-outbox:';
const LEGACY_OUTBOX_KEY = 'prediction-ma40:cloud-outbox:v1';
const DEVICE_ID_KEY = 'prediction-ma40:cloud-device-id:v1';

interface StoredCloudPredictionOutbox {
  schema: typeof OUTBOX_SCHEMA;
  accountId: string;
  mutations: CloudPredictionValueMutation[];
  lastSavedAt: string | null;
  updatedAt: string;
}

export interface CloudPredictionOutboxSnapshot {
  mutations: CloudPredictionValueMutation[];
  lastSavedAt: string | null;
}

export function cloudPredictionOutboxKey(accountId: string) {
  return `${OUTBOX_PREFIX}${accountId}:v1`;
}

export function loadCloudPredictionOutbox(
  accountId: string,
  storage: StorageLike = localStorage,
): CloudPredictionOutboxSnapshot {
  const raw = storage.getItem(cloudPredictionOutboxKey(accountId));
  if (!raw) return { mutations: [], lastSavedAt: null };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredOutbox(parsed, accountId)) return { mutations: [], lastSavedAt: null };
    return {
      mutations: cloneMutations(parsed.mutations),
      lastSavedAt: parsed.lastSavedAt,
    };
  } catch {
    return { mutations: [], lastSavedAt: null };
  }
}

export function saveCloudPredictionOutbox(
  accountId: string,
  snapshot: CloudPredictionOutboxSnapshot,
  storage: StorageLike = localStorage,
  api: ElectronStorageApi | undefined = typeof window === 'undefined' ? undefined : window.appStorageApi,
) {
  const key = cloudPredictionOutboxKey(accountId);
  const stored: StoredCloudPredictionOutbox = {
    schema: OUTBOX_SCHEMA,
    accountId,
    mutations: deduplicateMutations(snapshot.mutations),
    lastSavedAt: normalizeTimestamp(snapshot.lastSavedAt),
    updatedAt: nextUpdatedAt(storage.getItem(key)),
  };
  const value = JSON.stringify(stored);
  storage.setItem(key, value);
  if (api) {
    void api.bootstrap({ [key]: value }).catch((error: unknown) => {
      console.error('Cloud prediction outbox persistence failed:', error);
    });
  }
}

export async function bootstrapCloudPredictionOutboxStorage(
  storage: StorageLike = localStorage,
  api: ElectronStorageApi | undefined = typeof window === 'undefined' ? undefined : window.appStorageApi,
) {
  storage.removeItem(LEGACY_OUTBOX_KEY);
  if (!api) return;

  const localOutboxes: Record<string, string> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !isOutboxStorageKey(key)) continue;
    const value = storage.getItem(key);
    if (value !== null && isSerializedOutbox(value, accountIdFromKey(key))) {
      localOutboxes[key] = value;
    }
  }

  const canonical = await api.bootstrap(localOutboxes);
  Object.entries(canonical).forEach(([key, value]) => {
    if (isOutboxStorageKey(key) && isSerializedOutbox(value, accountIdFromKey(key))) {
      storage.setItem(key, value);
    }
  });
}

export function getCloudDeviceId() {
  const saved = localStorage.getItem(DEVICE_ID_KEY);
  if (saved) return saved;
  const next = globalThis.crypto?.randomUUID?.() ?? `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(DEVICE_ID_KEY, next);
  return next;
}

export function clearCloudOutbox() {
  localStorage.removeItem(LEGACY_OUTBOX_KEY);
}

function isStoredOutbox(value: unknown, accountId: string): value is StoredCloudPredictionOutbox {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredCloudPredictionOutbox>;
  return (
    candidate.schema === OUTBOX_SCHEMA &&
    candidate.accountId === accountId &&
    Array.isArray(candidate.mutations) &&
    candidate.mutations.every(isMutation) &&
    (candidate.lastSavedAt === null || isTimestamp(candidate.lastSavedAt)) &&
    isTimestamp(candidate.updatedAt)
  );
}

function isMutation(value: unknown): value is CloudPredictionValueMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<CloudPredictionValueMutation>;
  return (
    typeof candidate.stockCode === 'string' &&
    /^\d{6}$/.test(candidate.stockCode) &&
    ['day', 'week', 'month'].includes(candidate.period ?? '') &&
    typeof candidate.targetDate === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(candidate.targetDate) &&
    ['ma5', 'ma10', 'ma20', 'ma40', 'ma60', 'note'].includes(candidate.metric ?? '') &&
    (candidate.value === null || typeof candidate.value === 'string')
  );
}

function deduplicateMutations(mutations: CloudPredictionValueMutation[]) {
  const values = new Map<string, CloudPredictionValueMutation>();
  mutations.filter(isMutation).forEach((mutation) => {
    values.set(mutationKey(mutation), { ...mutation });
  });
  return [...values.values()].sort((left, right) => mutationKey(left).localeCompare(mutationKey(right)));
}

function cloneMutations(mutations: CloudPredictionValueMutation[]) {
  return mutations.map((mutation) => ({ ...mutation }));
}

function mutationKey(mutation: CloudPredictionValueMutation) {
  return [mutation.stockCode, mutation.period, mutation.targetDate, mutation.metric].join(':');
}

function isOutboxStorageKey(key: string) {
  return /^prediction-ma:cloud-outbox:[^:]+:v1$/.test(key);
}

function accountIdFromKey(key: string) {
  return key.slice(OUTBOX_PREFIX.length, -':v1'.length);
}

function isSerializedOutbox(value: string, accountId: string) {
  try {
    return isStoredOutbox(JSON.parse(value), accountId);
  } catch {
    return false;
  }
}

function normalizeTimestamp(value: string | null) {
  return value && isTimestamp(value) ? value : null;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nextUpdatedAt(previousValue: string | null) {
  let previousTimestamp = 0;
  if (previousValue) {
    try {
      const previous = JSON.parse(previousValue) as Partial<StoredCloudPredictionOutbox>;
      const parsed = typeof previous.updatedAt === 'string' ? Date.parse(previous.updatedAt) : Number.NaN;
      if (Number.isFinite(parsed)) previousTimestamp = parsed;
    } catch {
      previousTimestamp = 0;
    }
  }
  return new Date(Math.max(Date.now(), previousTimestamp + 1)).toISOString();
}
