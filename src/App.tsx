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
  getCloudProfile,
  getCloudUser,
  isCloudSyncConfigured,
  loadMyCloudWorkspace,
  saveMyCloudWorkspace,
  signInToCloud,
  signOutOfCloud,
} from './utils/supabase';
import type { User } from '@supabase/supabase-js';
import {
  buildForecastHistoryRows,
  createForecastHistorySnapshots,
  filterForecastHistorySnapshots,
  getPendingForecastRows,
  mergeForecastHistory,
  type ForecastHistorySnapshot,
  type ForecastHistoryRow,
} from './utils/forecastHistory';
import {
  createEmptyCloudWorkspace,
  createCloudWorkspaceFromLegacyBackup,
  createWorkspaceSaveQueue,
  getWorkspaceForecastHistory,
  getWorkspacePredictions,
  setWorkspaceForecastHistory,
  setWorkspacePredictions,
  type CloudWorkspace,
  type CloudWorkspaceSaveStatus,
} from './utils/cloudWorkspace';
import { compareProjectionRows, formatNumber, summarizeComparisons } from './utils/metrics';
import { mergeLineValuePoints, mergeLineValuePointsPreservingEarlier } from './utils/linePoints';
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
  normalizePredictionPoint,
} from './utils/predictions';
import { ALL_KLINE_PERIODS, refreshAllKLinePeriods } from './utils/periodRefresh';

const periods: Array<{ value: PeriodType; label: string; unit: string }> = [
  { value: 'day', label: '日K', unit: '日' },
  { value: 'week', label: '周K', unit: '周' },
  { value: 'month', label: '月K', unit: '月' },
];

const forecastRowCount = 40;
const minHistoryCount = 60;
const todayDate = formatDate(new Date());
const appVersion = packageJson.version;
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

type CloudSyncState = 'unconfigured' | 'signed-out' | 'ready' | 'syncing' | 'error';

export default function App() {
  const [stockCode, setStockCode] = useState('000166');
  const [queryCode, setQueryCode] = useState('000166');
  const [period, setPeriod] = useState<PeriodType>('month');
  const [data, setData] = useState<StockKLineResponse | null>(null);
  const [dataPeriod, setDataPeriod] = useState<PeriodType | null>(null);
  const [baseDate, setBaseDate] = useState(todayDate);
  const [predictions, setPredictions] = useState<PredictionPoint[]>([]);
  const [forecastHistory, setForecastHistory] = useState<ForecastHistorySnapshot[]>([]);
  const [visibleMaWindows, setVisibleMaWindows] = useState<MaWindow[]>([5, 10, 20, 40, 60]);
  const [showActualMaLines, setShowActualMaLines] = useState(false);
  const [inputMaWindow, setInputMaWindow] = useState<MaWindow>(MA40_WINDOW);
  const [isTableExpanded, setIsTableExpanded] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [detailTargetDate, setDetailTargetDate] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>({
    status: 'idle',
    currentVersion: appVersion,
  });
  const [cloudUser, setCloudUser] = useState<User | null>(null);
  const [cloudWorkspace, setCloudWorkspace] = useState<CloudWorkspace | null>(null);
  const [cloudWorkspaceRevision, setCloudWorkspaceRevision] = useState(0);
  const [cloudRole, setCloudRole] = useState<'user' | 'admin' | null>(null);
  const [cloudSaveStatus, setCloudSaveStatus] = useState<CloudWorkspaceSaveStatus>('idle');
  const [isCloudWorkspaceLoading, setIsCloudWorkspaceLoading] = useState(false);
  const [cloudStockCodes, setCloudStockCodes] = useState<string[]>([]);
  const [cloudSyncState, setCloudSyncState] = useState<CloudSyncState>(
    isCloudSyncConfigured() ? 'signed-out' : 'unconfigured',
  );
  const [cloudEmail, setCloudEmail] = useState('');
  const [cloudPassword, setCloudPassword] = useState('');
  const [isCloudAccountOpen, setIsCloudAccountOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'success' | 'warning' } | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importedPlanRef = useRef<PredictionFileV5 | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const lastSavedSignatureRef = useRef('');
  const cloudWorkspaceRef = useRef<CloudWorkspace | null>(null);
  const cloudSaveQueueRef = useRef<ReturnType<typeof createWorkspaceSaveQueue> | null>(null);
  const cloudSessionGenerationRef = useRef(0);
  const marketDataRef = useRef(new Map<string, StockKLineResponse>());

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isCloudSyncConfigured()) return;
    void getCloudUser().then((user) => {
      setCloudUser(user);
      setCloudSyncState(user ? 'ready' : 'signed-out');
      if (user) void loadCloudWorkspace(user, true);
    });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      checkAppUpdate({ silent: true });
    }, 1500);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!cloudWorkspace) return;
    const cached = marketDataRef.current.get(marketScopeKey(queryCode, period));
    setError('');

    if (!cached) {
      setData(null);
      setDataPeriod(null);
      setPredictions(getWorkspacePredictions(cloudWorkspace, { stockCode: queryCode, period }));
      setForecastHistory(getWorkspaceForecastHistory(cloudWorkspace, { stockCode: queryCode, period }));
      setBaseDate(cloudWorkspace.workspace.baseDate || todayDate);
      showToast('暂无本地历史数据，请点击“联网更新”拉取最近历史收盘价', 'warning');
      return;
    }

    const completed = filterCompletedKLineData(cached, period);
    setData(completed.data);
    setDataPeriod(period);
    setBaseDate(completed.lastCompletedDate ?? todayDate);
    showToast(
      formatHistoryStatus(new Date().toISOString(), completed.data.points.length, completed.removedPoints.length),
      'info',
    );
    if (completed.data.points.length < minHistoryCount) {
      setError(`本地历史数据不足${minHistoryCount}条，MA60计算可能不完整，请联网更新一次`);
    }
  }, [cloudWorkspace, period, queryCode]);

  useEffect(() => {
    if (!data || !baseDate || dataPeriod !== period || normalizeStockCode(data.code) !== normalizeStockCode(queryCode)) {
      return;
    }

    const importedPlan = importedPlanRef.current;
    if (
      importedPlan &&
      importedPlan.stockCode === data.code &&
      importedPlan.period === period
    ) {
      setPredictions(importedPlan.predictions);
      updateCloudWorkspace((workspace) =>
        setWorkspacePredictions(workspace, { stockCode: data.code, period }, importedPlan.predictions),
      );
      importedPlanRef.current = null;
      showToast('预测文件已加载', 'success');
      return;
    }

    const storedRows = cloudWorkspace
      ? getWorkspacePredictions(cloudWorkspace, { stockCode: data.code, period })
      : [];
    setPredictions(
      storedRows.length
        ? storedRows
        : generatePredictionRows(data.points, period, baseDate, forecastRowCount),
    );
  }, [baseDate, cloudWorkspace, data, period]);

  useEffect(() => {
    if (!data || dataPeriod !== period || !cloudWorkspace) return;
    setForecastHistory(getWorkspaceForecastHistory(cloudWorkspace, { stockCode: data.code, period }));
  }, [cloudWorkspace, data, dataPeriod, period]);

  useEffect(() => {
    if (!data || !baseDate || !predictions.length) return;

    setHasUnsavedChanges(true);
  }, [baseDate, data, period, predictions]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      saveCurrentWorkspace({ notice: 'auto' });
    }, 30000);

    return () => window.clearInterval(timer);
  }, [baseDate, data, hasUnsavedChanges, period, predictions]);

  function updateCloudWorkspace(transform: (workspace: CloudWorkspace) => CloudWorkspace) {
    const current = cloudWorkspaceRef.current;
    if (!current || !cloudUser) return;
    const next = transform(current);
    cloudWorkspaceRef.current = next;
    setCloudWorkspace(next);
    cloudSaveQueueRef.current?.schedule(next);
  }

  async function loadCloudWorkspace(user: User, quiet = false) {
    const generation = ++cloudSessionGenerationRef.current;
    cloudSaveQueueRef.current?.switchAccount('', 0);
    cloudWorkspaceRef.current = null;
    setCloudWorkspace(null);
    setCloudRole(null);
    setData(null);
    setDataPeriod(null);
    setPredictions([]);
    setForecastHistory([]);
    setIsCloudWorkspaceLoading(true);
    setCloudSyncState('syncing');

    try {
      const [profile, record] = await Promise.all([getCloudProfile(), loadMyCloudWorkspace()]);
      if (generation !== cloudSessionGenerationRef.current) return;
      if (!profile || profile.userId !== user.id) throw new Error('Cloud account profile is unavailable.');

      let workspace = record?.payload ?? createEmptyCloudWorkspace();
      let revision = record?.revision ?? 0;
      if (!record) {
        const created = await saveMyCloudWorkspace(workspace, 0);
        if (generation !== cloudSessionGenerationRef.current) return;
        workspace = created.payload;
        revision = created.revision;
      }

      cloudWorkspaceRef.current = workspace;
      setCloudWorkspace(workspace);
      setCloudWorkspaceRevision(revision);
      setCloudRole(profile.role);
      setStockCode(workspace.workspace.stockCode);
      setQueryCode(workspace.workspace.stockCode);
      setPeriod(workspace.workspace.period);
      setBaseDate(workspace.workspace.baseDate || todayDate);
      setCloudStockCodes(
        [...new Set(Object.keys(workspace.predictions).map((key) => key.split(':')[0]))].sort(),
      );
      cloudSaveQueueRef.current = createWorkspaceSaveQueue({
        accountId: user.id,
        revision,
        save: async ({ payload, expectedRevision }) => {
          const saved = await saveMyCloudWorkspace(payload, expectedRevision);
          if (generation === cloudSessionGenerationRef.current) setCloudWorkspaceRevision(saved.revision);
          return { revision: saved.revision, payload: saved.payload };
        },
        onStatusChange: setCloudSaveStatus,
      });
      setCloudSyncState('ready');
      if (!quiet) showToast('Cloud workspace loaded.', 'success');
      void refreshHistoricalData();
    } catch (err) {
      if (generation !== cloudSessionGenerationRef.current) return;
      setCloudSyncState('error');
      if (!quiet) showToast(err instanceof Error ? err.message : 'Cloud workspace load failed.', 'warning');
    } finally {
      if (generation === cloudSessionGenerationRef.current) setIsCloudWorkspaceLoading(false);
    }
  }

  function saveCurrentWorkspace({
    force = false,
    notice,
  }: {
    force?: boolean;
    notice: 'auto' | 'manual' | 'silent';
  }) {
    if (!data || !baseDate || !predictions.length || !cloudWorkspace) return;
    capturePredictionHistory(predictions, data);
    updateCloudWorkspace((workspace) => ({
      ...setWorkspacePredictions(workspace, { stockCode: data.code, period }, predictions),
      workspace: { stockCode: data.code, period, baseDate },
    }));
    setHasUnsavedChanges(false);
    if (notice === 'manual') showToast('Saved to cloud.', 'success');
    /*
    if (!data || !baseDate || !predictions.length) {
      if (notice === 'manual') {
        showToast('暂无可保存的数据', 'warning');
      }
      return;
    }

    if (!force && !hasUnsavedChanges) return;

    const signature = JSON.stringify({
      stockCode: data.code,
      period,
      baseDate,
      predictions,
    });
    if (signature === lastSavedSignatureRef.current) {
      setHasUnsavedChanges(false);
      if (notice === 'manual') {
        showToast(`已保存：${new Date().toLocaleTimeString()}`, 'success');
      }
      return;
    }

    capturePredictionHistory(predictions, data);
    savePredictions(predictionPlanKey(data.code, period, baseDate), predictions);
    saveWorkspaceCache({
      stockCode: data.code,
      period,
      baseDate,
      updatedAt: new Date().toISOString(),
    });
    lastSavedSignatureRef.current = signature;
    setHasUnsavedChanges(false);

    if (notice !== 'silent') {
      showToast(
        notice === 'auto'
          ? `已自动保存：${new Date().toLocaleTimeString()}`
          : `已保存：${new Date().toLocaleTimeString()}`,
        'success',
      );
    }
    */
  }

  const projection = useMemo(
    () =>
      data
        ? buildMa40Projection(data.points, predictions, baseDate, inputMaWindow)
        : {
            rows: [],
            actualLines: createEmptyLineMap(),
            predictedLines: createEmptyLineMap(),
            closeByDate: new Map<string, number>(),
          },
    [baseDate, data, inputMaWindow, predictions],
  );
  const forecastDates = useMemo(
    () => projection.rows.map((row) => row.targetDate),
    [projection.rows],
  );
  const historyRows = useMemo(
    () =>
      data &&
      dataPeriod === period &&
      normalizeStockCode(data.code) === normalizeStockCode(queryCode)
        ? buildForecastHistoryRows(
            filterForecastHistorySnapshots(forecastHistory, data.code, period),
            data.points,
          )
        : [],
    [data, dataPeriod, forecastHistory, period, queryCode],
  );
  const completedHistoryRows = useMemo(
    () => historyRows.filter((row) => row.actualClose !== null),
    [historyRows],
  );
  const visibleHistoryRows = useMemo(
    () => completedHistoryRows.filter((row) => row.inputMaWindow === inputMaWindow),
    [completedHistoryRows, inputMaWindow],
  );
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
          rows: mergeLineValuePointsPreservingEarlier(
            visibleHistoryRows.map((row) => ({
              targetDate: row.actualDate ?? row.targetDate,
              value: row.predictedMaValues[windowSize],
            })),
            projection.predictedLines[windowSize],
          ),
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
    [
      visibleHistoryRows,
      projection.actualLines,
      projection.predictedLines,
      showActualMaLines,
      visibleMaWindows,
    ],
  );
  const pointSeries = useMemo<ChartPointSeries[]>(
    () => [
      {
        label: '预测收盘价',
        color: '#ffe600',
        borderColor: '#20251f',
        rows: mergeLineValuePoints(
          visibleHistoryRows.map((row) => ({
            targetDate: row.actualDate ?? row.targetDate,
            value: row.predictedClose,
          })),
          projection.rows.map((row) => ({
            targetDate: row.targetDate,
            value: row.derivedClose,
          })),
        ),
        symbol: 'diamond',
        symbolSize: 13,
        z: 120,
      },
    ],
    [projection.rows, visibleHistoryRows],
  );

  function capturePredictionHistory(
    rows: PredictionPoint[],
    sourceData: StockKLineResponse | null,
    workspacePeriod = dataPeriod ?? period,
    workspaceBaseDate = baseDate,
  ) {
    if (!sourceData || !rows.length || !workspaceBaseDate) {
      return;
    }

    const existing = cloudWorkspace
      ? getWorkspaceForecastHistory(cloudWorkspace, { stockCode: sourceData.code, period: workspacePeriod })
      : [];
    const frozenIds = new Set(
      buildForecastHistoryRows(existing, sourceData.points)
        .filter((row) => row.actualClose !== null)
        .map((row) => row.id),
    );
    const pendingRows = getPendingForecastRows(rows, workspaceBaseDate);
    const incoming = MA_WINDOWS.flatMap((windowSize) =>
      createForecastHistorySnapshots(
        sourceData.code,
        workspacePeriod,
        windowSize,
        buildMa40Projection(sourceData.points, pendingRows, workspaceBaseDate, windowSize).rows,
      ),
    ).filter((snapshot) => !frozenIds.has(snapshot.id));

    if (!incoming.length) {
      if (workspacePeriod === period && normalizeStockCode(sourceData.code) === normalizeStockCode(queryCode)) {
        setForecastHistory(existing);
      }
      return;
    }

    const merged = mergeForecastHistory(existing, incoming);
    updateCloudWorkspace((workspace) =>
      setWorkspaceForecastHistory(
        workspace,
        { stockCode: sourceData.code, period: workspacePeriod },
        merged,
      ),
    );
    if (workspacePeriod === period && normalizeStockCode(sourceData.code) === normalizeStockCode(queryCode)) {
      setForecastHistory(merged);
    }
  }

  function captureCachedPredictionHistory(workspacePeriod: PeriodType) {
    const cached = marketDataRef.current.get(marketScopeKey(stockCode, workspacePeriod));
    if (!cached) return;
    const completed = filterCompletedKLineData(cached, workspacePeriod);
    const workspaceBaseDate = completed.lastCompletedDate;
    if (!workspaceBaseDate || !cloudWorkspace) return;
    const storedRows = getWorkspacePredictions(cloudWorkspace, {
      stockCode: completed.data.code,
      period: workspacePeriod,
    });
    if (storedRows.length) capturePredictionHistory(storedRows, completed.data, workspacePeriod, workspaceBaseDate);
    /*
    const cached = loadKLineCache(stockCode, workspacePeriod);
    if (!cached) return;

    const completed = filterCompletedKLineData(markAsLocalCache(cached.data), workspacePeriod);
    const workspaceBaseDate = completed.lastCompletedDate;
    if (!workspaceBaseDate) return;

    const storedRows = loadPredictions(
      predictionPlanKey(completed.data.code, workspacePeriod, workspaceBaseDate),
    );
    if (storedRows?.length) {
      capturePredictionHistory(storedRows, completed.data, workspacePeriod, workspaceBaseDate);
    }
    */
  }

  function persistPredictionDraft(rows: PredictionPoint[]) {
    if (!data || !baseDate || !rows.length) return;
    updateCloudWorkspace((workspace) => ({
      ...setWorkspacePredictions(workspace, { stockCode: data.code, period }, rows),
      workspace: { stockCode: data.code, period, baseDate },
    }));
  }

  /*
  function applyCloudEventsLocally(events: PredictionEvent[]) {
    setCloudStockCodes(listPredictionStockCodes(events));
    const folded = foldPredictionEvents(events);
    const scopes = new Map(
      events.map((event) => [`${event.stockCode}:${event.period}`, { stockCode: event.stockCode, period: event.period }]),
    );

    scopes.forEach((scope) => {
      const isCurrentScope =
        data &&
        normalizeStockCode(data.code) === scope.stockCode &&
        period === scope.period;
      const localRows = isCurrentScope ? predictions : loadPredictions(predictionPlanKey(scope.stockCode, scope.period)) ?? [];
      const mergedRows = applyPredictionEventsToRows(localRows, scope, folded);
      savePredictions(predictionPlanKey(scope.stockCode, scope.period), mergedRows);
      if (isCurrentScope) setPredictions(mergedRows);
    });
  }

  function selectCloudStockCode(code: string) {
    if (!code) return;
    setStockCode(code);
    setQueryCode(code);
  }

  function buildCloudPredictionSnapshot() {
    return createPredictionEventsFromStorageSnapshot(collectAppStorage(), getCloudDeviceId());
  }

  async function syncCloudPredictions(user = cloudUser, quiet = false) {
    if (!user) {
      if (!quiet) {
        setIsCloudAccountOpen(true);
        showToast('请先登录云端账户，再同步预测数据', 'warning');
      }
      return;
    }

    setCloudSyncState('syncing');
    try {
      const events = await downloadPredictionEvents(user);
      applyCloudEventsLocally(events);
      setCloudSyncState('ready');
      if (!quiet) {
        showToast(`云端读取完成：${events.length} 条预测数据`, 'success');
      }
    } catch (err) {
      setCloudSyncState('error');
      if (!quiet) {
        showToast(err instanceof Error ? `云端同步失败：${err.message}` : '云端同步失败，本地预测已保留并等待下次重试', 'warning');
      }
    }
  }

  async function readCloudPredictions(user = cloudUser) {
    if (!user) {
      setIsCloudAccountOpen(true);
      showToast('请先登录云端账户，再读取预测数据', 'warning');
      return;
    }

    setCloudSyncState('syncing');
    try {
      const events = await downloadPredictionEvents(user);
      applyCloudEventsLocally(events);
      setCloudSyncState('ready');
      showToast(`已从云端读取 ${events.length} 条预测事件`, 'success');
    } catch (err) {
      setCloudSyncState('error');
      showToast(err instanceof Error ? `云端读取失败：${err.message}` : '云端读取失败', 'warning');
    }
  }

  async function saveCurrentWorkspaceToCloud() {
    saveCurrentWorkspace({ force: true, notice: 'silent' });
    if (!cloudUser) {
      setIsCloudAccountOpen(true);
      showToast('请先登录云端账户，再保存预测数据', 'warning');
      return;
    }

    setCloudSyncState('syncing');
    try {
      const snapshotEvents = buildCloudPredictionSnapshot();
      if (!snapshotEvents.length) {
        throw new Error('本机没有预测数据，已取消覆盖云端');
      }
      await replaceCloudPredictionEvents(cloudUser, snapshotEvents);
      clearCloudOutbox();
      applyCloudEventsLocally(snapshotEvents);
      setCloudSyncState('ready');
      showToast(`已用本机全部 ${snapshotEvents.length} 条预测覆盖云端`, 'success');
    } catch (err) {
      setCloudSyncState('error');
      showToast(err instanceof Error ? `云端保存失败：${err.message}` : '云端保存失败，修改会在下次重试', 'warning');
    }
  }

  */
  function selectCloudStockCode(code: string) {
    if (!code) return;
    setStockCode(code);
    setQueryCode(code);
  }

  async function readCloudPredictions(user = cloudUser) {
    if (!user) {
      setIsCloudAccountOpen(true);
      return;
    }
    await loadCloudWorkspace(user);
  }

  async function saveCurrentWorkspaceToCloud() {
    saveCurrentWorkspace({ force: true, notice: 'silent' });
    await cloudSaveQueueRef.current?.flush();
    if (cloudSaveQueueRef.current?.getStatus() === 'error') {
      showToast('Cloud save failed. Please retry.', 'warning');
      return;
    }
    showToast('Saved to cloud.', 'success');
  }

  async function submitCloudAccount(mode: 'sign-in') {
    const email = cloudEmail.trim();
    if (!email || !cloudPassword) {
      showToast('请填写云端账户邮箱和密码', 'warning');
      return;
    }

    setCloudSyncState('syncing');
    try {
      /* Public sign-up is disabled. Accounts are provisioned by an administrator.
      if (mode === 'sign-up') {
        const result = await signUpForCloud(email, cloudPassword);
        if (!result.user) throw new Error('注册未返回账户信息');
        if (result.needsEmailConfirmation) {
          setCloudSyncState('signed-out');
          showToast('注册成功，请先到邮箱确认后再登录', 'success');
          return;
        }
        setCloudUser(result.user);
        setIsCloudAccountOpen(false);
        await syncCloudPredictions(result.user);
        return;
      }
      */

      const user = await signInToCloud(email, cloudPassword);
      if (!user) throw new Error('登录未返回账户信息');
      setCloudUser(user);
      setIsCloudAccountOpen(false);
      await loadCloudWorkspace(user);
    } catch (err) {
      setCloudSyncState('error');
      showToast(err instanceof Error ? `云端账户操作失败：${err.message}` : '云端账户操作失败', 'warning');
    }
  }

  async function signOutCloudAccount() {
    try {
      await signOutOfCloud();
      cloudSessionGenerationRef.current += 1;
      cloudSaveQueueRef.current?.switchAccount('', 0);
      cloudWorkspaceRef.current = null;
      setCloudUser(null);
      setCloudWorkspace(null);
      setCloudRole(null);
      setPredictions([]);
      setForecastHistory([]);
      setData(null);
      setDataPeriod(null);
      setCloudSyncState('signed-out');
      setIsCloudAccountOpen(false);
      showToast('已退出云端账户。本地预测仍保留在本机。', 'info');
    } catch (err) {
      showToast(err instanceof Error ? `退出云端账户失败：${err.message}` : '退出云端账户失败', 'warning');
    }
  }

  function updatePrediction(targetDate: string, value: string) {
    const normalizedValue = normalizeDecimalInput(value);
    const nextRows = predictions.map((row) =>
      row.targetDate === targetDate
        ? setPredictionInputValue(row, inputMaWindow, normalizedValue)
        : row,
    );
    setPredictions(nextRows);
    persistPredictionDraft(nextRows);
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

  async function refreshHistoricalData() {
    capturePredictionHistory(predictions, data);
    ALL_KLINE_PERIODS.filter((workspacePeriod) => workspacePeriod !== dataPeriod).forEach(
      captureCachedPredictionHistory,
    );
    setIsLoading(true);
    setError('');
    showToast('正在联网更新日K、周K、月K历史收盘价...', 'info');

    try {
      const results = await refreshAllKLinePeriods((workspacePeriod) =>
        fetchKLines(stockCode, workspacePeriod),
      );
      const successful = results.flatMap((result) => {
        if (result.status !== 'success') return [];
        const completed = filterCompletedKLineData(markAsOnlineResult(result.data), result.period);
        marketDataRef.current.set(marketScopeKey(completed.data.code, result.period), completed.data);
        return [{ period: result.period, completed }];
      });
      const active = successful.find((result) => result.period === period);
      const failed = results.filter((result) => result.status === 'failed');

      if (active) {
        setData(active.completed.data);
        setDataPeriod(period);
        setBaseDate(active.completed.lastCompletedDate ?? todayDate);
        setStockCode(active.completed.data.code);
        setQueryCode(active.completed.data.code);
      }

      if (successful.length) {
        const updated = successful.map((result) => getPeriodLabel(result.period)).join('、');
        showToast(`已联网更新：${updated}，${new Date().toLocaleString()}`, failed.length ? 'warning' : 'success');
      } else {
        showToast('日K、周K、月K均联网更新失败，继续使用本地缓存', 'warning');
      }

      if (active && active.completed.data.points.length < minHistoryCount) {
        setError(`联网数据不足${minHistoryCount}条，MA60计算可能不完整`);
      } else if (failed.length) {
        setError(`部分周期联网更新失败：${failed.map((result) => getPeriodLabel(result.period)).join('、')}`);
      } else if (!successful.length) {
        setError('日K、周K、月K联网更新均失败，请检查网络后重试');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '联网更新失败';
      setError(`联网更新异常：${message}`);
      showToast('联网更新异常，继续使用本地缓存', 'warning');
    } finally {
      setIsLoading(false);
    }
  }

  function updateNote(value: string) {
    const nextRows = predictions.map((row) => ({ ...row, note: value }));
    setPredictions(nextRows);
    persistPredictionDraft(nextRows);
  }

  function resetRows() {
    if (!data || !baseDate) return;
    const nextRows = generatePredictionRows(data.points, period, baseDate, forecastRowCount);
    setPredictions(nextRows);
    persistPredictionDraft(nextRows);
    showToast('已重置当前预测表', 'success');
  }

  function exportAllData() {
    if (!cloudWorkspace) {
      showToast('No cloud workspace is loaded.', 'warning');
      return;
    }
    const blob = new Blob([JSON.stringify(cloudWorkspace, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `gupiao-cloud-workspace-${formatDate(new Date())}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast('Cloud workspace exported.', 'success');
    return;
    /*
    if (data && baseDate && predictions.length) {
      savePredictions(predictionPlanKey(data.code, period, baseDate), predictions);
      saveWorkspaceCache({
        stockCode: data.code,
        period,
        baseDate,
        updatedAt: new Date().toISOString(),
      });
    }

    const storage = collectAppStorage();
    if (!Object.keys(storage).length) {
      showToast('暂无可导出的本地数据', 'warning');
      return;
    }

    const fileData: FullBackupFileV1 = {
      schema: 'gupiao-ma40-full-backup/v1',
      exportedAt: new Date().toISOString(),
      appVersion,
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
    */
  }

  function exportPredictions() {
    if (!data || !baseDate || !predictions.length) {
      showToast('暂无可导出的预测数据', 'warning');
      return;
    }

    const fileData: PredictionFileV5 = {
      schema: 'gupiao-ma40-predictions/v1',
      exportedAt: new Date().toISOString(),
      stockCode: data.code,
      stockName: data.name,
      period,
      baseDate,
      predictions,
    };
    const blob = new Blob([JSON.stringify(fileData, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${data.code}-${period}-${baseDate}-forecast-ma40.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast('预测文件已导出', 'success');
  }

  async function importPredictions(file: File | undefined) {
    if (!file) return;

    try {
      const rawFile = JSON.parse(await file.text()) as unknown;
      const workspace = isCloudWorkspace(rawFile)
        ? rawFile
        : createCloudWorkspaceFromLegacyBackup(rawFile);
      if (!cloudUser) throw new Error('Please sign in before importing data.');
      const saved = await saveMyCloudWorkspace(workspace, cloudWorkspaceRevision);
      cloudWorkspaceRef.current = saved.payload;
      setCloudWorkspace(saved.payload);
      setCloudWorkspaceRevision(saved.revision);
      setStockCode(saved.payload.workspace.stockCode);
      setQueryCode(saved.payload.workspace.stockCode);
      setPeriod(saved.payload.workspace.period);
      showToast('Imported into the current cloud account.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Import failed.', 'warning');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
    return;
    /*

    try {
      const text = await file.text();
      const rawFile = JSON.parse(text);
      const backup = normalizeFullBackupFile(rawFile);
      if (backup) {
        const recovery = recoverForecastHistoryFromBackupStorage(backup.storage);
        restoreAppStorage(recovery.storage);
        await persistElectronStorage();
        const recoveryNotice = recovery.recoveredCount
          ? `，已恢复${recovery.recoveredCount}条历史预测`
          : '';
        showToast(
          `已导入全部本地数据：${Object.keys(backup.storage).length}项${recoveryNotice}，正在刷新`,
          'success',
        );
        if (cloudUser) {
          const snapshotEvents = buildCloudPredictionSnapshot();
          if (snapshotEvents.length) {
            await replaceCloudPredictionEvents(cloudUser, snapshotEvents);
            clearCloudOutbox();
            applyCloudEventsLocally(snapshotEvents);
            showToast(`已用导入数据重建云端：${snapshotEvents.length} 条预测`, 'success');
          }
        }
        window.setTimeout(() => window.location.reload(), 500);
        return;
      }

      const parsed = normalizePredictionFile(rawFile);
      if (!parsed) {
        throw new Error('文件格式不是本系统导出的 MA40 预测文件');
      }

      importedPlanRef.current = parsed;
      setStockCode(parsed.stockCode);
      setQueryCode(parsed.stockCode);
      setPeriod(parsed.period);
      setPredictions(parsed.predictions);
      savePredictions(predictionPlanKey(parsed.stockCode, parsed.period, baseDate), parsed.predictions);
      saveWorkspaceCache({
        stockCode: parsed.stockCode,
        period: parsed.period,
        baseDate,
        updatedAt: new Date().toISOString(),
      });
      showToast(`已选择文件：${file.name}`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导入失败', 'warning');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
    */
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

  if (!isCloudSyncConfigured()) {
    return <main className="app-shell"><div className="error-banner">Cloud configuration is required.</div></main>;
  }

  if (!cloudUser || isCloudWorkspaceLoading || !cloudWorkspace) {
    return (
      <main className="app-shell">
        <div className="loading">
          {isCloudWorkspaceLoading ? 'Loading cloud workspace...' : 'Please sign in to use your cloud workspace.'}
        </div>
        <CloudAccountModal
          email={cloudEmail}
          password={cloudPassword}
          cloudUser={cloudUser}
          isBusy={cloudSyncState === 'syncing'}
          onEmailChange={setCloudEmail}
          onPasswordChange={setCloudPassword}
          onSignIn={() => void submitCloudAccount('sign-in')}
          onSignOut={() => void signOutCloudAccount()}
          onClose={() => setIsCloudAccountOpen(false)}
        />
      </main>
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
        <div className="stock-search">
          <label htmlFor="stockCode">股票代码</label>
          <input
            id="stockCode"
            value={stockCode}
            inputMode="numeric"
            maxLength={6}
            onChange={(event) => setStockCode(event.target.value)}
          />
          {cloudStockCodes.length ? (
            <select
              aria-label="云端预测股票代码"
              value={cloudStockCodes.includes(stockCode) ? stockCode : ''}
              onChange={(event) => selectCloudStockCode(event.target.value)}
            >
              <option value="" disabled>
                云端股票
              </option>
              {cloudStockCodes.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          ) : null}
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
          <button
            type="button"
            className={`cloud-sync-button ${cloudSyncState}`}
            onClick={() => (cloudUser ? void readCloudPredictions() : setIsCloudAccountOpen(true))}
            disabled={cloudSyncState === 'syncing' || cloudSyncState === 'unconfigured'}
            title={
              cloudSyncState === 'unconfigured'
                ? '云端同步尚未配置'
                : cloudUser
                  ? `已登录 ${cloudUser.email ?? '云端账户'}，点击从云端读取预测`
                  : '登录云端账户后读取网页与 EXE 的预测数据'
            }
          >
            {cloudSyncState === 'syncing' ? '读取中' : cloudUser ? '从云端读取' : '登录云端'}
          </button>
        </div>
      </section>

      <section className="control-band">
        <div className="segmented">
          {periods.map((item) => (
            <button
              key={item.value}
              type="button"
              className={period === item.value ? 'active' : ''}
              onClick={() => setPeriod(item.value)}
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
              forecastDates={forecastDates}
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
                导出
              </button>
              <button
                type="button"
                className="ghost primary-save"
                onClick={() => void saveCurrentWorkspaceToCloud()}
              >
                向云端保存
              </button>
              <button type="button" className="ghost" onClick={() => fileInputRef.current?.click()}>
                导入
              </button>
              <button type="button" className="ghost" onClick={resetRows}>
                重置
              </button>
              <button
                type="button"
                className="ghost history-open-button"
                onClick={() => setIsHistoryModalOpen(true)}
              >
                历史对比 {visibleHistoryRows.length}
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

          <div className="input-mode-strip" aria-label="预测输入均线选择">
            <span>预测输入</span>
            {MA_WINDOWS.map((windowSize) => (
              <button
                key={windowSize}
                type="button"
                className={inputMaWindow === windowSize ? 'active' : ''}
                onClick={() => setInputMaWindow(windowSize)}
              >
                MA{windowSize}
              </button>
            ))}
          </div>

          {renderPredictionTable()}

          <label className="note-field">
            <span>备注</span>
            <textarea
              value={predictions[0]?.note ?? ''}
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

      {isHistoryModalOpen ? (
        <ForecastHistoryModal
          rows={visibleHistoryRows}
          inputMaWindow={inputMaWindow}
          onClose={() => setIsHistoryModalOpen(false)}
        />
      ) : null}

      {detailRow ? (
        <CalculationDetailModal
          row={detailRow}
          inputMaWindow={inputMaWindow}
          onClose={() => setDetailTargetDate(null)}
        />
      ) : null}

      {isCloudAccountOpen ? (
        <CloudAccountModal
          email={cloudEmail}
          password={cloudPassword}
          cloudUser={cloudUser}
          isBusy={cloudSyncState === 'syncing'}
          onEmailChange={setCloudEmail}
          onPasswordChange={setCloudPassword}
          onSignIn={() => void submitCloudAccount('sign-in')}
          onSignOut={() => void signOutCloudAccount()}
          onClose={() => setIsCloudAccountOpen(false)}
        />
      ) : null}
    </main>
  );
}

function CloudAccountModal({
  email,
  password,
  cloudUser,
  isBusy,
  onEmailChange,
  onPasswordChange,
  onSignIn,
  onSignOut,
  onClose,
}: {
  email: string;
  password: string;
  cloudUser: User | null;
  isBusy: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  return (
    <div className="table-modal-backdrop" role="presentation">
      <section className="cloud-account-modal" role="dialog" aria-modal="true" aria-label="云端账户">
        <div className="table-modal-head">
          <div>
            <p className="eyebrow">Cloud Prediction Sync</p>
            <h2>云端账户</h2>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>
        {cloudUser ? (
          <div className="cloud-account-signed-in">
            <strong>{cloudUser.email ?? '已登录云端账户'}</strong>
            <p>此账户的预测数据会在网页端和 EXE 端同步。行情更新不会覆盖已输入的预测。</p>
            <button type="button" className="ghost" onClick={onSignOut} disabled={isBusy}>
              退出登录
            </button>
          </div>
        ) : (
          <div className="cloud-account-form">
            <label>
              <span>邮箱</span>
              <input
                type="email"
                value={email}
                onChange={(event) => onEmailChange(event.target.value)}
                autoComplete="email"
              />
            </label>
            <label>
              <span>密码</span>
              <input
                type="password"
                value={password}
                onChange={(event) => onPasswordChange(event.target.value)}
                autoComplete="current-password"
              />
            </label>
            <div className="cloud-account-actions">
              <button type="button" onClick={onSignIn} disabled={isBusy}>
                登录并同步
              </button>
              {/* Account provisioning is restricted to administrators.
              <button type="button" className="ghost" onClick={onSignUp} disabled={isBusy}>
                注册账户
              </button> */}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function ForecastHistoryModal({
  rows,
  inputMaWindow,
  onClose,
}: {
  rows: ForecastHistoryRow[];
  inputMaWindow: MaWindow;
  onClose: () => void;
}) {
  return (
    <div className="detail-modal-backdrop" role="presentation">
      <section className="history-modal" role="dialog" aria-modal="true" aria-label="历史预测对比">
        <div className="detail-modal-head">
          <div>
            <p className="eyebrow">Historical Forecasts</p>
            <h2>历史预测与真实价格对比</h2>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="history-table">
          <div className="history-row history-head">
            <span>预测日期</span>
            <span>预测收盘</span>
            <span>真实收盘</span>
            <span>差值</span>
            <span>预测MA{inputMaWindow}</span>
            <span>真实MA{inputMaWindow}</span>
          </div>
          {rows.length ? (
            rows.map((row) => (
              <div className="history-row" key={row.id}>
                <span className="date-cell">{row.actualDate ?? row.targetDate}</span>
                <strong className="history-predicted">{formatNumber(row.predictedClose)}</strong>
                <strong>{formatNumber(row.actualClose)}</strong>
                <span>{formatSignedNumber(row.closeDiff)}</span>
                <span>{formatNumber(row.predictedMaValues[inputMaWindow])}</span>
                <span>{formatNumber(row.actualMaValues[inputMaWindow])}</span>
              </div>
            ))
          ) : (
            <div className="empty-history">暂无已形成真实K线的预测记录。</div>
          )}
        </div>
      </section>
    </div>
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

function formatSignedNumber(value: number | null) {
  if (value === null) return '--';
  return `${value > 0 ? '+' : ''}${formatNumber(value)}`;
}

function normalizeStockCode(value: string) {
  return value.replace(/\D/g, '').slice(0, 6);
}

function getPeriodLabel(period: PeriodType) {
  return periods.find((item) => item.value === period)?.label ?? period;
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

function collectAppStorage() {
  const storage: Record<string, string> = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !isAppStorageKey(key)) continue;

    const value = localStorage.getItem(key);
    if (value !== null) storage[key] = value;
  }

  return storage;
}

function restoreAppStorage(storage: Record<string, string>) {
  Object.entries(storage).forEach(([key, value]) => {
    if (isAppStorageKey(key) && typeof value === 'string') {
      localStorage.setItem(key, value);
    }
  });
}

function normalizeFullBackupFile(value: unknown): FullBackupFileV1 | null {
  if (!isFullBackupFileV1(value)) return null;

  return {
    schema: value.schema,
    exportedAt: value.exportedAt,
    appVersion: value.appVersion,
    storage: Object.fromEntries(
      Object.entries(value.storage).filter(
        ([key, storedValue]) => isAppStorageKey(key) && typeof storedValue === 'string',
      ),
    ),
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

function isAppStorageKey(key: string) {
  return key.startsWith('prediction-ma40:') || key.startsWith('prediction-ma:');
}

function normalizePredictionFile(value: unknown): PredictionFileV5 | null {
  if (!isPredictionFileV5(value)) return null;

  return {
    ...value,
    predictions: value.predictions.map(normalizePredictionPoint),
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

function isCloudWorkspace(value: unknown): value is CloudWorkspace {
  const candidate = value as Partial<CloudWorkspace>;
  return (
    candidate?.schema === 'gupiao-cloud-workspace/v1' &&
    !!candidate.workspace &&
    !!candidate.predictions &&
    !!candidate.forecastHistory
  );
}

function marketScopeKey(stockCode: string, period: PeriodType) {
  return `${stockCode.replace(/\D/g, '').slice(0, 6)}:${period}`;
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
