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

export class EmptyAppStorageSnapshotError extends Error {
  constructor() {
    super('Backup does not contain application storage');
    this.name = 'EmptyAppStorageSnapshotError';
  }
}

export class AppStorageRestoreError extends Error {
  constructor() {
    super('Application storage restore failed and was rolled back');
    this.name = 'AppStorageRestoreError';
  }
}

export function canStartStorageTransfer(restoreInProgress: boolean) {
  return !restoreInProgress;
}

export function isAppStorageKey(key: string) {
  return key.startsWith('prediction-ma40:') || key.startsWith('prediction-ma:');
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

export function normalizeAppStorageSnapshot(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(snapshot).filter(
      ([key, value]) => isAppStorageKey(key) && typeof value === 'string',
    ),
  );
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
  api: ElectronStorageApi | undefined =
    typeof window === 'undefined' ? undefined : window.appStorageApi,
) {
  if (!api) return;
  const canonical = await api.bootstrap(collectAppStorage(storage));
  restoreAppStorage(storage, canonical);
}

export async function persistElectronStorage(
  storage: StorageLike = localStorage,
  api: ElectronStorageApi | undefined =
    typeof window === 'undefined' ? undefined : window.appStorageApi,
) {
  if (!api) return;
  await api.save(collectAppStorage(storage));
}

export async function restoreAppStorageTransaction(
  storage: StorageLike,
  importedSnapshot: unknown,
  api: ElectronStorageApi | undefined =
    typeof window === 'undefined' ? undefined : window.appStorageApi,
) {
  const normalizedSnapshot = normalizeAppStorageSnapshot(importedSnapshot);
  if (!Object.keys(normalizedSnapshot).length) {
    throw new EmptyAppStorageSnapshotError();
  }

  const previousSnapshot = collectAppStorage(storage);
  if (pendingSync) {
    try {
      await pendingSync;
    } catch {
      // The transaction below writes a complete replacement snapshot.
    }
  }

  try {
    restoreAppStorage(storage, normalizedSnapshot);
    await persistElectronStorage(storage, api);
  } catch {
    try {
      restoreAppStorage(storage, previousSnapshot);
    } catch {
      // Keep attempting to restore Electron even if browser storage rollback fails.
    }
    try {
      await api?.save(previousSnapshot);
    } catch {
      // Best effort: browser storage remains the canonical rollback source.
    }
    throw new AppStorageRestoreError();
  }

  return normalizedSnapshot;
}

export function queueElectronStorageSync(
  storage: StorageLike = localStorage,
  api: ElectronStorageApi | undefined =
    typeof window === 'undefined' ? undefined : window.appStorageApi,
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
