export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ElectronStorageApi {
  bootstrap(storage: Record<string, string>): Promise<Record<string, string>>;
  save(storage: Record<string, string>): Promise<void>;
}

let pendingSync: Promise<void> | null = null;
let syncRequested = false;
const BROWSER_LEGACY_CACHE_RESET_KEY = 'gupiao:cloud-sync-cache-reset:v2';

export function isAppStorageKey(key: string) {
  return key.startsWith('prediction-ma40:') || key.startsWith('prediction-ma:');
}

export function clearLegacyBrowserAppCache(storage: StorageLike = localStorage) {
  if (storage.getItem(BROWSER_LEGACY_CACHE_RESET_KEY)) return 0;

  const keysToRemove: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && isAppStorageKey(key) && !isDurableCloudOutboxKey(key)) keysToRemove.push(key);
  }

  keysToRemove.forEach((key) => storage.removeItem(key));
  storage.setItem(BROWSER_LEGACY_CACHE_RESET_KEY, new Date().toISOString());
  return keysToRemove.length;
}

function isDurableCloudOutboxKey(key: string) {
  return (
    /^prediction-ma:cloud-outbox:[^:]+:v1$/.test(key) ||
    /^prediction-ma:cloud-history-outbox:[^:]+:v1$/.test(key)
  );
}

export function collectAppStorage(storage: StorageLike) {
  const snapshot: Record<string, string> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !isAppStorageKey(key)) continue;
    const value = storage.getItem(key);
    if (value !== null) snapshot[key] = value;
  }
  return snapshot;
}

export function restoreAppStorage(storage: StorageLike, snapshot: Record<string, string>) {
  const keysToRemove: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && isAppStorageKey(key)) keysToRemove.push(key);
  }
  keysToRemove.forEach((key) => storage.removeItem(key));

  Object.entries(snapshot).forEach(([key, value]) => {
    if (isAppStorageKey(key) && typeof value === 'string') {
      storage.setItem(key, value);
    }
  });
}

export async function bootstrapElectronStorage(
  storage: StorageLike = localStorage,
  api: ElectronStorageApi | undefined = window.appStorageApi,
) {
  if (!api) return;
  const canonical = await api.bootstrap(collectAppStorage(storage));
  restoreAppStorage(storage, canonical);
}

export async function persistElectronStorage(
  storage: StorageLike = localStorage,
  api: ElectronStorageApi | undefined = window.appStorageApi,
) {
  if (!api) return;
  await api.save(collectAppStorage(storage));
}

export function queueElectronStorageSync(
  storage: StorageLike = localStorage,
  api: ElectronStorageApi | undefined = window.appStorageApi,
) {
  if (!api) return Promise.resolve();
  syncRequested = true;
  if (pendingSync) return pendingSync;

  const sync = Promise.resolve()
    .then(async () => {
      do {
        syncRequested = false;
        await persistElectronStorage(storage, api);
      } while (syncRequested);
    })
    .finally(() => {
      if (pendingSync === sync) pendingSync = null;
    });
  pendingSync = sync;
  return sync;
}
