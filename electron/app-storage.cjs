function isAppStorageKey(key) {
  return key.startsWith('prediction-ma40:') || key.startsWith('prediction-ma:');
}

function filterAppStorage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, storedValue]) => isAppStorageKey(key) && typeof storedValue === 'string',
    ),
  );
}

function parseStoredJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getUpdatedAt(value) {
  const parsed = parseStoredJson(value);
  if (!parsed || typeof parsed.updatedAt !== 'string') return null;
  const timestamp = Date.parse(parsed.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getPredictionScore(value) {
  const parsed = parseStoredJson(value);
  if (!Array.isArray(parsed)) return 0;

  return parsed.reduce((total, row) => {
    if (!row || typeof row !== 'object') return total;
    const direct = typeof row.predictedMa40 === 'string' && row.predictedMa40.trim() ? 1 : 0;
    const values =
      row.predictedMaValues && typeof row.predictedMaValues === 'object'
        ? Object.values(row.predictedMaValues).filter(
            (item) => typeof item === 'string' && item.trim() !== '',
          ).length
        : 0;
    const note = typeof row.note === 'string' && row.note.trim() ? 0.25 : 0;
    return total + direct + values + note;
  }, 0);
}

function getReplaySnapshotUpdatedAt(snapshot) {
  if (typeof snapshot.updatedAt !== 'string') return null;
  const timestamp = Date.parse(snapshot.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function chooseReplaySnapshot(existingSnapshot, incomingSnapshot) {
  const existingUpdatedAt = getReplaySnapshotUpdatedAt(existingSnapshot);
  const incomingUpdatedAt = getReplaySnapshotUpdatedAt(incomingSnapshot);
  if (existingUpdatedAt !== null || incomingUpdatedAt !== null) {
    if (existingUpdatedAt === null) return incomingSnapshot;
    if (incomingUpdatedAt === null) return existingSnapshot;
    if (incomingUpdatedAt !== existingUpdatedAt) {
      return incomingUpdatedAt > existingUpdatedAt ? incomingSnapshot : existingSnapshot;
    }
  }

  // Equal or unusable timestamps use stable content ordering, never source order.
  return stableSerialize(incomingSnapshot) > stableSerialize(existingSnapshot)
    ? incomingSnapshot
    : existingSnapshot;
}

function getReplaySnapshotIdentity(snapshot) {
  if (
    typeof snapshot.stockCode !== 'string' ||
    !['day', 'week', 'month'].includes(snapshot.period) ||
    typeof snapshot.baseDate !== 'string' ||
    typeof snapshot.targetDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.baseDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.targetDate) ||
    !Number.isInteger(snapshot.inputMaWindow)
  ) {
    return snapshot.id;
  }

  const stockCode = snapshot.stockCode.replace(/\D/g, '').slice(0, 6);
  const planId = typeof snapshot.planId === 'string' && snapshot.planId.trim()
    ? snapshot.planId.trim()
    : null;
  const suffix = `${snapshot.baseDate}:${snapshot.targetDate}:MA${snapshot.inputMaWindow}`;
  const ownerId = planId ? `owner~plan~${encodeURIComponent(planId)}` : 'owner~legacy';
  const canonicalId = `${stockCode}:${snapshot.period}:${ownerId}:${suffix}`;
  const supportedIds = planId
    ? [`${stockCode}:${snapshot.period}:${planId}:${suffix}`]
    : [
        `${stockCode}:${snapshot.period}:legacy:${suffix}`,
        `${stockCode}:${snapshot.period}:${suffix}`,
      ];
  if (snapshot.id === canonicalId || supportedIds.includes(snapshot.id)) return canonicalId;
  return snapshot.id;
}

function reconcileReplayStorage(existingValue, incomingValue) {
  const existing = parseStoredJson(existingValue);
  const incoming = parseStoredJson(incomingValue);
  const existingIsArray = Array.isArray(existing);
  const incomingIsArray = Array.isArray(incoming);
  const snapshots = [
    ...(existingIsArray ? existing : []),
    ...(incomingIsArray ? incoming : []),
  ].filter(
    (snapshot) =>
      snapshot &&
      typeof snapshot === 'object' &&
      !Array.isArray(snapshot) &&
      typeof snapshot.id === 'string' &&
      snapshot.id.trim(),
  );

  if (!snapshots.length) {
    if (existingIsArray) return existingValue;
    if (incomingIsArray) return incomingValue;
    return existingValue;
  }

  const byId = new Map();
  snapshots.forEach((snapshot) => {
    const id = getReplaySnapshotIdentity(snapshot);
    const normalizedSnapshot = id === snapshot.id ? snapshot : { ...snapshot, id };
    const current = byId.get(id);
    byId.set(id, current ? chooseReplaySnapshot(current, normalizedSnapshot) : normalizedSnapshot);
  });

  return JSON.stringify([...byId.values()].sort((a, b) => a.id.localeCompare(b.id)));
}

function chooseStoredValue(key, existingValue, incomingValue) {
  if (key.startsWith('prediction-ma:replay:')) {
    return reconcileReplayStorage(existingValue, incomingValue);
  }

  if (existingValue === incomingValue) return existingValue;

  const existingUpdatedAt = getUpdatedAt(existingValue);
  const incomingUpdatedAt = getUpdatedAt(incomingValue);
  if (existingUpdatedAt !== null || incomingUpdatedAt !== null) {
    if (existingUpdatedAt === null) return incomingValue;
    if (incomingUpdatedAt === null) return existingValue;
    return incomingUpdatedAt > existingUpdatedAt ? incomingValue : existingValue;
  }

  if (key.startsWith('prediction-ma:')) {
    return getPredictionScore(incomingValue) > getPredictionScore(existingValue)
      ? incomingValue
      : existingValue;
  }

  return existingValue;
}

function mergeAppStorage(existingValue, incomingValue) {
  const existing = filterAppStorage(existingValue);
  const incoming = filterAppStorage(incomingValue);
  const merged = Object.fromEntries(
    Object.entries(existing).map(([key, value]) => [
      key,
      key.startsWith('prediction-ma:replay:')
        ? reconcileReplayStorage(value, value)
        : value,
    ]),
  );

  Object.entries(incoming).forEach(([key, value]) => {
    const normalizedValue = key.startsWith('prediction-ma:replay:')
      ? reconcileReplayStorage(value, value)
      : value;
    merged[key] = Object.prototype.hasOwnProperty.call(merged, key)
      ? chooseStoredValue(key, merged[key], normalizedValue)
      : normalizedValue;
  });

  return merged;
}

function isSameStorage(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

function createAppStorageStore(directory, options = {}) {
  const maxBackups = Number.isInteger(options.maxBackups) ? options.maxBackups : 5;
  const storagePath = path.join(directory, 'app-cache-v1.json');
  const backupDirectory = path.join(directory, 'backups');
  let writeQueue = Promise.resolve();

  async function loadDocument() {
    try {
      const parsed = JSON.parse(await fs.readFile(storagePath, 'utf8'));
      return {
        schema: STORAGE_SCHEMA,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
        migrationCompletedAt:
          typeof parsed.migrationCompletedAt === 'string' ? parsed.migrationCompletedAt : null,
        storage: filterAppStorage(parsed.storage),
      };
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
        return {
          schema: STORAGE_SCHEMA,
          updatedAt: null,
          migrationCompletedAt: null,
          storage: {},
        };
      }
      throw error;
    }
  }

  async function hasStorageFile() {
    try {
      await fs.access(storagePath);
      return true;
    } catch {
      return false;
    }
  }

  async function pruneBackups() {
    if (maxBackups <= 0) return;
    const entries = await fs.readdir(backupDirectory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    await Promise.all(
      files.slice(maxBackups).map((name) => fs.rm(path.join(backupDirectory, name), { force: true })),
    );
  }

  async function backupCurrentFile() {
    if (!(await hasStorageFile()) || maxBackups <= 0) return;
    await fs.mkdir(backupDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.copyFile(storagePath, path.join(backupDirectory, `app-cache-${stamp}.json`));
    await pruneBackups();
  }

  async function writeDocument(document, { backup = true } = {}) {
    await fs.mkdir(directory, { recursive: true });
    if (backup) await backupCurrentFile();

    const temporaryPath = `${storagePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, storagePath);
  }

  function enqueue(operation) {
    const next = writeQueue.then(operation, operation);
    writeQueue = next.catch(() => undefined);
    return next;
  }

  return {
    async load() {
      return (await loadDocument()).storage;
    },

    replace(storage) {
      return enqueue(async () => {
        const current = await loadDocument();
        await writeDocument({
          ...current,
          schema: STORAGE_SCHEMA,
          updatedAt: new Date().toISOString(),
          storage: filterAppStorage(storage),
        });
      });
    },

    bootstrap(storage) {
      return enqueue(async () => {
        const current = await loadDocument();
        const merged = mergeAppStorage(current.storage, storage);
        if (!isSameStorage(current.storage, merged)) {
          await writeDocument({
            ...current,
            schema: STORAGE_SCHEMA,
            updatedAt: new Date().toISOString(),
            storage: merged,
          });
        }
        return merged;
      });
    },

    async needsLegacyMigration() {
      return !(await loadDocument()).migrationCompletedAt;
    },

    completeLegacyMigration(storage) {
      return enqueue(async () => {
        const current = await loadDocument();
        if (current.migrationCompletedAt) return;
        await writeDocument({
          ...current,
          schema: STORAGE_SCHEMA,
          updatedAt: new Date().toISOString(),
          migrationCompletedAt: new Date().toISOString(),
          storage: mergeAppStorage(current.storage, storage),
        });
      });
    },
  };
}

module.exports = {
  createAppStorageStore,
  filterAppStorage,
  mergeAppStorage,
};
const fs = require('node:fs/promises');
const path = require('node:path');

const STORAGE_SCHEMA = 'gupiao-electron-cache/v1';
