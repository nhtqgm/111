import type { KLinePoint, PeriodType, PredictionPoint } from '../types.ts';
import { queueElectronStorageSync } from './electronStorage.ts';
import { MA40_WINDOW, MA_WINDOWS, type MaWindow } from './movingAverage.ts';
import {
  generatePredictionRows,
  loadPredictions,
  normalizePredictionPoint,
  predictionPlanKey,
} from './predictions.ts';

export type PredictionPlanSource = 'manual' | 'imported' | 'copied' | 'migrated';

export interface PredictionPlan {
  id: string;
  name: string;
  stockCode: string;
  period: PeriodType;
  inputMaWindow: MaWindow;
  predictions: PredictionPoint[];
  note: string;
  createdAt: string;
  updatedAt: string;
  source?: PredictionPlanSource;
}

export interface PredictionPlanExportV1 {
  version: 'prediction-plan-v1';
  exportedAt: string;
  stockCode: string;
  stockName?: string;
  period: PeriodType;
  baseDate: string;
  appVersion?: string;
  plan: PredictionPlan;
}

export interface LoadPredictionPlansResult {
  plans: PredictionPlan[];
  activePlanId: string;
  migrated: boolean;
}

const PLAN_STORAGE_VERSION = 'v1';
const DEFAULT_PLAN_NAME = '默认方案';
export const PLAN_LIMIT = 30;

export function hasPredictionPlanCapacity(plans: PredictionPlan[]) {
  return plans.length < PLAN_LIMIT;
}

export function getPredictionPlansKey(stockCode: string, period: PeriodType) {
  return `prediction-ma:plans:${normalizeStockCode(stockCode)}:${period}:${PLAN_STORAGE_VERSION}`;
}

export function getActivePlanKey(stockCode: string, period: PeriodType) {
  return `prediction-ma:active-plan:${normalizeStockCode(stockCode)}:${period}:${PLAN_STORAGE_VERSION}`;
}

export function loadPredictionPlans(
  stockCode: string,
  period: PeriodType,
  baseDate: string,
  points: KLinePoint[],
  rowCount: number,
): LoadPredictionPlansResult {
  const normalizedStockCode = normalizeStockCode(stockCode);
  const rows = generatePredictionRows(points, period, baseDate, rowCount);
  const storedPlans = readStoredPlans(getPredictionPlansKey(normalizedStockCode, period));
  let migrated = false;

  const plans = storedPlans.length
    ? normalizePlanList(storedPlans, normalizedStockCode, period, rows)
    : migrateLegacyPredictions(normalizedStockCode, period, baseDate, rows);

  if (!storedPlans.length) migrated = true;

  const resolvedPlans = plans.length
    ? plans
    : [createDefaultPlan(normalizedStockCode, period, rows, 'manual')];
  const activePlanId = resolveActivePlanId(
    resolvedPlans,
    loadActivePlanId(normalizedStockCode, period),
  );

  if (migrated) {
    void savePredictionPlans(normalizedStockCode, period, resolvedPlans);
    void saveActivePlanId(normalizedStockCode, period, activePlanId);
  }

  return {
    plans: resolvedPlans,
    activePlanId,
    migrated,
  };
}

export function loadActivePlanId(stockCode: string, period: PeriodType) {
  const value = localStorage.getItem(getActivePlanKey(stockCode, period));
  return value?.trim() || null;
}

export function saveActivePlanId(stockCode: string, period: PeriodType, activePlanId: string) {
  localStorage.setItem(getActivePlanKey(stockCode, period), activePlanId);
  return queuePredictionPlanStorageSync();
}

export function savePredictionPlans(
  stockCode: string,
  period: PeriodType,
  plans: PredictionPlan[],
) {
  const normalizedStockCode = normalizeStockCode(stockCode);
  const normalizedPlans = plans.map((plan) =>
    normalizePredictionPlan(plan, normalizedStockCode, period, plan.predictions),
  );

  localStorage.setItem(
    getPredictionPlansKey(normalizedStockCode, period),
    JSON.stringify(normalizedPlans),
  );
  return queuePredictionPlanStorageSync();
}

export function createDefaultPlan(
  stockCode: string,
  period: PeriodType,
  rows: PredictionPoint[],
  source: PredictionPlanSource = 'manual',
): PredictionPlan {
  const now = new Date().toISOString();
  return {
    id: createPlanId(),
    name: DEFAULT_PLAN_NAME,
    stockCode: normalizeStockCode(stockCode),
    period,
    inputMaWindow: MA40_WINDOW,
    predictions: clonePredictionRows(rows),
    note: extractNote(rows),
    createdAt: now,
    updatedAt: now,
    source,
  };
}

export function createEmptyPlan(
  stockCode: string,
  period: PeriodType,
  rows: PredictionPoint[],
  existingPlans: PredictionPlan[],
): PredictionPlan {
  const now = new Date().toISOString();
  return {
    id: createPlanId(),
    name: makeUniquePlanName('新方案', existingPlans),
    stockCode: normalizeStockCode(stockCode),
    period,
    inputMaWindow: MA40_WINDOW,
    predictions: clonePredictionRows(rows),
    note: '',
    createdAt: now,
    updatedAt: now,
    source: 'manual',
  };
}

export function copyPredictionPlan(
  plan: PredictionPlan,
  existingPlans: PredictionPlan[],
): PredictionPlan {
  const now = new Date().toISOString();
  return {
    ...plan,
    id: createPlanId(),
    name: makeUniquePlanName(`${plan.name} 副本`, existingPlans),
    predictions: clonePredictionRows(plan.predictions),
    createdAt: now,
    updatedAt: now,
    source: 'copied',
  };
}

export function importPredictionPlan(
  plan: PredictionPlan,
  stockCode: string,
  period: PeriodType,
  rows: PredictionPoint[],
  existingPlans: PredictionPlan[],
): PredictionPlan {
  const now = new Date().toISOString();
  const normalized = normalizePredictionPlan(plan, normalizeStockCode(stockCode), period, rows);
  return {
    ...normalized,
    id: createPlanId(),
    name: makeUniquePlanName(`${normalized.name || DEFAULT_PLAN_NAME} 导入`, existingPlans),
    predictions: syncPredictionRows(normalized.predictions, rows),
    createdAt: now,
    updatedAt: now,
    source: 'imported',
  };
}

export function syncPlanRows(plan: PredictionPlan, rows: PredictionPoint[]): PredictionPlan {
  return {
    ...plan,
    predictions: syncPredictionRows(plan.predictions, rows),
  };
}

export function renamePredictionPlan(
  plan: PredictionPlan,
  name: string,
  existingPlans: PredictionPlan[],
): PredictionPlan {
  return {
    ...plan,
    name: makeUniquePlanName(name, existingPlans.filter((item) => item.id !== plan.id)),
    updatedAt: new Date().toISOString(),
  };
}

export function resolveActivePlanId(plans: PredictionPlan[], activePlanId: string | null) {
  if (activePlanId && plans.some((plan) => plan.id === activePlanId)) return activePlanId;

  const latest = [...plans].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return latest?.id ?? '';
}

export function normalizePredictionPlan(
  value: unknown,
  stockCode: string,
  period: PeriodType,
  rows: PredictionPoint[],
): PredictionPlan {
  const normalizedStockCode = normalizeStockCode(stockCode);
  assertPredictionPlanOwnership(value, normalizedStockCode, period);
  const candidate = value as Partial<PredictionPlan> | null;
  const now = new Date().toISOString();
  const inputMaWindow = normalizeMaWindow(candidate?.inputMaWindow);
  const savedRows = Array.isArray(candidate?.predictions) ? candidate.predictions : [];

  return {
    id: typeof candidate?.id === 'string' && candidate.id.trim() ? candidate.id : createPlanId(),
    name: normalizePlanName(candidate?.name ?? DEFAULT_PLAN_NAME),
    stockCode: normalizedStockCode,
    period,
    inputMaWindow,
    predictions: syncPredictionRows(savedRows, rows),
    note: String(candidate?.note ?? extractNote(savedRows)),
    createdAt:
      typeof candidate?.createdAt === 'string' && candidate.createdAt.trim()
        ? candidate.createdAt
        : now,
    updatedAt:
      typeof candidate?.updatedAt === 'string' && candidate.updatedAt.trim()
        ? candidate.updatedAt
        : now,
    source: normalizePlanSource(candidate?.source),
  };
}

export function normalizePlanName(value: unknown) {
  const name = String(value ?? '').trim();
  return name || DEFAULT_PLAN_NAME;
}

export function makeUniquePlanName(name: string, plans: PredictionPlan[]) {
  const baseName = normalizePlanName(name);
  const existing = new Set(plans.map((plan) => plan.name));
  if (!existing.has(baseName)) return baseName;

  let index = 2;
  while (existing.has(`${baseName} ${index}`)) index += 1;
  return `${baseName} ${index}`;
}

export function createPredictionPlanExport(
  plan: PredictionPlan,
  stockName: string | undefined,
  baseDate: string,
  appVersion?: string,
): PredictionPlanExportV1 {
  return {
    version: 'prediction-plan-v1',
    exportedAt: new Date().toISOString(),
    stockCode: plan.stockCode,
    stockName,
    period: plan.period,
    baseDate,
    appVersion,
    plan: {
      ...plan,
      predictions: clonePredictionRows(plan.predictions),
    },
  };
}

export function normalizePredictionPlanExport(value: unknown): PredictionPlanExportV1 | null {
  const candidate = value as Partial<PredictionPlanExportV1> | null;
  if (
    candidate?.version !== 'prediction-plan-v1' ||
    typeof candidate.stockCode !== 'string' ||
    !isPeriodType(candidate.period) ||
    typeof candidate.baseDate !== 'string' ||
    !candidate.plan ||
    typeof candidate.plan !== 'object' ||
    Array.isArray(candidate.plan)
  ) {
    return null;
  }

  const normalizedStockCode = normalizeStockCode(candidate.stockCode);
  if (hasConflictingPlanOwnership(candidate.plan, normalizedStockCode, candidate.period)) {
    return null;
  }

  return {
    version: 'prediction-plan-v1',
    exportedAt:
      typeof candidate.exportedAt === 'string'
        ? candidate.exportedAt
        : new Date().toISOString(),
    stockCode: normalizedStockCode,
    stockName: typeof candidate.stockName === 'string' ? candidate.stockName : undefined,
    period: candidate.period,
    baseDate: candidate.baseDate,
    appVersion: typeof candidate.appVersion === 'string' ? candidate.appVersion : undefined,
    plan: {
      ...candidate.plan,
      stockCode: normalizedStockCode,
      period: candidate.period,
    },
  };
}

export function normalizeStockCode(value: string) {
  return value.replace(/\D/g, '').slice(0, 6);
}

function migrateLegacyPredictions(
  stockCode: string,
  period: PeriodType,
  baseDate: string,
  rows: PredictionPoint[],
) {
  const legacyRows =
    loadPredictions(predictionPlanKey(stockCode, period, baseDate)) ??
    loadPredictions(legacyPredictionPlanKey(stockCode, period, baseDate)) ??
    [];

  return legacyRows.length
    ? [
        {
          ...createDefaultPlan(stockCode, period, syncPredictionRows(legacyRows, rows), 'migrated'),
          note: extractNote(legacyRows),
        },
      ]
    : [];
}

function readStoredPlans(key: string) {
  const raw = localStorage.getItem(key);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizePlanList(
  plans: unknown[],
  stockCode: string,
  period: PeriodType,
  rows: PredictionPoint[],
) {
  const normalized = plans
    .filter((plan) => !hasConflictingPlanOwnership(plan, stockCode, period))
    .map((plan) => normalizePredictionPlan(plan, stockCode, period, rows))
    .filter((plan) => plan.stockCode === stockCode && plan.period === period);
  return deduplicatePlanIds(normalized);
}

function syncPredictionRows(savedRows: unknown[], rows: PredictionPoint[]) {
  const normalizedRows = savedRows.map(normalizePredictionPoint);
  return rows.map((row) => {
    const saved = normalizedRows.find((item) => item.targetDate === row.targetDate);
    if (!saved) return { ...row };

    const predictedMaValues = {
      ...row.predictedMaValues,
      ...Object.fromEntries(
        Object.entries(saved.predictedMaValues).filter(([, value]) => value.trim() !== ''),
      ),
    };
    const predictedMa40 =
      saved.predictedMa40.trim() !== '' ? saved.predictedMa40 : predictedMaValues['40'] ?? '';

    return {
      ...row,
      predictedMa40,
      predictedMaValues,
      note: row.note.trim() === '' ? saved.note : row.note,
    };
  });
}

function clonePredictionRows(rows: PredictionPoint[]) {
  return rows.map((row) => ({
    ...row,
    predictedMaValues: { ...row.predictedMaValues },
  }));
}

function extractNote(rows: Array<Partial<PredictionPoint>>) {
  return String(rows.find((row) => row.note?.trim())?.note ?? '');
}

function normalizeMaWindow(value: unknown): MaWindow {
  const parsed = Number(value);
  return MA_WINDOWS.includes(parsed as MaWindow) ? (parsed as MaWindow) : MA40_WINDOW;
}

function normalizePlanSource(value: unknown): PredictionPlanSource | undefined {
  return ['manual', 'imported', 'copied', 'migrated'].includes(String(value))
    ? (value as PredictionPlanSource)
    : undefined;
}

function deduplicatePlanIds(plans: PredictionPlan[]) {
  const seen = new Set<string>();
  return plans.map((plan) => {
    if (!seen.has(plan.id)) {
      seen.add(plan.id);
      return plan;
    }

    const id = createPlanId();
    seen.add(id);
    return { ...plan, id };
  });
}

function assertPredictionPlanOwnership(
  value: unknown,
  stockCode: string,
  period: PeriodType,
) {
  if (hasConflictingPlanOwnership(value, stockCode, period)) {
    throw new Error(`Prediction plan ownership conflicts with ${stockCode}/${period}`);
  }
}

function hasConflictingPlanOwnership(
  value: unknown,
  stockCode: string,
  period: PeriodType,
) {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  const hasStockCode = Object.prototype.hasOwnProperty.call(candidate, 'stockCode');
  if (
    hasStockCode &&
    (typeof candidate.stockCode !== 'string' ||
      normalizeStockCode(candidate.stockCode) !== stockCode)
  ) {
    return true;
  }

  const hasPeriod = Object.prototype.hasOwnProperty.call(candidate, 'period');
  return hasPeriod && (!isPeriodType(candidate.period) || candidate.period !== period);
}

function queuePredictionPlanStorageSync() {
  if (typeof window === 'undefined') return Promise.resolve();
  return queueElectronStorageSync(localStorage, window.appStorageApi);
}

function legacyPredictionPlanKey(stockCode: string, period: PeriodType, baseDate: string) {
  return `prediction-ma40:${normalizeStockCode(stockCode)}:${period}:${baseDate}:v1`;
}

function isPeriodType(value: unknown): value is PeriodType {
  return value === 'day' || value === 'week' || value === 'month';
}

function createPlanId() {
  return globalThis.crypto?.randomUUID?.() ?? `plan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
