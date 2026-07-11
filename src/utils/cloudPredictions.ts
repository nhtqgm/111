import type { PeriodType, PredictionPoint } from '../types.ts';

export type PredictionMetric = 'close' | 'ma5' | 'ma10' | 'ma20' | 'ma40' | 'ma60';
export type PredictionEventType = 'set' | 'clear';

export interface PredictionScope {
  stockCode: string;
  period: PeriodType;
}

export interface PredictionEvent extends PredictionScope {
  id: string;
  targetDate: string;
  metric: PredictionMetric;
  eventType: PredictionEventType;
  value: string | null;
  deviceId: string;
  clientEventAt: string;
  createdAt: string;
}

interface BackupFile {
  schema?: string;
  storage?: Record<string, unknown>;
}

const MA_WINDOWS = [5, 10, 20, 40, 60] as const;
const predictionStorageKey = /^prediction-ma:(\d{6}):(day|week|month):v2$/;

export function createPredictionEventsFromRows(
  scope: PredictionScope,
  beforeRows: PredictionPoint[],
  afterRows: PredictionPoint[],
  deviceId: string,
  clientEventAt = new Date().toISOString(),
): PredictionEvent[] {
  const beforeByDate = new Map(beforeRows.map((row) => [row.targetDate, row]));

  return afterRows.flatMap((afterRow) => {
    const beforeRow = beforeByDate.get(afterRow.targetDate);
    return MA_WINDOWS.flatMap((windowSize) => {
      const metric = `ma${windowSize}` as PredictionMetric;
      const beforeValue = getMetricValue(beforeRow, windowSize);
      const afterValue = getMetricValue(afterRow, windowSize);
      if (beforeValue === afterValue) return [];

      return [
        {
          id: createEventId(),
          ...scope,
          targetDate: afterRow.targetDate,
          metric,
          eventType: afterValue === '' ? 'clear' : 'set',
          value: afterValue === '' ? null : afterValue,
          deviceId,
          clientEventAt,
          createdAt: clientEventAt,
        },
      ];
    });
  });
}

export function foldPredictionEvents(events: PredictionEvent[]) {
  const latest = new Map<string, PredictionEvent>();

  events.forEach((event) => {
    if (!isValidPredictionEvent(event)) return;
    const key = eventKey(event);
    const existing = latest.get(key);
    if (!existing || compareEventOrder(existing, event) < 0) {
      latest.set(key, event);
    }
  });

  return latest;
}

export function applyPredictionEventsToRows(
  rows: PredictionPoint[],
  scope: PredictionScope,
  events: Map<string, PredictionEvent>,
) {
  const rowsByDate = new Map(rows.map((row) => [row.targetDate, clonePredictionRow(row)]));

  events.forEach((event) => {
    if (event.stockCode !== scope.stockCode || event.period !== scope.period) return;
    const existing = rowsByDate.get(event.targetDate) ?? {
      targetDate: event.targetDate,
      predictedMa40: '',
      predictedMaValues: {},
      note: '',
    };
    const next = applyEventToRow(existing, event);
    rowsByDate.set(event.targetDate, next);
  });

  return [...rowsByDate.values()].sort((left, right) => left.targetDate.localeCompare(right.targetDate));
}

export function parsePredictionEventsFromFullBackup(
  value: unknown,
  deviceId: string,
  clientEventAt = new Date().toISOString(),
) {
  const backup = value as BackupFile;
  if (backup?.schema !== 'gupiao-ma40-full-backup/v1' || !backup.storage) {
    throw new Error('Backup is not a supported full data export.');
  }

  const events: PredictionEvent[] = [];
  let sequence = 0;
  Object.entries(backup.storage).forEach(([key, rawRows]) => {
    const match = key.match(predictionStorageKey);
    if (!match || typeof rawRows !== 'string') return;

    let rows: unknown;
    try {
      rows = JSON.parse(rawRows);
    } catch {
      return;
    }
    if (!Array.isArray(rows)) return;

    const scope: PredictionScope = { stockCode: match[1], period: match[2] as PeriodType };
    rows.forEach((rawRow) => {
      if (!rawRow || typeof rawRow !== 'object') return;
      const row = rawRow as Partial<PredictionPoint>;
      if (typeof row.targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.targetDate)) return;
      const targetDate = row.targetDate;

      MA_WINDOWS.forEach((windowSize) => {
        const value = getMetricValue(row, windowSize);
        if (value === '') return;
        sequence += 1;
        events.push({
          id: createBaselineEventId(deviceId, scope, targetDate, windowSize, value, sequence),
          ...scope,
          targetDate,
          metric: `ma${windowSize}` as PredictionMetric,
          eventType: 'set',
          value,
          deviceId,
          clientEventAt,
          createdAt: clientEventAt,
        });
      });
    });
  });

  return events;
}

export function eventKey(event: Pick<PredictionEvent, 'stockCode' | 'period' | 'targetDate' | 'metric'>) {
  return `${event.stockCode}:${event.period}:${event.targetDate}:${event.metric}`;
}

function getMetricValue(row: Partial<PredictionPoint> | undefined, windowSize: number) {
  if (!row) return '';
  const fromValues = row.predictedMaValues?.[String(windowSize)];
  const raw = fromValues ?? (windowSize === 40 ? row.predictedMa40 : '');
  return typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
}

function applyEventToRow(row: PredictionPoint, event: PredictionEvent): PredictionPoint {
  const windowSize = Number(event.metric.slice(2));
  const predictedMaValues = { ...row.predictedMaValues };
  if (event.eventType === 'clear') {
    delete predictedMaValues[String(windowSize)];
    return {
      ...row,
      predictedMa40: windowSize === 40 ? '' : row.predictedMa40,
      predictedMaValues,
    };
  }

  const value = event.value ?? '';
  return {
    ...row,
    predictedMa40: windowSize === 40 ? value : row.predictedMa40,
    predictedMaValues: { ...predictedMaValues, [String(windowSize)]: value },
  };
}

function compareEventOrder(left: PredictionEvent, right: PredictionEvent) {
  return (
    left.clientEventAt.localeCompare(right.clientEventAt) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function clonePredictionRow(row: PredictionPoint): PredictionPoint {
  return { ...row, predictedMaValues: { ...row.predictedMaValues } };
}

function createEventId() {
  return globalThis.crypto?.randomUUID?.() ?? `event-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createBaselineEventId(
  deviceId: string,
  scope: PredictionScope,
  targetDate: string,
  windowSize: number,
  value: string,
  sequence: number,
) {
  const source = [deviceId, scope.stockCode, scope.period, targetDate, windowSize, value, sequence].join('|');
  const hex = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => hashToHex(source, seed))
    .join('');
  const variant = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) & 3];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function hashToHex(value: string, seed: number) {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isValidPredictionEvent(event: PredictionEvent) {
  return (
    /^\d{6}$/.test(event.stockCode) &&
    ['day', 'week', 'month'].includes(event.period) &&
    /^\d{4}-\d{2}-\d{2}$/.test(event.targetDate) &&
    ['close', 'ma5', 'ma10', 'ma20', 'ma40', 'ma60'].includes(event.metric) &&
    ['set', 'clear'].includes(event.eventType) &&
    typeof event.clientEventAt === 'string' &&
    typeof event.createdAt === 'string' &&
    typeof event.id === 'string'
  );
}
