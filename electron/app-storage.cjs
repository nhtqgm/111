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

function isPredictionTableKey(key) {
  return /^prediction-ma:\d{6}:(day|week|month):v2$/.test(key);
}

function getWorkspaceUpdatedAt(storage) {
  return getUpdatedAt(storage['prediction-ma40:last-workspace']);
}

function choosePredictionValue(
  existingValue,
  incomingValue,
  existingWorkspaceUpdatedAt,
  incomingWorkspaceUpdatedAt,
) {
  const existingScore = getPredictionScore(existingValue);
  const incomingScore = getPredictionScore(incomingValue);

  // Never let a generated blank table erase a real prediction table.
  if (existingScore === 0 && incomingScore > 0) return incomingValue;
  if (incomingScore === 0 && existingScore > 0) return existingValue;

  // Prediction rows themselves do not carry updatedAt. The workspace timestamp is
  // written in the same save operation, so it is the only reliable ordering signal.
  if (existingWorkspaceUpdatedAt !== null || incomingWorkspaceUpdatedAt !== null) {
    if (existingWorkspaceUpdatedAt === null) return incomingValue;
    if (incomingWorkspaceUpdatedAt === null) return existingValue;
    if (incomingWorkspaceUpdatedAt !== existingWorkspaceUpdatedAt) {
      return incomingWorkspaceUpdatedAt > existingWorkspaceUpdatedAt ? incomingValue : existingValue;
    }
  }

  return incomingScore > existingScore ? incomingValue : existingValue;
}

function chooseStoredValue(key, existingValue, incomingValue, timestamps = {}) {
  if (existingValue === incomingValue) return existingValue;

  if (isPredictionTableKey(key)) {
    return choosePredictionValue(
      existingValue,
      incomingValue,
      timestamps.existingWorkspaceUpdatedAt ?? null,
      timestamps.incomingWorkspaceUpdatedAt ?? null,
    );
  }

  const existingUpdatedAt = getUpdatedAt(existingValue);
  const incomingUpdatedAt = getUpdatedAt(incomingValue);
  if (existingUpdatedAt !== null || incomingUpdatedAt !== null) {
    if (existingUpdatedAt === null) return incomingValue;
    if (incomingUpdatedAt === null) return existingValue;
    return incomingUpdatedAt > existingUpdatedAt ? incomingValue : existingValue;
  }

  return existingValue;
}

function mergeAppStorage(existingValue, incomingValue) {
  const existing = filterAppStorage(existingValue);
  const incoming = filterAppStorage(incomingValue);
  const merged = { ...existing };
  const timestamps = {
    existingWorkspaceUpdatedAt: getWorkspaceUpdatedAt(existing),
    incomingWorkspaceUpdatedAt: getWorkspaceUpdatedAt(incoming),
  };

  Object.entries(incoming).forEach(([key, value]) => {
    merged[key] = Object.prototype.hasOwnProperty.call(merged, key)
      ? chooseStoredValue(key, merged[key], value, timestamps)
      : value;
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
