import type { CloudPredictionSaveState } from './cloudPredictionStorage.ts';
import type { ElectronStorageApi, StorageLike } from './electronStorage.ts';
import type { ForecastHistorySnapshot } from './forecastHistory.ts';

const OUTBOX_SCHEMA = 'gupiao-cloud-history-outbox/v1';
const OUTBOX_PREFIX = 'prediction-ma:cloud-history-outbox:';

interface StoredCloudHistoryOutbox {
  schema: typeof OUTBOX_SCHEMA;
  accountId: string;
  snapshots: ForecastHistorySnapshot[];
  lastSavedAt: string | null;
  updatedAt: string;
}

export interface CloudHistoryOutboxSnapshot {
  snapshots: ForecastHistorySnapshot[];
  lastSavedAt: string | null;
}

export function cloudHistoryOutboxKey(accountId: string) {
  return `${OUTBOX_PREFIX}${accountId}:v1`;
}

export function loadCloudHistoryOutbox(
  accountId: string,
  storage: StorageLike = localStorage,
): CloudHistoryOutboxSnapshot {
  const raw = storage.getItem(cloudHistoryOutboxKey(accountId));
  if (!raw) return { snapshots: [], lastSavedAt: null };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredOutbox(parsed, accountId)) return { snapshots: [], lastSavedAt: null };
    return {
      snapshots: cloneSnapshots(parsed.snapshots),
      lastSavedAt: parsed.lastSavedAt,
    };
  } catch {
    return { snapshots: [], lastSavedAt: null };
  }
}

export function saveCloudHistoryOutbox(
  accountId: string,
  snapshot: CloudHistoryOutboxSnapshot,
  storage: StorageLike = localStorage,
  api: ElectronStorageApi | undefined = typeof window === 'undefined' ? undefined : window.appStorageApi,
) {
  const key = cloudHistoryOutboxKey(accountId);
  const stored: StoredCloudHistoryOutbox = {
    schema: OUTBOX_SCHEMA,
    accountId,
    snapshots: deduplicateSnapshots(snapshot.snapshots),
    lastSavedAt: normalizeTimestamp(snapshot.lastSavedAt),
    updatedAt: nextUpdatedAt(storage.getItem(key)),
  };
  const value = JSON.stringify(stored);
  storage.setItem(key, value);
  if (api) {
    void api.bootstrap({ [key]: value }).catch((error: unknown) => {
      console.error('Cloud forecast-history outbox persistence failed:', error);
    });
  }
}

export async function bootstrapCloudHistoryOutboxStorage(
  storage: StorageLike = localStorage,
  api: ElectronStorageApi | undefined = typeof window === 'undefined' ? undefined : window.appStorageApi,
) {
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

export function createForecastHistorySaveQueue(options: {
  accountId: string;
  debounceMs?: number;
  initialSnapshots?: ForecastHistorySnapshot[];
  initialLastSavedAt?: string | null;
  save: (snapshots: ForecastHistorySnapshot[]) => Promise<void>;
  persist?: (snapshot: CloudHistoryOutboxSnapshot) => void;
  onStateChange?: (state: CloudPredictionSaveState) => void;
}) {
  let accountId = options.accountId;
  let pending = toSnapshotMap(options.initialSnapshots ?? []);
  let activeBatch: Map<string, ForecastHistorySnapshot> | null = null;
  let active: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let lastError: Error | null = null;
  let lastSavedAt = options.initialLastSavedAt ?? null;
  let status: CloudPredictionSaveState['status'] = pending.size
    ? 'pending'
    : lastSavedAt
      ? 'saved'
      : 'idle';

  const outstandingSnapshots = () => {
    const outstanding = new Map(activeBatch ?? []);
    pending.forEach((snapshot, id) => setNewestSnapshot(outstanding, id, snapshot));
    return [...outstanding.values()].sort(compareSnapshots);
  };

  const state = (): CloudPredictionSaveState => ({
    status,
    pendingCount: outstandingSnapshots().length,
    lastSavedAt,
    error: lastError,
  });

  const notify = () => {
    options.persist?.({ snapshots: outstandingSnapshots(), lastSavedAt });
    options.onStateChange?.(state());
  };

  const setStatus = (next: CloudPredictionSaveState['status']) => {
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
    active = options.save([...current.values()].sort(compareSnapshots))
      .then(() => {
        if (generation !== requestGeneration || accountId !== requestAccountId) return;
        activeBatch = null;
        lastError = null;
        lastSavedAt = new Date().toISOString();
        setStatus(pending.size ? 'pending' : 'saved');
      })
      .catch((error: unknown) => {
        if (generation !== requestGeneration || accountId !== requestAccountId) return;
        const restored = new Map(current);
        pending.forEach((snapshot, id) => setNewestSnapshot(restored, id, snapshot));
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
    schedule(snapshots: ForecastHistorySnapshot[]) {
      snapshots.forEach((snapshot) => setNewestSnapshot(pending, snapshot.id, snapshot));
      if (!snapshots.length) return;
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

function isStoredOutbox(value: unknown, accountId: string): value is StoredCloudHistoryOutbox {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredCloudHistoryOutbox>;
  return (
    candidate.schema === OUTBOX_SCHEMA &&
    candidate.accountId === accountId &&
    Array.isArray(candidate.snapshots) &&
    candidate.snapshots.every(isForecastHistorySnapshot) &&
    (candidate.lastSavedAt === null || isTimestamp(candidate.lastSavedAt)) &&
    isTimestamp(candidate.updatedAt)
  );
}

function isForecastHistorySnapshot(value: unknown): value is ForecastHistorySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ForecastHistorySnapshot>;
  return (
    candidate.schema === 'gupiao-forecast-history/v1' &&
    typeof candidate.id === 'string' && candidate.id.length > 0 &&
    typeof candidate.stockCode === 'string' && /^\d{6}$/.test(candidate.stockCode) &&
    (candidate.period === 'day' || candidate.period === 'week' || candidate.period === 'month') &&
    typeof candidate.targetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(candidate.targetDate) &&
    [5, 10, 20, 40, 60].includes(Number(candidate.inputMaWindow)) &&
    Number.isFinite(Number(candidate.inputMaValue)) &&
    Number.isFinite(Number(candidate.predictedClose)) &&
    !!candidate.predictedMaValues && typeof candidate.predictedMaValues === 'object' &&
    typeof candidate.savedAt === 'string'
  );
}

function deduplicateSnapshots(snapshots: ForecastHistorySnapshot[]) {
  return [...toSnapshotMap(snapshots).values()].sort(compareSnapshots);
}

function toSnapshotMap(snapshots: ForecastHistorySnapshot[]) {
  const values = new Map<string, ForecastHistorySnapshot>();
  snapshots.filter(isForecastHistorySnapshot).forEach((snapshot) => {
    setNewestSnapshot(values, snapshot.id, snapshot);
  });
  return values;
}

function setNewestSnapshot(
  values: Map<string, ForecastHistorySnapshot>,
  id: string,
  snapshot: ForecastHistorySnapshot,
) {
  const existing = values.get(id);
  if (!existing || snapshot.savedAt >= existing.savedAt) {
    values.set(id, cloneSnapshot(snapshot));
  }
}

function cloneSnapshots(snapshots: ForecastHistorySnapshot[]) {
  return snapshots.map(cloneSnapshot);
}

function cloneSnapshot(snapshot: ForecastHistorySnapshot) {
  return { ...snapshot, predictedMaValues: { ...snapshot.predictedMaValues } };
}

function compareSnapshots(left: ForecastHistorySnapshot, right: ForecastHistorySnapshot) {
  return left.targetDate.localeCompare(right.targetDate) || left.id.localeCompare(right.id);
}

function isOutboxStorageKey(key: string) {
  return /^prediction-ma:cloud-history-outbox:[^:]+:v1$/.test(key);
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
      const previous = JSON.parse(previousValue) as Partial<StoredCloudHistoryOutbox>;
      const parsed = typeof previous.updatedAt === 'string' ? Date.parse(previous.updatedAt) : Number.NaN;
      if (Number.isFinite(parsed)) previousTimestamp = parsed;
    } catch {
      previousTimestamp = 0;
    }
  }
  return new Date(Math.max(Date.now(), previousTimestamp + 1)).toISOString();
}
