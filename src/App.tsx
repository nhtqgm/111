import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import packageJson from '../package.json';
import KLineChart, {
  type ChartLineSeries,
  type ChartPointSeries,
} from './components/KLineChart';
import { fetchKLines } from './services/eastmoney';
import type { PeriodType, PredictionPoint, StockKLineResponse } from './types';
import { filterCompletedKLineData } from './utils/completedPeriods';
import {
  AppStorageRestoreError,
  collectAppStorage,
  EmptyAppStorageSnapshotError,
  normalizeAppStorageSnapshot,
  queueElectronStorageSync,
  restoreAppStorageTransaction,
} from './utils/electronStorage';
import { compareProjectionRows, formatNumber, summarizeComparisons } from './utils/metrics';
import {
  buildMa40Projection,
  type LineValuePoint,
  type Ma40ProjectionRow,
  MA40_WINDOW,
  MA_WINDOWS,
  type MaWindow,
} from './utils/movingAverage';
import {
  generatePredictionRows,
  loadKLineCache,
  loadWorkspaceCache,
  normalizePredictionPoint,
  saveKLineCache,
  saveWorkspaceCache,
} from './utils/predictions';
import {
  copyPredictionPlan,
  createEmptyPlan,
  createPredictionPlanExport,
  importPredictionPlan,
  hasPredictionPlanCapacity,
  loadPredictionPlans,
  normalizePredictionPlanExport,
  normalizeStockCode,
  PLAN_LIMIT,
  renamePredictionPlan,
  resolveActivePlanId,
  saveActivePlanId,
  savePredictionPlans,
  type PredictionPlan,
} from './utils/predictionPlans';
import {
  buildReplayReviewRows,
  createReplaySnapshotsFromProjection,
  filterReplayRowsByPlan,
  loadReplaySnapshots,
  mergeReplaySnapshots,
  resolveReplayPlanFilter,
  saveReplaySnapshots,
  summarizeReplayRows,
  type ReplayPlanFilter,
  type ReplayReviewRow,
  type ReplaySummary,
  type ReplaySnapshot,
} from './utils/replay';
import { createStableAutosave, runWorkspaceTransition } from './utils/stableAutosave';
import {
  canConsumeDeferredPlanImport,
  getStockPeriodWorkspaceKey,
  isLoadedWorkspaceReady,
} from './utils/workspaceContext';

const periods: Array<{ value: PeriodType; label: string; unit: string }> = [
  { value: 'day', label: '日K', unit: '日' },
  { value: 'week', label: '周K', unit: '周' },
  { value: 'month', label: '月K', unit: '月' },
];

const forecastRowCount = 40;
const minHistoryCount = 60;
const todayDate = formatDate(new Date());
const initialWorkspace = loadWorkspaceCache();
const appVersion = packageJson.version;
const planLimitWarning = `每只股票的每个周期最多保留 ${PLAN_LIMIT} 个方案，请先删除一个方案`;
const electronPersistenceWarning = '数据已保存在当前页面，但 EXE 持久化失败，请再次点击保存';
const emptyBackupWarning = '导入失败：备份中没有有效的应用数据，原数据未更改';
const backupRestoreFailureWarning = '全部数据导入失败：EXE 持久化失败，原数据已恢复';
const updateManifestUrl = 'https://nhtqgm.github.io/111/update.json';
const lineColors: Record<MaWindow, string> = {
  5: '#2f7893',
  10: '#a87935',
  20: '#5f7d5d',
  40: '#8f4d6b',
  60: '#555a9b',
};

interface PredictionFileV5 {
  schema: 'gupiao-ma40-predictions/v1';
  exportedAt: string;
  stockCode: string;
  stockName?: string;
  period: PeriodType;
  baseDate: string;
  predictions: PredictionPoint[];
}

interface ImportedPredictionPlan {
  stockCode: string;
  period: PeriodType;
  plan: PredictionPlan;
}

interface FullBackupFileV1 {
  schema: 'gupiao-ma40-full-backup/v1';
  exportedAt: string;
  appVersion: string;
  storage: Record<string, string>;
}

interface UpdateManifest {
  app: 'gupiao-ma40';
  version: string;
  url: string;
  notes?: string;
  publishedAt?: string;
}

interface UpdateState {
  status: 'idle' | 'checking' | 'current' | 'available' | 'error';
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  notes?: string;
}

export default function App() {
  const [stockCode, setStockCode] = useState(initialWorkspace?.stockCode ?? '000166');
  const [queryCode, setQueryCode] = useState(initialWorkspace?.stockCode ?? '000166');
  const [period, setPeriod] = useState<PeriodType>(initialWorkspace?.period ?? 'month');
  const [data, setData] = useState<StockKLineResponse | null>(null);
  const [dataWorkspaceKey, setDataWorkspaceKey] = useState<string | null>(null);
  const [baseDate, setBaseDate] = useState(todayDate);
  const [plans, setPlans] = useState<PredictionPlan[]>([]);
  const [plansWorkspaceKey, setPlansWorkspaceKey] = useState<string | null>(null);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [visibleMaWindows, setVisibleMaWindows] = useState<MaWindow[]>([5, 10, 20, 40, 60]);
  const [showActualMaLines, setShowActualMaLines] = useState(false);
  const [isTableExpanded, setIsTableExpanded] = useState(false);
  const [isReplayModalOpen, setIsReplayModalOpen] = useState(false);
  const [replayPlanFilter, setReplayPlanFilter] = useState<ReplayPlanFilter>('active');
  const [detailTargetDate, setDetailTargetDate] = useState<string | null>(null);
  const [replayDetailId, setReplayDetailId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [replaySnapshots, setReplaySnapshots] = useState<ReplaySnapshot[]>([]);
  const [updateState, setUpdateState] = useState<UpdateState>({
    status: 'idle',
    currentVersion: appVersion,
  });
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'success' | 'warning' } | null>(
    null,
  );
  const requestedWorkspaceKey = getStockPeriodWorkspaceKey(queryCode, period);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importedPlanRef = useRef<ImportedPredictionPlan | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const lastSavedSignatureRef = useRef('');
  const autosaveRef = useRef<ReturnType<typeof createStableAutosave> | null>(null);
  const backupRestoreInProgressRef = useRef(false);
  const requestedWorkspaceKeyRef = useRef(requestedWorkspaceKey);
  requestedWorkspaceKeyRef.current = requestedWorkspaceKey;

  const loadedWorkspaceReady = isLoadedWorkspaceReady(
    requestedWorkspaceKey,
    dataWorkspaceKey,
    plansWorkspaceKey,
  );

  const activePlan = useMemo(
    () => plans.find((plan) => plan.id === activePlanId) ?? null,
    [activePlanId, plans],
  );
  const predictions = activePlan?.predictions ?? [];
  const inputMaWindow = activePlan?.inputMaWindow ?? MA40_WINDOW;

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      checkAppUpdate({ silent: true });
    }, 1500);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (
      backupRestoreInProgressRef.current ||
      requestedWorkspaceKeyRef.current !== requestedWorkspaceKey
    ) {
      return;
    }

    const cached = loadKLineCache(queryCode, period);
    setError('');
    setData(null);
    setDataWorkspaceKey(null);
    setPlans([]);
    setPlansWorkspaceKey(null);
    setActivePlanId(null);
    setReplaySnapshots([]);

    if (!cached) {
      setBaseDate(todayDate);
      showToast('暂无本地历史数据，请点击“联网更新”拉取最近历史收盘价', 'warning');
      return;
    }

    const completed = filterCompletedKLineData(markAsLocalCache(cached.data), period);
    const loadedDataKey = getStockPeriodWorkspaceKey(completed.data.code, period);
    if (loadedDataKey !== requestedWorkspaceKey) {
      setBaseDate(todayDate);
      showToast('本地历史数据与当前股票周期不匹配，请联网更新', 'warning');
      return;
    }
    setData(completed.data);
    setDataWorkspaceKey(loadedDataKey);
    setBaseDate(completed.lastCompletedDate ?? todayDate);
    showToast(
      formatHistoryStatus(cached.updatedAt, completed.data.points.length, completed.removedPoints.length),
      'info',
    );
    if (completed.data.points.length < minHistoryCount) {
      setError(`本地历史数据不足${minHistoryCount}条，MA60计算可能不完整，请联网更新一次`);
    }
  }, [period, queryCode, requestedWorkspaceKey]);

  useEffect(() => {
    if (
      backupRestoreInProgressRef.current ||
      requestedWorkspaceKeyRef.current !== requestedWorkspaceKey ||
      !data ||
      !baseDate ||
      dataWorkspaceKey !== requestedWorkspaceKey
    ) {
      return;
    }

    const loaded = loadPredictionPlans(data.code, period, baseDate, data.points, forecastRowCount);
    if (loaded.migrated) {
      void queueElectronStorageSync().catch(() => {
        showToast(electronPersistenceWarning, 'warning');
      });
    }
    let nextPlans = loaded.plans;
    let nextActivePlanId = loaded.activePlanId;
    const importedPlan = importedPlanRef.current;
    if (
      importedPlan &&
      canConsumeDeferredPlanImport(importedPlan, requestedWorkspaceKey, dataWorkspaceKey)
    ) {
      importedPlanRef.current = null;
      if (!hasPredictionPlanCapacity(nextPlans)) {
        showToast(planLimitWarning, 'warning');
      } else {
        const rows = generatePredictionRows(data.points, period, baseDate, forecastRowCount);
        const imported = importPredictionPlan(
          importedPlan.plan,
          data.code,
          period,
          rows,
          nextPlans,
        );
        nextPlans = [...nextPlans, imported];
        nextActivePlanId = imported.id;
        saveWorkspaceCache({
          stockCode: data.code,
          period,
          baseDate,
          updatedAt: new Date().toISOString(),
        });
        void Promise.all([
          savePredictionPlans(data.code, period, nextPlans),
          saveActivePlanId(data.code, period, nextActivePlanId),
        ]).catch(() => showToast(electronPersistenceWarning, 'warning'));
        showToast('预测文件已加载', 'success');
      }
    }

    setPlans(nextPlans);
    setPlansWorkspaceKey(requestedWorkspaceKey);
    setActivePlanId(nextActivePlanId);
    lastSavedSignatureRef.current = createWorkspaceSignature(
      data.code,
      period,
      baseDate,
      nextPlans,
      nextActivePlanId,
    );
    setHasUnsavedChanges(false);
  }, [baseDate, data, dataWorkspaceKey, period, requestedWorkspaceKey]);

  useEffect(() => {
    if (
      backupRestoreInProgressRef.current ||
      requestedWorkspaceKeyRef.current !== requestedWorkspaceKey ||
      !data ||
      dataWorkspaceKey !== requestedWorkspaceKey
    ) {
      setReplaySnapshots([]);
      return;
    }

    setReplaySnapshots(loadReplaySnapshots(data.code, period));
  }, [data, dataWorkspaceKey, period, requestedWorkspaceKey]);

  useEffect(() => {
    if (
      backupRestoreInProgressRef.current ||
      requestedWorkspaceKeyRef.current !== requestedWorkspaceKey ||
      !loadedWorkspaceReady ||
      !data ||
      !baseDate ||
      !plans.length
    ) {
      return;
    }

    const signature = createWorkspaceSignature(data.code, period, baseDate, plans, activePlanId);
    setHasUnsavedChanges(signature !== lastSavedSignatureRef.current);
  }, [
    activePlanId,
    baseDate,
    data,
    loadedWorkspaceReady,
    period,
    plans,
    replaySnapshots,
    requestedWorkspaceKey,
  ]);

  useEffect(() => {
    const scheduler = createStableAutosave(
      () => saveCurrentWorkspace({ notice: 'auto' }),
      30000,
      {
        setInterval: (callback, delay) => window.setInterval(callback, delay),
        clearInterval: (id) => window.clearInterval(id as number),
      },
    );
    autosaveRef.current = scheduler;

    return () => {
      scheduler.dispose();
      if (autosaveRef.current === scheduler) autosaveRef.current = null;
    };
  }, []);

  useEffect(() => {
    autosaveRef.current?.update(() => saveCurrentWorkspace({ notice: 'auto' }));
  });

  function saveCurrentWorkspace({
    force = false,
    notice,
  }: {
    force?: boolean;
    notice: 'auto' | 'manual' | 'silent';
  }) {
    if (backupRestoreInProgressRef.current) return;
    if (requestedWorkspaceKeyRef.current !== requestedWorkspaceKey) return;

    if (!loadedWorkspaceReady || !data || !baseDate || !plans.length || !activePlanId) {
      if (notice === 'manual') {
        showToast('暂无可保存的数据', 'warning');
      }
      return;
    }

    if (!force && !hasUnsavedChanges) return;

    const signature = createWorkspaceSignature(data.code, period, baseDate, plans, activePlanId);
    if (!force && signature === lastSavedSignatureRef.current) {
      setHasUnsavedChanges(false);
      if (notice === 'manual') {
        showToast(`已保存：${new Date().toLocaleTimeString()}`, 'success');
      }
      return;
    }

    const now = new Date().toISOString();
    const persistenceWrites = [
      savePredictionPlans(data.code, period, plans),
      saveActivePlanId(data.code, period, activePlanId),
    ];
    saveWorkspaceCache({
      stockCode: data.code,
      period,
      baseDate,
      updatedAt: now,
    });
    let replaySnapshotCount = 0;
    let replaySnapshotFailed = false;
    try {
      const incomingReplaySnapshots = createReplaySnapshotsFromProjection({
        stockCode: data.code,
        stockName: data.name,
        period,
        baseDate,
        planId: activePlan?.id ?? null,
        planName: activePlan?.name ?? null,
        planNote: activePlan?.note ?? null,
        points: data.points,
        rows: projection.rows,
        inputMaWindow,
        existingSnapshots: replaySnapshots,
        now,
      });
      replaySnapshotCount = incomingReplaySnapshots.length;
      if (incomingReplaySnapshots.length) {
        const mergedSnapshots = mergeReplaySnapshots(
          replaySnapshots,
          incomingReplaySnapshots,
          data.points,
        );
        persistenceWrites.push(saveReplaySnapshots(data.code, period, mergedSnapshots));
        setReplaySnapshots(mergedSnapshots);
      }
    } catch {
      replaySnapshotFailed = true;
    }
    void Promise.all(persistenceWrites).catch(() => {
      showToast(electronPersistenceWarning, 'warning');
    });
    lastSavedSignatureRef.current = signature;
    setHasUnsavedChanges(false);

    if (notice === 'silent') return;

    if (replaySnapshotFailed && notice === 'manual') {
      showToast('预测已保存；复盘快照保存失败，不影响原预测数据', 'warning');
    } else {
      showToast(
        notice === 'auto'
          ? `已自动保存：${new Date().toLocaleTimeString()}`
          : `已保存：${new Date().toLocaleTimeString()}${
              replaySnapshotCount ? `，已记录复盘快照${replaySnapshotCount}条` : ''
            }`,
        'success',
      );
    }
  }

  function flushCurrentWorkspace() {
    saveCurrentWorkspace({ force: true, notice: 'silent' });
  }

  function invalidateLoadedWorkspace(nextWorkspaceKey: string) {
    requestedWorkspaceKeyRef.current = nextWorkspaceKey;
    setIsLoading(false);
    setData(null);
    setDataWorkspaceKey(null);
    setBaseDate(todayDate);
    setPlans([]);
    setPlansWorkspaceKey(null);
    setActivePlanId(null);
    setReplaySnapshots([]);
    setDetailTargetDate(null);
    setReplayDetailId(null);
    setHasUnsavedChanges(false);
    lastSavedSignatureRef.current = '';
  }

  function loadStockCode() {
    if (backupRestoreInProgressRef.current) return;
    const nextStockCode = normalizeStockCode(stockCode);
    if (nextStockCode === normalizeStockCode(queryCode)) return;
    const nextWorkspaceKey = getStockPeriodWorkspaceKey(nextStockCode, period);

    runWorkspaceTransition(hasUnsavedChanges, flushCurrentWorkspace, () => {
      invalidateLoadedWorkspace(nextWorkspaceKey);
      setQueryCode(nextStockCode);
    });
  }

  function changePeriod(nextPeriod: PeriodType) {
    if (backupRestoreInProgressRef.current) return;
    if (nextPeriod === period) return;
    const nextWorkspaceKey = getStockPeriodWorkspaceKey(queryCode, nextPeriod);

    runWorkspaceTransition(hasUnsavedChanges, flushCurrentWorkspace, () => {
      invalidateLoadedWorkspace(nextWorkspaceKey);
      setPeriod(nextPeriod);
    });
  }

  const projection = useMemo(
    () =>
      data && dataWorkspaceKey === requestedWorkspaceKey
        ? buildMa40Projection(data.points, predictions, baseDate, inputMaWindow)
        : {
            rows: [],
            actualLines: createEmptyLineMap(),
            predictedLines: createEmptyLineMap(),
            closeByDate: new Map<string, number>(),
          },
    [baseDate, data, dataWorkspaceKey, inputMaWindow, predictions, requestedWorkspaceKey],
  );
  const replayWorkspaceStockCode = normalizeStockCode(queryCode);
  const replayRows = useMemo(() => {
    if (
      !loadedWorkspaceReady ||
      !data ||
      normalizeStockCode(data.code) !== replayWorkspaceStockCode
    ) {
      return [];
    }

    const currentSnapshots = replaySnapshots.filter(
      (snapshot) =>
        normalizeStockCode(snapshot.stockCode) === replayWorkspaceStockCode &&
        snapshot.period === period,
    );
    return buildReplayReviewRows(currentSnapshots, data.points);
  }, [data, loadedWorkspaceReady, period, replaySnapshots, replayWorkspaceStockCode]);
  const replayCurrentPlans = useMemo(
    () =>
      loadedWorkspaceReady
        ? plans.filter(
            (plan) =>
              normalizeStockCode(plan.stockCode) === replayWorkspaceStockCode &&
              plan.period === period,
          )
        : [],
    [loadedWorkspaceReady, period, plans, replayWorkspaceStockCode],
  );
  const replayPlanOptions = useMemo(() => {
    const namesByPlanId = new Map(replayCurrentPlans.map((plan) => [plan.id, plan.name]));
    for (const row of replayRows) {
      if (row.planId && !namesByPlanId.has(row.planId)) {
        namesByPlanId.set(row.planId, row.planName?.trim() || '历史方案');
      }
    }

    return Array.from(namesByPlanId, ([id, name]) => ({ id, name }));
  }, [replayCurrentPlans, replayRows]);
  const knownReplayPlanIds = useMemo(
    () => new Set(replayPlanOptions.map((plan) => plan.id)),
    [replayPlanOptions],
  );
  const replayActivePlanId =
    activePlanId && replayCurrentPlans.some((plan) => plan.id === activePlanId)
      ? activePlanId
      : null;
  const hasLegacyReplayRows = useMemo(() => replayRows.some((row) => !row.planId), [replayRows]);
  const resolvedReplayPlanFilter = useMemo(
    () =>
      loadedWorkspaceReady
        ? resolveReplayPlanFilter(
            replayPlanFilter,
            replayActivePlanId,
            knownReplayPlanIds,
            hasLegacyReplayRows,
          )
        : replayPlanFilter,
    [
      hasLegacyReplayRows,
      knownReplayPlanIds,
      loadedWorkspaceReady,
      replayActivePlanId,
      replayPlanFilter,
    ],
  );
  useEffect(() => {
    if (
      backupRestoreInProgressRef.current ||
      requestedWorkspaceKeyRef.current !== requestedWorkspaceKey ||
      !loadedWorkspaceReady
    ) {
      return;
    }
    if (resolvedReplayPlanFilter !== replayPlanFilter) {
      setReplayPlanFilter(resolvedReplayPlanFilter);
    }
  }, [
    loadedWorkspaceReady,
    period,
    replayPlanFilter,
    replayWorkspaceStockCode,
    requestedWorkspaceKey,
    resolvedReplayPlanFilter,
  ]);
  const filteredReplayRows = useMemo(
    () => filterReplayRowsByPlan(replayRows, resolvedReplayPlanFilter, replayActivePlanId),
    [replayActivePlanId, replayRows, resolvedReplayPlanFilter],
  );
  const replaySummary = useMemo(() => summarizeReplayRows(filteredReplayRows), [filteredReplayRows]);
  const replayTotalSummary = useMemo(() => summarizeReplayRows(replayRows), [replayRows]);
  const predictionComparisons = useMemo(
    () => compareProjectionRows(projection.rows),
    [projection.rows],
  );
  const summary = useMemo(() => summarizeComparisons(predictionComparisons), [predictionComparisons]);
  const latest = data?.points.at(-1);
  const unit = periods.find((item) => item.value === period)?.unit ?? '';
  const filledCount = predictions.filter(
    (row) => getPredictionInputValue(row, inputMaWindow).trim() !== '',
  ).length;
  const updateButtonText =
    updateState.status === 'checking'
      ? '检查中'
      : updateState.status === 'available'
        ? `下载更新 ${updateState.latestVersion}`
        : '检查更新';
  const predictionTableStyle = {
    gridTemplateColumns: `132px 112px 104px 86px 62px repeat(${visibleMaWindows.length}, 72px)`,
    minWidth: `${526 + visibleMaWindows.length * 80}px`,
  };
  const detailRow = useMemo(
    () => projection.rows.find((row) => row.targetDate === detailTargetDate) ?? null,
    [detailTargetDate, projection.rows],
  );
  const replayDetailRow = useMemo(
    () => filteredReplayRows.find((row) => row.id === replayDetailId) ?? null,
    [filteredReplayRows, replayDetailId],
  );
  useEffect(() => {
    if (replayDetailId && !filteredReplayRows.some((row) => row.id === replayDetailId)) {
      setReplayDetailId(null);
    }
  }, [filteredReplayRows, replayDetailId]);
  const lineSeries = useMemo<ChartLineSeries[]>(
    () => [
      ...(showActualMaLines
        ? visibleMaWindows.map((windowSize) => ({
            label: `真实MA${windowSize}`,
            color: lineColors[windowSize],
            rows: projection.actualLines[windowSize],
            lineWidth: windowSize === 40 ? 2.4 : 1.7,
            lineType: 'solid' as const,
            symbol: 'none',
            symbolSize: 0,
            symbolOffset: [0, 0] as [number, number],
            opacity: windowSize === 40 ? 0.72 : 0.52,
            showSymbol: false,
            z: 3 + windowSize,
          }))
        : []),
      ...visibleMaWindows.map((windowSize) => ({
          label: `预测MA${windowSize}`,
          color: lineColors[windowSize],
          rows: projection.predictedLines[windowSize],
          lineWidth: windowSize === 40 ? 3.2 : 2.5,
          lineType: 'solid' as const,
          symbol: 'circle',
          symbolSize: windowSize === 40 ? 7 : 5,
          symbolOffset: [0, 0] as [number, number],
          opacity: 0.96,
          showSymbol: windowSize === 40,
          z: 10 + windowSize,
        })),
    ],
    [projection.actualLines, projection.predictedLines, showActualMaLines, visibleMaWindows],
  );
  const pointSeries = useMemo<ChartPointSeries[]>(
    () => [
      {
        label: '预测收盘价',
        color: '#ffe600',
        borderColor: '#20251f',
        rows: projection.rows.map((row) => ({
          targetDate: row.targetDate,
          value: row.derivedClose,
        })),
        symbol: 'diamond',
        symbolSize: 13,
        z: 120,
      },
    ],
    [projection.rows],
  );

  function updateActivePlan(updater: (plan: PredictionPlan) => PredictionPlan) {
    if (
      backupRestoreInProgressRef.current ||
      requestedWorkspaceKeyRef.current !== requestedWorkspaceKey ||
      !loadedWorkspaceReady ||
      !activePlanId
    ) {
      return;
    }
    setPlans((current) =>
      current.map((plan) =>
        plan.id === activePlanId
          ? {
              ...updater(plan),
              updatedAt: new Date().toISOString(),
            }
          : plan,
      ),
    );
  }

  function updatePrediction(targetDate: string, value: string) {
    const normalizedValue = normalizeDecimalInput(value);
    updateActivePlan((plan) => ({
      ...plan,
      predictions: plan.predictions.map((row) =>
        row.targetDate === targetDate
          ? setPredictionInputValue(row, plan.inputMaWindow, normalizedValue)
          : row,
      ),
    }));
  }

  function updateInputMaWindow(windowSize: MaWindow) {
    updateActivePlan((plan) => ({
      ...plan,
      inputMaWindow: windowSize,
    }));
  }

  function createPlan() {
    if (
      backupRestoreInProgressRef.current ||
      requestedWorkspaceKeyRef.current !== requestedWorkspaceKey ||
      !loadedWorkspaceReady
    ) {
      return;
    }
    if (!hasPredictionPlanCapacity(plans)) {
      showToast(planLimitWarning, 'warning');
      return;
    }
    if (!data || !baseDate) return;
    const rows = generatePredictionRows(data.points, period, baseDate, forecastRowCount);
    const nextPlan = createEmptyPlan(data.code, period, rows, plans);
    runWorkspaceTransition(hasUnsavedChanges, flushCurrentWorkspace, () => {
      setPlans((current) => [...current, nextPlan]);
      setActivePlanId(nextPlan.id);
    });
    showToast(`已新建方案：${nextPlan.name}`, 'success');
  }

  function duplicatePlan() {
    if (
      backupRestoreInProgressRef.current ||
      requestedWorkspaceKeyRef.current !== requestedWorkspaceKey ||
      !loadedWorkspaceReady
    ) {
      return;
    }
    if (!hasPredictionPlanCapacity(plans)) {
      showToast(planLimitWarning, 'warning');
      return;
    }
    if (!activePlan) return;
    const nextPlan = copyPredictionPlan(activePlan, plans);
    runWorkspaceTransition(hasUnsavedChanges, flushCurrentWorkspace, () => {
      setPlans((current) => [...current, nextPlan]);
      setActivePlanId(nextPlan.id);
    });
    showToast(`已复制方案：${nextPlan.name}`, 'success');
  }

  function renameActivePlan() {
    if (backupRestoreInProgressRef.current || !loadedWorkspaceReady || !activePlan) return;
    const name = window.prompt('请输入方案名称', activePlan.name);
    if (name === null) return;

    const renamed = renamePredictionPlan(activePlan, name, plans);
    setPlans((current) => current.map((plan) => (plan.id === activePlan.id ? renamed : plan)));
    showToast(`方案已重命名：${renamed.name}`, 'success');
  }

  function deleteActivePlan() {
    if (backupRestoreInProgressRef.current || !loadedWorkspaceReady) return;
    if (!activePlan || plans.length <= 1) {
      showToast('至少需要保留一个方案', 'warning');
      return;
    }

    const confirmed = window.confirm(`确定删除方案“${activePlan.name}”吗？`);
    if (!confirmed) return;

    const remainingPlans = plans.filter((plan) => plan.id !== activePlan.id);
    const nextActivePlanId = resolveActivePlanId(remainingPlans, null);
    runWorkspaceTransition(hasUnsavedChanges, flushCurrentWorkspace, () => {
      setPlans(remainingPlans);
      setActivePlanId(nextActivePlanId);
    });
    showToast('方案已删除', 'success');
  }

  function selectActivePlan(planId: string) {
    if (
      backupRestoreInProgressRef.current ||
      requestedWorkspaceKeyRef.current !== requestedWorkspaceKey ||
      !loadedWorkspaceReady
    ) {
      return;
    }
    if (!plans.some((plan) => plan.id === planId) || planId === activePlanId) return;

    runWorkspaceTransition(hasUnsavedChanges, flushCurrentWorkspace, () => {
      setActivePlanId(planId);
      if (data && dataWorkspaceKey === requestedWorkspaceKey) {
        void saveActivePlanId(data.code, period, planId).catch(() => {
          showToast(electronPersistenceWarning, 'warning');
        });
      }
    });
  }

  function formatPredictionInput(targetDate: string) {
    const row = predictions.find((item) => item.targetDate === targetDate);
    const currentValue = row ? getPredictionInputValue(row, inputMaWindow) : '';
    const formatted = formatDecimalInput(currentValue);
    if (formatted !== currentValue) {
      updatePrediction(targetDate, formatted);
    }
  }

  function toggleMaWindow(windowSize: MaWindow) {
    setVisibleMaWindows((current) => {
      if (current.includes(windowSize)) {
        return current.length === 1 ? current : current.filter((item) => item !== windowSize);
      }

      return MA_WINDOWS.filter((item) => current.includes(item) || item === windowSize);
    });
  }

  function showToast(message: string, type: 'info' | 'success' | 'warning' = 'info') {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }

    setToast({ message, type });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 10000);
  }

  function closeToast() {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }

    setToast(null);
  }

  async function checkAppUpdate({ silent = false }: { silent?: boolean } = {}) {
    const currentVersion = await getCurrentAppVersion();
    setUpdateState((current) => ({
      ...current,
      status: 'checking',
      currentVersion,
    }));

    try {
      const response = await fetch(`${updateManifestUrl}?_=${Date.now()}`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`Update check failed: ${response.status}`);
      }

      const manifest = normalizeUpdateManifest(await response.json());
      if (!manifest) {
        throw new Error('Update manifest is invalid');
      }

      const hasNewVersion = compareVersions(manifest.version, currentVersion) > 0;
      if (hasNewVersion) {
        setUpdateState({
          status: 'available',
          currentVersion,
          latestVersion: manifest.version,
          downloadUrl: manifest.url,
          notes: manifest.notes,
        });
        showToast(`发现新版本 ${manifest.version}，点击“下载更新”获取新版 exe`, 'success');
        return;
      }

      setUpdateState({
        status: 'current',
        currentVersion,
        latestVersion: manifest.version,
        downloadUrl: manifest.url,
        notes: manifest.notes,
      });
      if (!silent) {
        showToast(`当前已是最新版本：${currentVersion}`, 'success');
      }
    } catch (err) {
      setUpdateState({
        status: 'error',
        currentVersion,
      });
      if (!silent) {
        showToast(err instanceof Error ? err.message : '检查更新失败', 'warning');
      }
    }
  }

  function openUpdateDownload() {
    if (!updateState.downloadUrl) {
      checkAppUpdate();
      return;
    }

    if (window.appUpdateApi?.openExternal) {
      window.appUpdateApi.openExternal(updateState.downloadUrl).catch(() => {
        window.open(updateState.downloadUrl, '_blank', 'noopener,noreferrer');
      });
      return;
    }

    window.open(updateState.downloadUrl, '_blank', 'noopener,noreferrer');
  }

  function refreshHistoricalData() {
    if (backupRestoreInProgressRef.current) return;
    const requestedStockCode = normalizeStockCode(stockCode);
    const requestedPeriod = period;
    const fetchWorkspaceKey = getStockPeriodWorkspaceKey(requestedStockCode, requestedPeriod);

    runWorkspaceTransition(hasUnsavedChanges, flushCurrentWorkspace, () => {
      if (fetchWorkspaceKey !== requestedWorkspaceKey) {
        invalidateLoadedWorkspace(fetchWorkspaceKey);
        setQueryCode(requestedStockCode);
      }
      void fetchHistoricalData(requestedStockCode, requestedPeriod, fetchWorkspaceKey);
    });
  }

  async function fetchHistoricalData(
    requestedStockCode: string,
    requestedPeriod: PeriodType,
    fetchWorkspaceKey: string,
  ) {
    setIsLoading(true);
    setError('');
    showToast('正在联网更新历史收盘价...', 'info');

    try {
      const result = await fetchKLines(requestedStockCode, requestedPeriod);
      if (
        backupRestoreInProgressRef.current ||
        requestedWorkspaceKeyRef.current !== fetchWorkspaceKey
      ) {
        return;
      }

      const completed = filterCompletedKLineData(markAsOnlineResult(result), requestedPeriod);
      const loadedDataKey = getStockPeriodWorkspaceKey(completed.data.code, requestedPeriod);
      if (loadedDataKey !== fetchWorkspaceKey) {
        throw new Error('联网数据与请求的股票周期不匹配');
      }

      saveKLineCache(completed.data, requestedPeriod);
      void queueElectronStorageSync().catch(() => {
        showToast(electronPersistenceWarning, 'warning');
      });
      setPlans([]);
      setPlansWorkspaceKey(null);
      setActivePlanId(null);
      setReplaySnapshots([]);
      setData(completed.data);
      setDataWorkspaceKey(loadedDataKey);
      setBaseDate(completed.lastCompletedDate ?? todayDate);
      setStockCode(completed.data.code);
      setQueryCode(completed.data.code);
      showToast(`已联网更新：${completed.data.points.length}条，${new Date().toLocaleString()}`, 'success');
      if (completed.data.points.length < minHistoryCount) {
        setError(`联网数据不足${minHistoryCount}条，MA60计算可能不完整`);
      }
    } catch (err) {
      if (
        backupRestoreInProgressRef.current ||
        requestedWorkspaceKeyRef.current !== fetchWorkspaceKey
      ) {
        return;
      }

      const message = err instanceof Error ? err.message : '联网更新失败';
      const cached = loadKLineCache(requestedStockCode, requestedPeriod);
      if (cached) {
        const completed = filterCompletedKLineData(markAsLocalCache(cached.data), requestedPeriod);
        const loadedDataKey = getStockPeriodWorkspaceKey(completed.data.code, requestedPeriod);
        if (loadedDataKey === fetchWorkspaceKey) {
          setPlans([]);
          setPlansWorkspaceKey(null);
          setActivePlanId(null);
          setReplaySnapshots([]);
          setData(completed.data);
          setDataWorkspaceKey(loadedDataKey);
          setBaseDate(completed.lastCompletedDate ?? todayDate);
          showToast(
            `${formatHistoryStatus(cached.updatedAt, completed.data.points.length, completed.removedPoints.length)}；联网失败，继续使用本地缓存`,
            'warning',
          );
        }
      }
      setError(`联网更新失败：${message}`);
    } finally {
      if (requestedWorkspaceKeyRef.current === fetchWorkspaceKey) {
        setIsLoading(false);
      }
    }
  }

  function updateNote(value: string) {
    updateActivePlan((plan) => ({
      ...plan,
      note: value,
    }));
  }

  function resetRows() {
    if (
      backupRestoreInProgressRef.current ||
      !loadedWorkspaceReady ||
      !data ||
      !baseDate ||
      !activePlan
    ) {
      return;
    }
    const rows = generatePredictionRows(data.points, period, baseDate, forecastRowCount);
    updateActivePlan((plan) => ({
      ...plan,
      predictions: rows,
    }));
    showToast('已重置当前预测表', 'success');
  }

  function exportPredictions() {
    if (!data || !baseDate || !activePlan) {
      showToast('暂无可导出的预测数据', 'warning');
      return;
    }

    const fileData = createPredictionPlanExport(
      activePlan,
      data.name,
      baseDate,
      packageJson.version,
    );
    const blob = new Blob([JSON.stringify(fileData, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${data.code}-${period}-${activePlan.name}-forecast-plan.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast('当前方案已导出', 'success');
  }

  function exportAllData() {
    if (data && baseDate && plans.length && activePlanId) {
      void Promise.all([
        savePredictionPlans(data.code, period, plans),
        saveActivePlanId(data.code, period, activePlanId),
      ]).catch(() => showToast(electronPersistenceWarning, 'warning'));
      saveWorkspaceCache({
        stockCode: data.code,
        period,
        baseDate,
        updatedAt: new Date().toISOString(),
      });
    }

    const storage = collectAppStorage(localStorage);
    if (!Object.keys(storage).length) {
      showToast('暂无可导出的本地数据', 'warning');
      return;
    }

    const fileData: FullBackupFileV1 = {
      schema: 'gupiao-ma40-full-backup/v1',
      exportedAt: new Date().toISOString(),
      appVersion: packageJson.version,
      storage,
    };
    const blob = new Blob([JSON.stringify(fileData, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `gupiao-full-backup-${formatDate(new Date())}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast(`已导出全部本地数据：${Object.keys(storage).length}项`, 'success');
  }

  async function importPredictions(file: File | undefined) {
    if (!file) return;

    try {
      const text = await file.text();
      const rawFile = JSON.parse(text);
      const backup = normalizeFullBackupFile(rawFile);
      if (backup) {
        const normalizedStorage = normalizeAppStorageSnapshot(backup.storage);
        if (!Object.keys(normalizedStorage).length) {
          throw new EmptyAppStorageSnapshotError();
        }

        backupRestoreInProgressRef.current = true;
        let restoreSucceeded = false;
        try {
          await restoreAppStorageTransaction(localStorage, normalizedStorage);
          restoreSucceeded = true;
        } finally {
          if (!restoreSucceeded) {
            backupRestoreInProgressRef.current = false;
          }
        }

        showToast(`已导入全部本地数据：${Object.keys(normalizedStorage).length}项，正在刷新`, 'success');
        window.location.reload();
        return;
      }

      const parsed = normalizePredictionFile(rawFile);
      if (!parsed) {
        throw new Error('文件格式不是本系统导出的预测方案文件');
      }

      if (
        loadedWorkspaceReady &&
        data &&
        dataWorkspaceKey === requestedWorkspaceKey &&
        baseDate &&
        normalizeStockCode(parsed.stockCode) === normalizeStockCode(data.code) &&
        parsed.period === period
      ) {
        if (!hasPredictionPlanCapacity(plans)) {
          showToast(planLimitWarning, 'warning');
          return;
        }
        runWorkspaceTransition(hasUnsavedChanges, flushCurrentWorkspace, () => {
          const rows = generatePredictionRows(data.points, period, baseDate, forecastRowCount);
          const imported = importPredictionPlan(parsed.plan, data.code, period, rows, plans);
          const nextPlans = [...plans, imported];
          void Promise.all([
            savePredictionPlans(data.code, period, nextPlans),
            saveActivePlanId(data.code, period, imported.id),
          ]).catch(() => showToast(electronPersistenceWarning, 'warning'));
          setPlans(nextPlans);
          setActivePlanId(imported.id);
          lastSavedSignatureRef.current = createWorkspaceSignature(
            data.code,
            period,
            baseDate,
            nextPlans,
            imported.id,
          );
          setHasUnsavedChanges(false);
          showToast(`已导入方案：${imported.name}`, 'success');
        });
        return;
      }

      runWorkspaceTransition(hasUnsavedChanges, flushCurrentWorkspace, () => {
        const importedWorkspaceKey = getStockPeriodWorkspaceKey(parsed.stockCode, parsed.period);
        invalidateLoadedWorkspace(importedWorkspaceKey);
        importedPlanRef.current = parsed;
        setStockCode(parsed.stockCode);
        setQueryCode(parsed.stockCode);
        setPeriod(parsed.period);
        saveWorkspaceCache({
          stockCode: parsed.stockCode,
          period: parsed.period,
          baseDate,
          updatedAt: new Date().toISOString(),
        });
        void queueElectronStorageSync().catch(() => {
          showToast(electronPersistenceWarning, 'warning');
        });
      });
      showToast(`已选择文件：${file.name}`, 'success');
    } catch (err) {
      if (err instanceof EmptyAppStorageSnapshotError) {
        showToast(emptyBackupWarning, 'warning');
      } else if (err instanceof AppStorageRestoreError) {
        showToast(backupRestoreFailureWarning, 'warning');
      } else {
        showToast(err instanceof Error ? err.message : '导入失败', 'warning');
      }
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function renderPredictionTable(expanded = false) {
    return (
      <div className={`prediction-table ma40-table ${expanded ? 'expanded-table' : ''}`}>
        <div className="prediction-row table-head" style={predictionTableStyle}>
          <span>目标周期</span>
          <span>预测MA{inputMaWindow}</span>
          <span>反推收盘</span>
          <span>真实收盘</span>
          <span>明细</span>
          {visibleMaWindows.map((windowSize) => (
            <span key={windowSize}>MA{windowSize}</span>
          ))}
        </div>
        {projection.rows.map((row) => (
          <div className="prediction-row" key={row.targetDate} style={predictionTableStyle}>
            <span className="date-cell">{row.targetDate}</span>
            <input
              className="prediction-input forecast-ma40-input"
              aria-label={`${row.targetDate} 预测MA${inputMaWindow}`}
              type="text"
              inputMode="decimal"
              value={getPredictionInputValue(row, inputMaWindow)}
              onChange={(event) => updatePrediction(row.targetDate, event.target.value)}
              onBlur={() => formatPredictionInput(row.targetDate)}
              placeholder="0.0000"
            />
            <span className="derived-close-cell">{formatNumber(row.derivedClose)}</span>
            <span>{formatNumber(row.actualClose)}</span>
            <button
              type="button"
              className="detail-button"
              onClick={() => setDetailTargetDate(row.targetDate)}
            >
              明细
            </button>
            {visibleMaWindows.map((windowSize) => (
              <span key={windowSize}>{formatNumber(row.maValues[windowSize])}</span>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <main className="app-shell">
      {toast ? (
        <div className={`top-toast ${toast.type}`} role="status">
          <span>{toast.message}</span>
          <button type="button" onClick={closeToast} aria-label="关闭提示">
            关闭
          </button>
        </div>
      ) : null}

      <section className="topbar">
        <div>
          <p className="eyebrow">MA{inputMaWindow} Forecast Console</p>
          <h1>人工预测 MA{inputMaWindow} 走势</h1>
        </div>
        <form
          className="stock-search"
          onSubmit={(event) => {
            event.preventDefault();
            loadStockCode();
          }}
        >
          <label htmlFor="stockCode">股票代码</label>
          <input
            id="stockCode"
            value={stockCode}
            inputMode="numeric"
            maxLength={6}
            onChange={(event) => setStockCode(event.target.value)}
          />
          <button type="submit">读取缓存</button>
          <button type="button" onClick={refreshHistoricalData} disabled={isLoading}>
            {isLoading ? '更新中' : '联网更新'}
          </button>
          <button
            type="button"
            onClick={updateState.status === 'available' ? openUpdateDownload : () => checkAppUpdate()}
            disabled={updateState.status === 'checking'}
          >
            {updateButtonText}
          </button>
        </form>
      </section>

      <section className="control-band">
        <div className="segmented">
          {periods.map((item) => (
            <button
              key={item.value}
              type="button"
              className={period === item.value ? 'active' : ''}
              onClick={() => changePeriod(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="horizon-display ma-display" aria-label="均线显示选择">
          {MA_WINDOWS.map((windowSize) => {
            const selected = visibleMaWindows.includes(windowSize);

            return (
              <button
                key={windowSize}
                type="button"
                className={`horizon-${windowSize} ${selected ? 'selected' : 'muted'}`}
                onClick={() => toggleMaWindow(windowSize)}
                style={{ '--horizon-color': lineColors[windowSize] } as CSSProperties}
              >
                <b>MA{windowSize}</b>
                <small>{selected ? '显示' : '隐藏'}</small>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className={`actual-line-toggle ${showActualMaLines ? 'active' : ''}`}
          onClick={() => setShowActualMaLines((current) => !current)}
        >
          {showActualMaLines ? '显示真实均线' : '只看预测线'}
        </button>

        <button
          type="button"
          className="replay-open-button"
          onClick={() => setIsReplayModalOpen(true)}
        >
          预测复盘 {replaySummary.ready}/{replaySummary.total}
        </button>

      </section>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="market-strip">
        <Metric label="股票" value={data ? `${data.name} ${data.code}` : '申万宏源 000166'} />
        <Metric label="数据源" value={data?.sourceName ?? '--'} />
        <Metric label="最新周期" value={latest?.date ?? '--'} />
        <Metric label="历史数量" value={data ? `${data.points.length}` : '--'} />
        <Metric label="预测窗口" value={`${inputMaWindow}${unit}`} />
        <Metric label="已填写" value={`${filledCount}/${predictions.length || forecastRowCount}`} />
        <Metric label="可对比" value={`${summary.compared}`} />
        <Metric label="MAE" value={summary.mae === null ? '--' : summary.mae.toFixed(2)} />
        <Metric label="MAPE" value={summary.mape === null ? '--' : `${summary.mape.toFixed(2)}%`} />
      </section>

      <section className="workspace">
        <div className="chart-panel">
          {isLoading ? (
            <div className="loading">正在加载K线数据...</div>
          ) : data ? (
            <KLineChart
              points={data.points}
              lineSeries={lineSeries}
              pointSeries={pointSeries}
              baseDate={baseDate}
              period={period}
              showActualKLine={showActualMaLines}
              showCloseLine={false}
              showVolume={showActualMaLines}
            />
          ) : (
            <div className="loading">暂无K线数据</div>
          )}
        </div>

        <aside className="input-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Manual MA Input</p>
              <h2>预测MA{inputMaWindow}</h2>
            </div>
            <div className="panel-actions">
              <button type="button" className="ghost" onClick={exportAllData}>
                导出全部数据
              </button>
              <button
                type="button"
                className="ghost primary-save"
                onClick={() => saveCurrentWorkspace({ force: true, notice: 'manual' })}
              >
                保存
              </button>
              <button type="button" className="ghost" onClick={() => fileInputRef.current?.click()}>
                导入
              </button>
              <button type="button" className="ghost" onClick={resetRows}>
                重置
              </button>
              <button type="button" className="ghost" onClick={() => setIsTableExpanded(true)}>
                放大
              </button>
              <input
                ref={fileInputRef}
                className="hidden-file"
                type="file"
                accept="application/json,.json"
                onChange={(event) => importPredictions(event.target.files?.[0])}
              />
            </div>
          </div>

          <div className="plan-manager">
            <label className="plan-select-field">
              <span>当前方案</span>
              <select
                value={activePlanId ?? ''}
                onChange={(event) => selectActivePlan(event.target.value)}
                disabled={!plans.length}
              >
                {plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="plan-actions">
              <button type="button" className="ghost" onClick={createPlan} disabled={!data}>
                新建
              </button>
              <button type="button" className="ghost" onClick={duplicatePlan} disabled={!activePlan}>
                复制
              </button>
              <button type="button" className="ghost" onClick={renameActivePlan} disabled={!activePlan}>
                重命名
              </button>
              <button
                type="button"
                className="ghost compact"
                onClick={exportPredictions}
                disabled={!activePlan}
              >
                导出当前方案
              </button>
              <button
                type="button"
                className="ghost danger"
                onClick={deleteActivePlan}
                disabled={!activePlan || plans.length <= 1}
              >
                删除
              </button>
            </div>
          </div>

          <div className="input-mode-strip" aria-label="预测输入均线选择">
            <span>预测输入</span>
            {MA_WINDOWS.map((windowSize) => (
              <button
                key={windowSize}
                type="button"
                className={inputMaWindow === windowSize ? 'active' : ''}
                onClick={() => updateInputMaWindow(windowSize)}
              >
                MA{windowSize}
              </button>
            ))}
          </div>

          {renderPredictionTable()}

          <label className="note-field">
            <span>备注</span>
            <textarea
              value={activePlan?.note ?? ''}
              onChange={(event) => updateNote(event.target.value)}
              placeholder={`例如：MA${inputMaWindow}目标、趋势判断、压力位...`}
            />
          </label>
        </aside>
      </section>

      {isTableExpanded ? (
        <div className="table-modal-backdrop" role="presentation">
          <section className="table-modal" role="dialog" aria-modal="true" aria-label="完整预测表">
            <div className="table-modal-head">
              <div>
                <p className="eyebrow">Full Table</p>
                <h2>完整预测表</h2>
              </div>
              <button type="button" className="ghost" onClick={() => setIsTableExpanded(false)}>
                关闭
              </button>
            </div>
            {renderPredictionTable(true)}
          </section>
        </div>
      ) : null}

      {isReplayModalOpen ? (
        <ReplayReviewModal
          rows={filteredReplayRows}
          summary={replaySummary}
          totalSummary={replayTotalSummary}
          planFilter={resolvedReplayPlanFilter}
          planOptions={replayPlanOptions}
          activePlanId={replayActivePlanId}
          hasLegacyRows={hasLegacyReplayRows}
          onPlanFilterChange={setReplayPlanFilter}
          selectedRow={replayDetailRow}
          onSelectRow={setReplayDetailId}
          onClose={() => {
            setIsReplayModalOpen(false);
            setReplayDetailId(null);
          }}
        />
      ) : null}

      {detailRow ? (
        <CalculationDetailModal
          row={detailRow}
          inputMaWindow={inputMaWindow}
          onClose={() => setDetailTargetDate(null)}
        />
      ) : null}
    </main>
  );
}

function CalculationDetailModal({
  row,
  inputMaWindow,
  onClose,
}: {
  row: Ma40ProjectionRow;
  inputMaWindow: MaWindow;
  onClose: () => void;
}) {
  const reverse = row.calculation.reverse;
  const reverseFormula =
    reverse.predictedMa !== null &&
    reverse.previousSum !== null &&
    reverse.derivedClose !== null
      ? `${formatNumber(reverse.predictedMa, 4)} × ${inputMaWindow} - ${formatNumber(reverse.previousSum)} = ${formatNumber(reverse.derivedClose)}`
      : reverse.reason ?? '暂无可计算的明细';

  return (
    <div className="detail-modal-backdrop" role="presentation">
      <section className="detail-modal" role="dialog" aria-modal="true" aria-label="计算明细">
        <div className="detail-modal-head">
          <div>
            <p className="eyebrow">Calculation Detail</p>
            <h2>{row.targetDate} 计算明细</h2>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="detail-modal-body">
          <section className="formula-card main-formula">
            <div className="formula-card-head">
              <span>反推收盘价</span>
              <strong>预测MA{inputMaWindow}</strong>
            </div>
            <div className="formula-line">{reverseFormula}</div>
            <div className="formula-meta">
              <span>预测MA：{formatNumber(reverse.predictedMa, 4)}</span>
              <span>前{inputMaWindow - 1}期合计：{formatNumber(reverse.previousSum)}</span>
              <span>反推收盘：{formatNumber(reverse.derivedClose)}</span>
            </div>
          </section>

          <section className="detail-section">
            <div className="detail-section-head">
              <h3>前{inputMaWindow - 1}期参与反推的收盘价</h3>
              <span>{reverse.previousValues.length}条</span>
            </div>
            <ValueList values={reverse.previousValues} emptyText={reverse.reason ?? '暂无参与数据'} />
          </section>

          <section className="detail-section">
            <div className="detail-section-head">
              <h3>MA5 / MA10 / MA20 / MA40 / MA60 计算</h3>
              <span>先求和，再除以周期数</span>
            </div>
            <div className="ma-detail-grid">
              {MA_WINDOWS.map((windowSize) => {
                const detail = row.calculation.movingAverages[windowSize];
                const currentValue = detail.values.at(-1);
                const previousValues = detail.values.slice(0, -1);
                const previousSum = sumCalculationValues(previousValues);
                const formula =
                  detail.average !== null && currentValue
                    ? `(${formatNumber(currentValue.value)} + ${formatNumber(previousSum)}) / ${windowSize} = ${formatNumber(detail.average)}`
                    : detail.reason ?? '暂无可计算的明细';

                return (
                  <article className="ma-detail-card" key={windowSize}>
                    <div className="ma-detail-title">MA{windowSize}</div>
                    <div className="ma-detail-formula">{formula}</div>
                    <div className="ma-detail-meta">
                      <span>当前反推收盘：{formatNumber(currentValue?.value ?? null)}</span>
                      <span>前{Math.max(windowSize - 1, 0)}期合计：{formatNumber(previousSum)}</span>
                      <span>总和：{formatNumber(detail.sum)}</span>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

function ReplayReviewModal({
  rows,
  summary,
  totalSummary,
  planFilter,
  planOptions,
  activePlanId,
  hasLegacyRows,
  onPlanFilterChange,
  selectedRow,
  onSelectRow,
  onClose,
}: {
  rows: ReplayReviewRow[];
  summary: ReplaySummary;
  totalSummary: ReplaySummary;
  planFilter: ReplayPlanFilter;
  planOptions: Array<{ id: string; name: string }>;
  activePlanId: string | null;
  hasLegacyRows: boolean;
  onPlanFilterChange: (filter: ReplayPlanFilter) => void;
  selectedRow: ReplayReviewRow | null;
  onSelectRow: (id: string | null) => void;
  onClose: () => void;
}) {
  const activePlanName = planOptions.find((plan) => plan.id === activePlanId)?.name ?? '当前方案';

  return (
    <div className="detail-modal-backdrop" role="presentation">
      <section className="replay-modal" role="dialog" aria-modal="true" aria-label="预测复盘">
        <div className="detail-modal-head">
          <div>
            <p className="eyebrow">Replay Review</p>
            <h2>预测复盘</h2>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="replay-modal-body">
          <div className="replay-filter-bar">
            <label className="replay-filter-field">
              <span>复盘范围</span>
              <select
                value={planFilter}
                onChange={(event) => onPlanFilterChange(event.target.value as ReplayPlanFilter)}
              >
                <option value="active">当前方案：{activePlanName}</option>
                <option value="all">全部方案</option>
                {planOptions.map((plan) => (
                  <option key={plan.id} value={`plan:${plan.id}`}>
                    {plan.name}
                  </option>
                ))}
                {hasLegacyRows ? <option value="legacy">未归属历史</option> : null}
              </select>
            </label>
            <div className="replay-filter-note">
              当前显示 {summary.total} 条 / 全部 {totalSummary.total} 条
            </div>
          </div>

          <div className="replay-summary-grid">
            <Metric label="快照" value={`${summary.total}`} />
            <Metric label="已复盘" value={`${summary.ready}`} />
            <Metric label="待复盘" value={`${summary.pending}`} />
            <Metric
              label="收盘MAE"
              value={summary.closeMae === null ? '--' : summary.closeMae.toFixed(2)}
            />
            <Metric
              label="收盘MAPE"
              value={summary.closeMape === null ? '--' : `${summary.closeMape.toFixed(2)}%`}
            />
            <Metric
              label="方向命中"
              value={
                summary.closeDirectionHitRate === null
                  ? '--'
                  : `${summary.closeDirectionHitRate.toFixed(0)}%`
              }
            />
            <Metric
              label="MA40误差"
              value={summary.ma40Mae === null ? '--' : summary.ma40Mae.toFixed(2)}
            />
          </div>

          <div className="replay-table">
            <div className="replay-row replay-head">
              <span>目标周期</span>
              <span>预测来源</span>
              <span>状态</span>
              <span>预测收盘</span>
              <span>真实收盘</span>
              <span>误差</span>
              <span>误差%</span>
              <span>方向</span>
              <span>明细</span>
            </div>

            {rows.length ? (
              rows.map((row) => (
                <div className="replay-row" key={row.id}>
                  <span className="date-cell">{row.targetDate}</span>
                  <span>{formatReplaySource(row)}</span>
                  <span className={`replay-status ${row.status}`}>
                    {row.status === 'ready' ? '已复盘' : '待真实K线'}
                  </span>
                  <strong>{formatNumber(row.predictedClose)}</strong>
                  <span>{formatNumber(row.actualClose)}</span>
                  <span className={getDiffClass(row.closeDiff)}>{formatSignedNumber(row.closeDiff)}</span>
                  <span>{formatPercent(row.closeDiffPct)}</span>
                  <span className={getDirectionHitClass(row.closeDirectionHit)}>
                    {formatDirectionHit(row.closeDirectionHit)}
                  </span>
                  <button type="button" className="detail-button" onClick={() => onSelectRow(row.id)}>
                    明细
                  </button>
                </div>
              ))
            ) : (
              <div className="replay-empty">
                还没有复盘快照。填写预测后点击“保存”，系统会把当时的预测结果单独记录下来。
              </div>
            )}
          </div>

          {selectedRow ? (
            <section className="replay-detail-panel">
              <div className="detail-section-head">
                <h3>{selectedRow.targetDate} 复盘明细</h3>
                <button type="button" className="ghost" onClick={() => onSelectRow(null)}>
                  收起
                </button>
              </div>

              <div className="replay-close-card">
                <div>
                  <span>预测收盘</span>
                  <strong>{formatNumber(selectedRow.predictedClose)}</strong>
                </div>
                <div>
                  <span>真实收盘</span>
                  <strong>{formatNumber(selectedRow.actualClose)}</strong>
                </div>
                <div>
                  <span>误差</span>
                  <strong className={getDiffClass(selectedRow.closeDiff)}>
                    {formatSignedNumber(selectedRow.closeDiff)}
                  </strong>
                </div>
                <div>
                  <span>方向</span>
                  <strong>{formatDirection(selectedRow.predictedCloseDirection)} / {formatDirection(selectedRow.actualCloseDirection)}</strong>
                </div>
              </div>

              <div className="replay-ma-grid">
                {MA_WINDOWS.map((windowSize) => {
                  const detail = selectedRow.maComparisons[windowSize];

                  return (
                    <article className="replay-ma-card" key={windowSize}>
                      <div className="ma-detail-title">MA{windowSize}</div>
                      <div className="replay-ma-values">
                        <span>预测：{formatNumber(detail.predicted)}</span>
                        <span>真实：{formatNumber(detail.actual)}</span>
                        <span className={getDiffClass(detail.diff)}>
                          误差：{formatSignedNumber(detail.diff)}
                        </span>
                        <span>误差%：{formatPercent(detail.diffPct)}</span>
                        <span>
                          方向：{formatDirection(detail.predictedDirection)} / {formatDirection(detail.actualDirection)}
                        </span>
                        <span className={getDirectionHitClass(detail.directionHit)}>
                          {formatDirectionHit(detail.directionHit)}
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function ValueList({
  values,
  emptyText,
}: {
  values: Ma40ProjectionRow['calculation']['reverse']['previousValues'];
  emptyText: string;
}) {
  if (!values.length) {
    return <div className="empty-detail">{emptyText}</div>;
  }

  return (
    <div className="value-list">
      <div className="value-list-head">
        <span>周期</span>
        <span>来源</span>
        <span>收盘价</span>
      </div>
      {values.map((item) => (
        <div className="value-list-row" key={item.targetDate}>
          <span>{item.targetDate}</span>
          <span className={`source-pill ${item.source}`}>
            {item.source === 'actual' ? '真实' : '预测'}
          </span>
          <strong>{formatNumber(item.value)}</strong>
        </div>
      ))}
    </div>
  );
}

function sumCalculationValues(values: Array<{ value: number }>) {
  return values.length ? values.reduce((total, item) => total + item.value, 0) : null;
}

function formatReplaySource(row: ReplayReviewRow) {
  const planName = row.planName?.trim() || (row.planId ? '历史方案' : '未归属历史');
  return `${planName} / MA${row.inputMaWindow} / ${row.baseDate}`;
}

function formatSignedNumber(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '--';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '--';
  return `${value.toFixed(2)}%`;
}

function formatDirection(value: ReplayReviewRow['predictedCloseDirection']) {
  if (value === 'up') return '上涨';
  if (value === 'down') return '下跌';
  if (value === 'flat') return '持平';
  return '--';
}

function formatDirectionHit(value: boolean | null) {
  if (value === null) return '--';
  return value ? '命中' : '未命中';
}

function getDiffClass(value: number | null) {
  if (value === null || !Number.isFinite(value) || Math.abs(value) <= 1e-9) return '';
  return value > 0 ? 'up' : 'down';
}

function getDirectionHitClass(value: boolean | null) {
  if (value === null) return '';
  return value ? 'hit' : 'miss';
}

async function getCurrentAppVersion() {
  try {
    return (await window.appUpdateApi?.getCurrentVersion?.()) ?? appVersion;
  } catch {
    return appVersion;
  }
}

function normalizeUpdateManifest(value: unknown): UpdateManifest | null {
  const candidate = value as UpdateManifest;
  if (
    candidate?.app !== 'gupiao-ma40' ||
    typeof candidate.version !== 'string' ||
    typeof candidate.url !== 'string' ||
    !/^https:\/\/(github\.com|nhtqgm\.github\.io)\//.test(candidate.url)
  ) {
    return null;
  }

  return {
    app: candidate.app,
    version: candidate.version,
    url: candidate.url,
    notes: typeof candidate.notes === 'string' ? candidate.notes : undefined,
    publishedAt: typeof candidate.publishedAt === 'string' ? candidate.publishedAt : undefined,
  };
}

function compareVersions(a: string, b: string) {
  const left = normalizeVersionParts(a);
  const right = normalizeVersionParts(b);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

function normalizeVersionParts(value: string) {
  return value
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number(part.replace(/\D.*$/, '')))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function normalizeFullBackupFile(value: unknown): FullBackupFileV1 | null {
  if (!isFullBackupFileV1(value)) return null;

  return {
    schema: value.schema,
    exportedAt: value.exportedAt,
    appVersion: value.appVersion,
    storage: normalizeAppStorageSnapshot(value.storage),
  };
}

function isFullBackupFileV1(value: unknown): value is FullBackupFileV1 {
  const candidate = value as FullBackupFileV1;
  return (
    candidate?.schema === 'gupiao-ma40-full-backup/v1' &&
    typeof candidate.exportedAt === 'string' &&
    typeof candidate.appVersion === 'string' &&
    candidate.storage !== null &&
    typeof candidate.storage === 'object' &&
    !Array.isArray(candidate.storage)
  );
}

function normalizePredictionFile(value: unknown): ImportedPredictionPlan | null {
  const planFile = normalizePredictionPlanExport(value);
  if (planFile) {
    return {
      stockCode: planFile.stockCode,
      period: planFile.period,
      plan: planFile.plan,
    };
  }

  if (!isPredictionFileV5(value)) return null;

  const now = new Date().toISOString();
  return {
    stockCode: value.stockCode,
    period: value.period,
    plan: {
      id: `import-${Date.now()}`,
      name: '旧版导入方案',
      stockCode: value.stockCode,
      period: value.period,
      inputMaWindow: MA40_WINDOW,
      predictions: value.predictions.map(normalizePredictionPoint),
      note: value.predictions.find((row) => row.note.trim())?.note ?? '',
      createdAt: now,
      updatedAt: now,
      source: 'imported',
    },
  };
}

function isPredictionFileV5(value: unknown): value is PredictionFileV5 {
  const candidate = value as PredictionFileV5;
  return (
    candidate?.schema === 'gupiao-ma40-predictions/v1' &&
    typeof candidate.stockCode === 'string' &&
    ['day', 'week', 'month'].includes(candidate.period) &&
    typeof candidate.baseDate === 'string' &&
    Array.isArray(candidate.predictions)
  );
}

function createWorkspaceSignature(
  stockCode: string,
  period: PeriodType,
  baseDate: string,
  plans: PredictionPlan[],
  activePlanId: string | null,
) {
  return JSON.stringify({
    stockCode,
    period,
    baseDate,
    activePlanId,
    plans,
  });
}

function formatDecimalInput(value: string) {
  if (value.trim() === '') return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(4) : value;
}

function normalizeDecimalInput(value: string) {
  const trimmed = value.trim();
  if (trimmed === '') return '';

  const cleaned = trimmed.replace(/[^\d.]/g, '');
  const [integerPart, ...decimalParts] = cleaned.split('.');
  if (!decimalParts.length) return integerPart;

  const decimals = decimalParts.join('').slice(0, 4);
  return `${integerPart || '0'}.${decimals}`;
}

function getPredictionInputValue(row: PredictionPoint, windowSize: MaWindow) {
  return row.predictedMaValues[String(windowSize)] ?? (windowSize === 40 ? row.predictedMa40 : '');
}

function setPredictionInputValue(
  row: PredictionPoint,
  windowSize: MaWindow,
  value: string,
): PredictionPoint {
  const predictedMaValues = {
    ...row.predictedMaValues,
    [String(windowSize)]: value,
  };

  return {
    ...row,
    predictedMa40: windowSize === 40 ? value : row.predictedMa40,
    predictedMaValues,
  };
}

function markAsLocalCache(data: StockKLineResponse): StockKLineResponse {
  return {
    ...data,
    sourceName: `${data.sourceName ?? '行情'} / 本地缓存`,
  };
}

function markAsOnlineResult(data: StockKLineResponse): StockKLineResponse {
  return {
    ...data,
    sourceName: `${data.sourceName ?? '行情'} / 刚刚联网`,
  };
}

function formatHistoryStatus(updatedAt: string, count: number, removedCount = 0) {
  const updatedDate = new Date(updatedAt);
  const updatedText = Number.isNaN(updatedDate.getTime())
    ? updatedAt
    : updatedDate.toLocaleString();
  const removedText = removedCount > 0 ? `，已过滤未完成K线${removedCount}条` : '';
  return `本地历史：${count}条，更新于 ${updatedText}${removedText}`;
}

function createEmptyLineMap(): Record<MaWindow, LineValuePoint[]> {
  return MA_WINDOWS.reduce(
    (lines, windowSize) => ({
      ...lines,
      [windowSize]: [],
    }),
    {} as Record<MaWindow, LineValuePoint[]>,
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
