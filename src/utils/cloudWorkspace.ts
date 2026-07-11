import type { PeriodType, PredictionPoint } from '../types.ts';
import type { ForecastHistorySnapshot } from './forecastHistory.ts';

export interface CloudWorkspaceScope {
  stockCode: string;
  period: PeriodType;
}

export interface CloudWorkspace {
  schema: 'gupiao-cloud-workspace/v1';
  workspace: {
    stockCode: string;
    period: PeriodType;
    baseDate: string;
  };
  predictions: Record<string, PredictionPoint[]>;
  forecastHistory: Record<string, ForecastHistorySnapshot[]>;
  updatedAt: string;
}

interface LegacyBackup {
  schema?: string;
  storage?: Record<string, unknown>;
}

export interface CloudWorkspaceSaveQueueOptions {
  accountId: string;
  revision: number;
  debounceMs?: number;
  save: (request: { payload: CloudWorkspace; expectedRevision: number }) => Promise<{
    revision: number;
    payload: CloudWorkspace;
  }>;
  onStatusChange?: (status: CloudWorkspaceSaveStatus) => void;
}

export type CloudWorkspaceSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const PREDICTION_KEY = /^prediction-ma:(\d{6}):(day|week|month):v2$/;
const HISTORY_KEY = /^prediction-ma:forecast-history:(\d{6}):(day|week|month):v1$/;

export function createEmptyCloudWorkspace(): CloudWorkspace {
  return {
    schema: 'gupiao-cloud-workspace/v1',
    workspace: { stockCode: '000166', period: 'month', baseDate: '' },
    predictions: {},
    forecastHistory: {},
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Legacy exports can be imported once as a user baseline. Market K-line cache
 * records are deliberately ignored: they are fetched live and never synced.
 */
export function createCloudWorkspaceFromLegacyBackup(value: unknown): CloudWorkspace {
  const backup = value as LegacyBackup;
  if (backup?.schema !== 'gupiao-ma40-full-backup/v1' || !backup.storage) {
    throw new Error('Backup is not a supported full data export.');
  }

  const workspace = createEmptyCloudWorkspace();
  for (const [key, raw] of Object.entries(backup.storage)) {
    const predictionMatch = PREDICTION_KEY.exec(key);
    if (predictionMatch) {
      const rows = parsePredictionRows(raw);
      if (rows.length) workspace.predictions[toScopeKey(predictionMatch[1], predictionMatch[2] as PeriodType)] = rows;
      continue;
    }

    const historyMatch = HISTORY_KEY.exec(key);
    if (historyMatch) {
      const snapshots = parseHistoryRows(raw);
      if (snapshots.length) workspace.forecastHistory[toScopeKey(historyMatch[1], historyMatch[2] as PeriodType)] = snapshots;
    }
  }

  workspace.workspace = typeof backup.storage['prediction-ma40:last-workspace'] === 'string'
    ? parseWorkspaceSelection(backup.storage['prediction-ma40:last-workspace'], workspace.workspace)
    : workspace.workspace;
  return workspace;
}

export function getWorkspacePredictions(workspace: CloudWorkspace, scope: CloudWorkspaceScope) {
  return clonePredictionRows(workspace.predictions[toScopeKey(scope.stockCode, scope.period)] ?? []);
}

export function setWorkspacePredictions(
  workspace: CloudWorkspace,
  scope: CloudWorkspaceScope,
  rows: PredictionPoint[],
) {
  return {
    ...workspace,
    predictions: {
      ...workspace.predictions,
      [toScopeKey(scope.stockCode, scope.period)]: clonePredictionRows(rows),
    },
    updatedAt: new Date().toISOString(),
  } satisfies CloudWorkspace;
}

export function getWorkspaceForecastHistory(workspace: CloudWorkspace, scope: CloudWorkspaceScope) {
  return cloneForecastHistory(workspace.forecastHistory[toScopeKey(scope.stockCode, scope.period)] ?? []);
}

export function setWorkspaceForecastHistory(
  workspace: CloudWorkspace,
  scope: CloudWorkspaceScope,
  snapshots: ForecastHistorySnapshot[],
) {
  return {
    ...workspace,
    forecastHistory: {
      ...workspace.forecastHistory,
      [toScopeKey(scope.stockCode, scope.period)]: cloneForecastHistory(snapshots),
    },
    updatedAt: new Date().toISOString(),
  } satisfies CloudWorkspace;
}

export function createWorkspaceSaveQueue(options: CloudWorkspaceSaveQueueOptions) {
  let accountId = options.accountId;
  let revision = options.revision;
  let generation = 0;
  let pending: CloudWorkspace | null = null;
  let failed: CloudWorkspace | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<void> | null = null;
  let status: CloudWorkspaceSaveStatus = 'idle';
  let lastError: Error | null = null;

  const setStatus = (next: CloudWorkspaceSaveStatus) => {
    status = next;
    options.onStatusChange?.(next);
  };

  const start = async () => {
    if (active || !pending) return;
    const payload = pending;
    pending = null;
    const requestGeneration = generation;
    const requestAccountId = accountId;
    setStatus('saving');
    active = options
      .save({ payload: cloneWorkspace(payload), expectedRevision: revision })
      .then((result) => {
        if (generation !== requestGeneration || accountId !== requestAccountId) return;
        revision = result.revision;
        failed = null;
        lastError = null;
        setStatus('saved');
      })
      .catch((error: unknown) => {
        if (generation !== requestGeneration || accountId !== requestAccountId) return;
        failed = payload;
        lastError = error instanceof Error ? error : new Error(String(error));
        setStatus('error');
      })
      .finally(() => {
        active = null;
        if (generation !== requestGeneration || accountId !== requestAccountId) return;
        if (pending) void start();
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
    schedule(payload: CloudWorkspace) {
      pending = cloneWorkspace(payload);
      failed = null;
      lastError = null;
      arm();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await start();
      if (active) await active;
    },
    retry() {
      if (!failed) return;
      pending = failed;
      failed = null;
      lastError = null;
      arm();
    },
    switchAccount(nextAccountId: string, nextRevision: number) {
      generation += 1;
      accountId = nextAccountId;
      revision = nextRevision;
      pending = null;
      failed = null;
      lastError = null;
      if (timer) clearTimeout(timer);
      timer = null;
      setStatus('idle');
    },
    getStatus: () => status,
    getLastError: () => lastError,
  };
}

function toScopeKey(stockCode: string, period: PeriodType) {
  return `${stockCode.replace(/\D/g, '').slice(0, 6)}:${period}`;
}

function parsePredictionRows(raw: unknown): PredictionPoint[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row) => {
      if (!row || typeof row !== 'object' || typeof row.targetDate !== 'string') return [];
      const candidate = row as Partial<PredictionPoint> & { targetDate: string };
      return [{
        targetDate: candidate.targetDate,
        predictedMa40: typeof candidate.predictedMa40 === 'string' ? candidate.predictedMa40 : '',
        predictedMaValues: candidate.predictedMaValues && typeof candidate.predictedMaValues === 'object'
          ? Object.fromEntries(Object.entries(candidate.predictedMaValues).map(([key, item]) => [key, String(item ?? '')]))
          : {},
        note: typeof candidate.note === 'string' ? candidate.note : '',
      }];
    });
  } catch {
    return [];
  }
}

function parseHistoryRows(raw: unknown): ForecastHistorySnapshot[] {
  if (typeof raw !== 'string') return [];
  try {
    return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) as ForecastHistorySnapshot[] : [];
  } catch {
    return [];
  }
}

function parseWorkspaceSelection(raw: string, current: CloudWorkspace['workspace']) {
  try {
    const candidate = JSON.parse(raw) as Partial<CloudWorkspace['workspace']>;
    return {
      stockCode: typeof candidate.stockCode === 'string' ? candidate.stockCode.replace(/\D/g, '').slice(0, 6) || current.stockCode : current.stockCode,
      period: candidate.period === 'day' || candidate.period === 'week' || candidate.period === 'month' ? candidate.period : current.period,
      baseDate: typeof candidate.baseDate === 'string' ? candidate.baseDate : current.baseDate,
    };
  } catch {
    return current;
  }
}

function clonePredictionRows(rows: PredictionPoint[]) {
  return rows.map((row) => ({ ...row, predictedMaValues: { ...row.predictedMaValues } }));
}

function cloneForecastHistory(rows: ForecastHistorySnapshot[]) {
  return rows.map((row) => ({ ...row, predictedMaValues: { ...row.predictedMaValues } }));
}

function cloneWorkspace(workspace: CloudWorkspace): CloudWorkspace {
  return {
    ...workspace,
    workspace: { ...workspace.workspace },
    predictions: Object.fromEntries(Object.entries(workspace.predictions).map(([key, rows]) => [key, clonePredictionRows(rows)])),
    forecastHistory: Object.fromEntries(Object.entries(workspace.forecastHistory).map(([key, rows]) => [key, cloneForecastHistory(rows)])),
  };
}
