import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import packageJson from '../package.json';
import KLineChart, {
  type ChartLineSeries,
  type ChartPointSeries,
} from './components/KLineChart';
import { fetchKLines } from './services/eastmoney';
import { fetchStockNames, searchStocks, type StockSuggestion } from './services/stockSearch';
import type { PeriodType, PredictionPoint, StockKLineResponse } from './types';
import { filterCompletedKLineData } from './utils/completedPeriods';
import {
  getCloudProfile,
  getCloudUser,
  isCloudSyncConfigured,
  loadMyStockCodes,
  loadMyCloudWorkspace,
  rememberMyStockCode,
  replaceMyCloudWorkspace,
  resetMyForecastScopeV1,
  saveMyPredictionValues,
  saveMyWorkspacePreferences,
  signInToCloud,
  signOutOfCloud,
  upsertMyForecastHistory,
} from './utils/supabase';
import type { User } from '@supabase/supabase-js';
import {
  buildForecastHistoryRows,
  filterForecastHistorySnapshots,
  mergeForecastHistory,
  selectLatestChartForecastHistoryRows,
  type ForecastHistorySnapshot,
  type ForecastHistoryRow,
} from './utils/forecastHistory';
import {
  applyForecastHistoryOutboxToWorkspace,
  assertCloudWorkspaceContainsLocalData,
  clearWorkspaceForecastScope,
  createEmptyCloudWorkspace,
  createFullWorkspaceBackup,
  createCloudWorkspaceFromLegacyBackup,
  getWorkspaceForecastHistory,
  getWorkspacePredictions,
  hasPredictionDraftContent,
  readFullWorkspaceImport,
  resolveActiveWorkspaceScope,
  setWorkspaceForecastHistory,
  setWorkspacePredictions,
  type CloudWorkspace,
  type CloudWorkspaceScope,
} from './utils/cloudWorkspace';
import {
  applyPredictionValueMutationsToWorkspace,
  createPredictionValueMutations,
  createPredictionValueSaveQueue,
  type CloudPredictionSaveState,
} from './utils/cloudPredictionStorage';
import {
  loadCloudPredictionOutbox,
  saveCloudPredictionOutbox,
  type CloudPredictionOutboxSnapshot,
} from './utils/cloudOutbox';
import {
  createForecastHistorySaveQueue,
  loadCloudHistoryOutbox,
  saveCloudHistoryOutbox,
  type CloudHistoryOutboxSnapshot,
} from './utils/cloudHistoryStorage';
import {
  buildForecastCloseChartRows,
  buildForecastCloseTableRows,
  getForecastCloseCell,
  getLatestActualCloseContext,
  getLatestCompletedTargetDate,
} from './utils/forecastCloseDisplay';
import { formatNumber, summarizeForecastHistory } from './utils/metrics';
import { mergeLineValuePointsPreservingEarlier } from './utils/linePoints';
import {
  buildMa40Projection,
  type LineValuePoint,
  type Ma40ProjectionRow,
  MA40_WINDOW,
  MA_WINDOWS,
  type MaWindow,
} from './utils/movingAverage';
import {
  createIssuedForecastBatch,
  evaluateIssuedForecastBatch,
  getIssuedForecastPeriodKey,
  selectActiveIssuedForecastBatch,
  sortIssuedForecastBatches,
  type EvaluatedIssuedForecastRow,
  type IssuedForecastBatch,
} from './utils/issuedForecastBatch';
import {
  isIssuedForecastSnapshot,
  issuedForecastBatchToHistorySnapshots,
  loadMyIssuedForecastBatchesV2,
  saveMyIssuedForecastBatchV2,
} from './utils/issuedForecastStorage';
import { loadChartViewport, saveChartViewport, type ChartViewport } from './utils/chartViewport';
import {
  generatePredictionRows,
  hydratePredictionRows,
  normalizePredictionPoint,
  selectPredictionRowsForInputTable,
} from './utils/predictions';
import { ALL_KLINE_PERIODS, refreshAllKLinePeriods } from './utils/periodRefresh';
import {
  getDueAStockRefreshEvent,
  isAStockRefreshEventFresh,
  MARKET_AUTO_REFRESH_CHECK_MS,
  shouldAttemptAStockRefresh,
  type AStockRefreshPhase,
} from './utils/marketAutoRefresh';

const periods: Array<{ value: PeriodType; label: string; unit: string }> = [
  { value: 'day', label: '日K', unit: '日' },
  { value: 'week', label: '周K', unit: '周' },
  { value: 'month', label: '月K', unit: '月' },
];

const forecastRowCount = Math.max(...MA_WINDOWS);
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
const TOAST_PRIORITY = { info: 0, success: 1, warning: 2 } as const;
const TOAST_DURATION = { info: 5000, success: 6000, warning: 12000 } as const;
// 名称是公开行情数据，只做本机缓存，不进云端数据库。
const STOCK_NAME_CACHE_KEY = 'stock-name-cache:v1';

function loadStockNameCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STOCK_NAME_CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([code, name]) => /^\d{6}$/.test(code) && typeof name === 'string' && name,
      ),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveStockNameCache(names: Record<string, string>) {
  try {
    localStorage.setItem(STOCK_NAME_CACHE_KEY, JSON.stringify(names));
  } catch {
    // 缓存失败不影响主流程
  }
}

function movePredictionFocus(current: HTMLInputElement, offset: number) {
  const table = current.closest('.prediction-table');
  if (!table) return;
  const inputs = Array.from(table.querySelectorAll<HTMLInputElement>('input.prediction-input'));
  const next = inputs[inputs.indexOf(current) + offset];
  if (next) {
    next.focus();
    next.select();
  }
}

function translateCloudError(err: unknown, fallback = '云端账户操作失败'): string {
  const message = err instanceof Error ? err.message : '';
  if (/invalid login credentials/i.test(message)) return '邮箱或密码不正确，请重新输入';
  if (/email not confirmed/i.test(message)) return '邮箱尚未完成确认，请先到邮箱点击确认链接';
  if (/failed to fetch|network|timeout/i.test(message)) return '网络连接失败，请检查网络后重试';
  if (/rate limit/i.test(message)) return '尝试次数过多，请稍后再试';
  return message ? `${fallback}：${message}` : `${fallback}，请稍后重试`;
}

function useDialogFocus() {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previousFocus?.focus?.();
  }, []);
  return ref;
}

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

interface MarketRefreshResult {
  successfulPeriods: PeriodType[];
  failedPeriods: PeriodType[];
  lastCompletedDates: Partial<Record<PeriodType, string | null>>;
}

export default function App() {
  const [stockCode, setStockCode] = useState('000166');
  const [queryCode, setQueryCode] = useState('000166');
  const [period, setPeriod] = useState<PeriodType>('month');
  const [data, setData] = useState<StockKLineResponse | null>(null);
  const [dataPeriod, setDataPeriod] = useState<PeriodType | null>(null);
  const [baseDate, setBaseDate] = useState(todayDate);
  const [predictions, setPredictions] = useState<PredictionPoint[]>([]);
  const [predictionScope, setPredictionScope] = useState<CloudWorkspaceScope | null>(null);
  const [forecastHistory, setForecastHistory] = useState<ForecastHistorySnapshot[]>([]);
  const [issuedForecastBatches, setIssuedForecastBatches] = useState<IssuedForecastBatch[]>([]);
  const [visibleMaWindows, setVisibleMaWindows] = useState<MaWindow[]>([5, 10, 20, 40, 60]);
  const [showActualMaLines, setShowActualMaLines] = useState(true);
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
  const [isCloudWorkspaceLoading, setIsCloudWorkspaceLoading] = useState(false);
  const [isIssuingForecast, setIsIssuingForecast] = useState(false);
  const [isResettingForecastScope, setIsResettingForecastScope] = useState(false);
  const [cloudStockCodes, setCloudStockCodes] = useState<string[]>([]);
  const [cloudSyncState, setCloudSyncState] = useState<CloudSyncState>(
    isCloudSyncConfigured() ? 'signed-out' : 'unconfigured',
  );
  const [cloudPredictionSaveState, setCloudPredictionSaveState] = useState<CloudPredictionSaveState>({
    status: 'idle',
    pendingCount: 0,
    lastSavedAt: null,
    error: null,
  });
  const [cloudHistorySaveState, setCloudHistorySaveState] = useState<CloudPredictionSaveState>({
    status: 'idle',
    pendingCount: 0,
    lastSavedAt: null,
    error: null,
  });
  const [cloudEmail, setCloudEmail] = useState('');
  const [cloudPassword, setCloudPassword] = useState('');
  const [isCloudAccountOpen, setIsCloudAccountOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'success' | 'warning' } | null>(
    null,
  );
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);
  const [stockNames, setStockNames] = useState<Record<string, string>>(loadStockNameCache);
  const [searchCandidates, setSearchCandidates] = useState<StockSuggestion[]>([]);
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const searchTimerRef = useRef<number | null>(null);
  const searchGenerationRef = useRef(0);
  const nameResolveAttemptsRef = useRef(new Set<string>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toastRef = useRef<{ message: string; type: 'info' | 'success' | 'warning' } | null>(null);
  const expandedDialogRef = useRef<HTMLElement | null>(null);
  const importedPlanRef = useRef<PredictionFileV5 | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const cloudWorkspaceRef = useRef<CloudWorkspace | null>(null);
  const cloudWorkspaceBaselineRef = useRef<CloudWorkspace | null>(null);
  const cloudPredictionSaveQueueRef = useRef<ReturnType<typeof createPredictionValueSaveQueue> | null>(null);
  const cloudHistorySaveQueueRef = useRef<ReturnType<typeof createForecastHistorySaveQueue> | null>(null);
  const isResettingForecastScopeRef = useRef(false);
  const cloudSessionGenerationRef = useRef(0);
  const stockQueryGenerationRef = useRef(0);
  const marketDataRef = useRef(new Map<string, StockKLineResponse>());
  const marketRefreshInFlightRef = useRef<{
    requestKey: string;
    promise: Promise<MarketRefreshResult>;
  } | null>(null);
  const autoRefreshCompletedEventsRef = useRef(new Map<string, string>());
  const autoRefreshLastAttemptsRef = useRef(
    new Map<string, { eventId: string; at: number }>(),
  );
  const selectedMarketScopeRef = useRef({ stockCode: normalizeStockCode(queryCode), period });
  const automaticMarketRefreshRunnerRef = useRef(
    (_phase: AStockRefreshPhase): Promise<MarketRefreshResult> =>
      Promise.resolve({
        successfulPeriods: [],
        failedPeriods: [...ALL_KLINE_PERIODS],
        lastCompletedDates: {},
      }),
  );
  selectedMarketScopeRef.current = { stockCode: normalizeStockCode(queryCode), period };
  automaticMarketRefreshRunnerRef.current = (phase) =>
    refreshHistoricalData({
      targetStockCode: queryCode,
      targetPeriod: period,
      trigger: phase,
    });
  const activeScope = resolveActiveWorkspaceScope({
    dataStockCode: data?.code,
    dataPeriod,
    selectedStockCode: queryCode,
    selectedPeriod: period,
    predictionStockCode: predictionScope?.stockCode,
    predictionPeriod: predictionScope?.period ?? null,
  });
  const activeData = activeScope ? data : null;
  const cloudSaveState = combineCloudSaveStates(cloudPredictionSaveState, cloudHistorySaveState);
  const persistedChartViewport =
    activeData && activeScope
      ? loadChartViewport(activeData.code, activeScope.period)
      : null;

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
    if (!cloudUser || !cloudWorkspace) return;

    let cancelled = false;

    const checkMarketSession = async () => {
      const event = getDueAStockRefreshEvent();
      if (!event || cancelled) return;
      const requestedStockCode = normalizeStockCode(queryCode);
      if (requestedStockCode.length !== 6) return;
      if (
        !shouldAttemptAStockRefresh(
          event,
          autoRefreshCompletedEventsRef.current.get(requestedStockCode) ?? null,
          autoRefreshLastAttemptsRef.current.get(requestedStockCode) ?? null,
        )
      ) {
        return;
      }

      autoRefreshLastAttemptsRef.current.set(requestedStockCode, {
        eventId: event.id,
        at: Date.now(),
      });
      const result = await automaticMarketRefreshRunnerRef.current(event.phase);
      if (cancelled) return;

      const allPeriodsSucceeded =
        result.successfulPeriods.length === ALL_KLINE_PERIODS.length &&
        result.failedPeriods.length === 0;
      const closeDataIsFresh = isAStockRefreshEventFresh(event, result.lastCompletedDates.day);

      if (allPeriodsSucceeded && !closeDataIsFresh && event.phase === 'close') {
        showToast('收盘最终K线尚未返回，系统将在稍后自动重试', 'warning');
      }

      if (allPeriodsSucceeded && closeDataIsFresh) {
        autoRefreshCompletedEventsRef.current.set(requestedStockCode, event.id);
        autoRefreshLastAttemptsRef.current.delete(requestedStockCode);
      }
    };

    void checkMarketSession();
    const timer = window.setInterval(() => void checkMarketSession(), MARKET_AUTO_REFRESH_CHECK_MS);
    const onFocus = () => void checkMarketSession();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void checkMarketSession();
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [cloudUser?.id, Boolean(cloudWorkspace), period, queryCode]);

  useEffect(() => {
    if (!cloudWorkspace) return;
    const cached = marketDataRef.current.get(marketScopeKey(queryCode, period));
    setError('');

    if (!cached) {
      setData(null);
      setDataPeriod(null);
      setPredictions(getWorkspacePredictions(cloudWorkspace, { stockCode: queryCode, period }));
      setPredictionScope({ stockCode: normalizeStockCode(queryCode), period });
      setForecastHistory(getWorkspaceForecastHistory(cloudWorkspace, { stockCode: queryCode, period }));
      setBaseDate(cloudWorkspace.workspace.baseDate || todayDate);
      // 缓存未命中是首次使用/离线的正常空态，由图表区的引导空态处理，不弹红色错误横幅。
      return;
    }

    const completed = filterCompletedKLineData(cached, period);
    setData(completed.data);
    setDataPeriod(period);
    setBaseDate(completed.lastCompletedDate ?? todayDate);
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
      setPredictionScope({ stockCode: normalizeStockCode(data.code), period });
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
    setPredictions(hydratePredictionRows(storedRows, data.points, period, baseDate, forecastRowCount));
    setPredictionScope({ stockCode: normalizeStockCode(data.code), period });
  }, [baseDate, cloudWorkspace, data, period]);

  useEffect(() => {
    if (!data || dataPeriod !== period || !cloudWorkspace) return;
    setForecastHistory(getWorkspaceForecastHistory(cloudWorkspace, { stockCode: data.code, period }));
  }, [cloudWorkspace, data, dataPeriod, period]);

  useEffect(() => {
    if (!activeData || !activeScope || !baseDate || !predictions.length) return;
    if (!hasPredictionDraftContent(predictions)) {
      setHasUnsavedChanges(false);
      return;
    }
    setHasUnsavedChanges(true);
  }, [activeData, activeScope?.period, baseDate, predictions]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      saveCurrentWorkspace({ notice: 'auto' });
    }, 30000);

    return () => window.clearInterval(timer);
  }, [activeData, activeScope?.period, baseDate, hasUnsavedChanges, predictions]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (confirmAction) setConfirmAction(null);
      else if (detailTargetDate) setDetailTargetDate(null);
      else if (isHistoryModalOpen) setIsHistoryModalOpen(false);
      else if (isTableExpanded) setIsTableExpanded(false);
      else if (isCloudAccountOpen && cloudUser) setIsCloudAccountOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmAction, detailTargetDate, isHistoryModalOpen, isTableExpanded, isCloudAccountOpen, cloudUser]);

  useEffect(() => {
    if (!isTableExpanded) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    expandedDialogRef.current?.focus();
    return () => previousFocus?.focus?.();
  }, [isTableExpanded]);

  const prevSaveStatusRef = useRef(cloudSaveState.status);
  useEffect(() => {
    if (cloudSaveState.status === 'error' && prevSaveStatusRef.current !== 'error') {
      showToast(formatCloudSaveError(cloudSaveState.error), 'warning');
    }
    prevSaveStatusRef.current = cloudSaveState.status;
  }, [cloudSaveState.status]);

  useEffect(() => {
    saveStockNameCache(stockNames);
  }, [stockNames]);

  useEffect(() => {
    // 每个代码本次会话只尝试解析一次，避免接口不可用时反复重试
    const missing = cloudStockCodes.filter(
      (code) => !stockNames[code] && !nameResolveAttemptsRef.current.has(code),
    );
    if (!missing.length) return;
    missing.forEach((code) => nameResolveAttemptsRef.current.add(code));
    let cancelled = false;
    void fetchStockNames(missing)
      .then((resolved) => {
        if (!cancelled && resolved.size) mergeStockNames(Array.from(resolved));
      })
      .catch(() => {
        // 名称解析失败不影响主流程，下拉退回只显示代码
      });
    return () => {
      cancelled = true;
    };
  }, [cloudStockCodes, stockNames]);

  useEffect(() => {
    if (data?.code && data.name) {
      mergeStockNames([[normalizeStockCode(data.code), data.name]]);
    }
  }, [data]);

  useEffect(
    () => () => {
      if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current);
    },
    [],
  );

  function mergeStockNames(entries: Array<[string, string]>) {
    setStockNames((current) => {
      const fresh = entries.filter(
        ([code, name]) => /^\d{6}$/.test(code) && name && current[code] !== name,
      );
      if (!fresh.length) return current;
      return { ...current, ...Object.fromEntries(fresh) };
    });
  }

  function closeStockSearch() {
    searchGenerationRef.current += 1;
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    setSearchCandidates([]);
    setSearchActiveIndex(0);
  }

  function handleStockInputChange(value: string) {
    setStockCode(value);
    const trimmed = value.trim();
    if (/^\d{6}$/.test(trimmed) || trimmed.length < 2) {
      closeStockSearch();
      return;
    }
    if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      searchTimerRef.current = null;
      void runStockSearch(trimmed, false);
    }, 300);
  }

  async function runStockSearch(keyword: string, autoSelectFirst: boolean) {
    const generation = ++searchGenerationRef.current;
    try {
      const results = await searchStocks(keyword);
      if (generation !== searchGenerationRef.current) return;
      mergeStockNames(results.map((item) => [item.code, item.name] as [string, string]));
      setSearchCandidates(results);
      setSearchActiveIndex(0);
      if (autoSelectFirst) {
        if (results.length) selectSearchCandidate(results[0]);
        else showToast('未找到匹配的股票，请检查名称或直接输入6位代码', 'warning');
      }
    } catch {
      if (generation === searchGenerationRef.current && autoSelectFirst) {
        showToast('股票搜索失败，请检查网络或直接输入6位代码', 'warning');
      }
    }
  }

  function selectSearchCandidate(candidate: StockSuggestion) {
    closeStockSearch();
    void queryStockCode(candidate.code);
  }

  function updateCloudWorkspace(transform: (workspace: CloudWorkspace) => CloudWorkspace) {
    const current = cloudWorkspaceRef.current;
    if (!current) return;
    const next = transform(current);
    cloudWorkspaceRef.current = next;
    setCloudWorkspace(next);
  }

  function createPredictionSaveQueueForUser(user: User, outbox: CloudPredictionOutboxSnapshot) {
    return createPredictionValueSaveQueue({
      accountId: user.id,
      initialMutations: outbox.mutations,
      initialLastSavedAt: outbox.lastSavedAt,
      save: async (mutations) => {
        await saveMyPredictionValues(mutations);
      },
      persist: (snapshot) => saveCloudPredictionOutbox(user.id, snapshot),
      onStateChange: setCloudPredictionSaveState,
    });
  }

  function createHistorySaveQueueForUser(user: User, outbox: CloudHistoryOutboxSnapshot) {
    return createForecastHistorySaveQueue({
      accountId: user.id,
      initialSnapshots: outbox.snapshots,
      initialLastSavedAt: outbox.lastSavedAt,
      save: async (snapshots) => {
        await upsertMyForecastHistory(snapshots);
      },
      persist: (snapshot) => saveCloudHistoryOutbox(user.id, snapshot),
      onStateChange: setCloudHistorySaveState,
    });
  }

  async function loadCloudWorkspace(user: User, quiet = false) {
    const generation = ++cloudSessionGenerationRef.current;
    cloudPredictionSaveQueueRef.current?.switchAccount('');
    cloudHistorySaveQueueRef.current?.switchAccount('');
    cloudWorkspaceRef.current = null;
    cloudWorkspaceBaselineRef.current = null;
    setCloudWorkspace(null);
    setCloudRole(null);
    setData(null);
    setDataPeriod(null);
    setPredictions([]);
    setPredictionScope(null);
    setForecastHistory([]);
    setIssuedForecastBatches([]);
    setIsCloudWorkspaceLoading(true);
    setCloudSyncState('syncing');

    try {
      const [profile, record, remoteStockCodes, remoteIssuedBatches] = await Promise.all([
        getCloudProfile(),
        loadMyCloudWorkspace(),
        loadMyStockCodes(),
        loadMyIssuedForecastBatchesV2(),
      ]);
      if (generation !== cloudSessionGenerationRef.current) return;
      if (!profile || profile.userId !== user.id) throw new Error('云端账户信息读取失败，请退出后重新登录');

      const remoteWorkspace = record?.payload ?? createEmptyCloudWorkspace();
      const outbox = loadCloudPredictionOutbox(user.id);
      const historyOutbox = loadCloudHistoryOutbox(user.id);
      const workspace = applyForecastHistoryOutboxToWorkspace(
        applyPredictionValueMutationsToWorkspace(remoteWorkspace, outbox.mutations),
        historyOutbox,
      );
      const revision = record?.revision ?? 0;

      cloudWorkspaceRef.current = workspace;
      cloudWorkspaceBaselineRef.current = remoteWorkspace;
      setCloudWorkspace(workspace);
      setCloudWorkspaceRevision(revision);
      setCloudRole(profile.role);
      setStockCode(workspace.workspace.stockCode);
      setQueryCode(workspace.workspace.stockCode);
      setPeriod(workspace.workspace.period);
      setBaseDate(workspace.workspace.baseDate || todayDate);
      setCloudStockCodes(remoteStockCodes);
      setIssuedForecastBatches(remoteIssuedBatches);
      cloudPredictionSaveQueueRef.current = createPredictionSaveQueueForUser(user, outbox);
      cloudHistorySaveQueueRef.current = createHistorySaveQueueForUser(user, historyOutbox);
      setCloudSyncState('ready');
      if (!quiet) showToast('云端数据已加载', 'success');
      const dueEvent = getDueAStockRefreshEvent();
      void refreshHistoricalData({
        targetStockCode: workspace.workspace.stockCode,
        targetPeriod: workspace.workspace.period,
        skipCurrentCapture: true,
        trigger: dueEvent?.phase ?? 'startup',
      });
    } catch (err) {
      if (generation !== cloudSessionGenerationRef.current) return;
      setCloudSyncState('error');
      if (!quiet) showToast(translateCloudError(err, '云端数据加载失败'), 'warning');
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
    if (isResettingForecastScopeRef.current) return;
    if (!activeData || !activeScope || !baseDate || !predictions.length || !cloudWorkspace) {
      if (notice === 'manual') showToast('暂无可保存的数据', 'warning');
      return;
    }
    if (!force && !hasUnsavedChanges) return;

    persistPredictionDraft(predictions);
    setHasUnsavedChanges(false);
    if (notice === 'manual') showToast('已保存到云端', 'success');
  }

  const projection = useMemo(
    () =>
      activeData && activeScope
        ? buildMa40Projection(activeData.points, predictions, baseDate, inputMaWindow, activeScope.period)
        : {
            rows: [],
            actualLines: createEmptyLineMap(),
            predictedLines: createEmptyLineMap(),
            closeByDate: new Map<string, number>(),
          },
    [activeData, activeScope?.period, baseDate, inputMaWindow, predictions],
  );
  const activeIssuedBatch = useMemo(
    () =>
      activeData && activeScope
        ? selectActiveIssuedForecastBatch(issuedForecastBatches, {
            stockCode: activeData.code,
            period: activeScope.period,
            inputMaWindow,
          })
        : null,
    [activeData, activeScope?.period, inputMaWindow, issuedForecastBatches],
  );
  const activeIssuedEvaluation = useMemo(() => {
    if (!activeData || !activeIssuedBatch || !baseDate || baseDate < activeIssuedBatch.asOfDate) return null;
    return evaluateIssuedForecastBatch(activeIssuedBatch, {
      points: activeData.points,
      evaluationAsOfDate: baseDate,
    });
  }, [activeData, activeIssuedBatch, baseDate]);
  const issuedRowsByPeriod = useMemo(
    () =>
      new Map(
        (activeIssuedEvaluation?.rows ?? []).map((row) => [row.periodKey, row]),
      ),
    [activeIssuedEvaluation],
  );
  const forecastDates = useMemo(
    () =>
      Array.from(
        new Set([
          ...projection.rows.filter((row) => row.isForecast).map((row) => row.targetDate),
          ...(activeIssuedEvaluation?.rows ?? [])
            .filter((row) => row.settlement === null)
            .map((row) => row.targetDate),
        ]),
      ).sort(),
    [activeIssuedEvaluation, projection.rows],
  );
  const historyRows = useMemo(
    () => {
      if (!activeData || !activeScope) return [];
      // Compatibility bridge rows carry a client timestamp. Exclude every
      // bridge revision from the legacy stream, then add only the canonical
      // batch selected by the authoritative server sequence.
      const legacySnapshots = filterForecastHistorySnapshots(
        forecastHistory,
        activeData.code,
        activeScope.period,
      ).filter((snapshot) => !isIssuedForecastSnapshot(snapshot));
      const canonicalIssuedSnapshots = activeIssuedBatch
        ? issuedForecastBatchToHistorySnapshots(activeIssuedBatch).map((snapshot) => ({
            ...snapshot,
            savedAt: activeIssuedBatch.serverPersistedAt ?? snapshot.savedAt,
          }))
        : [];
      return buildForecastHistoryRows(
        [...legacySnapshots, ...canonicalIssuedSnapshots],
        activeData.points,
      );
    },
    [activeData, activeIssuedBatch, activeScope?.period, forecastHistory],
  );
  const completedHistoryRows = useMemo(
    () => historyRows.filter((row) => row.actualClose !== null),
    [historyRows],
  );
  const visibleHistoryRows = useMemo(
    () =>
      selectLatestHistoryRevisionRows(
        completedHistoryRows.filter((row) => row.inputMaWindow === inputMaWindow),
      ),
    [completedHistoryRows, inputMaWindow],
  );
  const chartHistoryRows = useMemo(
    () => selectLatestChartForecastHistoryRows(visibleHistoryRows),
    [visibleHistoryRows],
  );
  const summary = useMemo(() => summarizeForecastHistory(visibleHistoryRows), [visibleHistoryRows]);
  const latest = activeData?.points.at(-1);
  const latestActualCloseContext = useMemo(
    () =>
      activeData
        ? getLatestActualCloseContext(activeData.points, baseDate)
        : null,
    [activeData, baseDate],
  );
  const unit = periods.find((item) => item.value === period)?.unit ?? '';
  const inputHorizonDates = useMemo(
    () => new Set(activeData ? generatePredictionRows(activeData.points, period, baseDate, inputMaWindow).map((row) => row.targetDate) : []),
    [activeData, baseDate, inputMaWindow, period],
  );
  const filledCount = predictions.filter(
    (row) =>
      inputHorizonDates.has(row.targetDate) &&
      getPredictionInputValue(row, inputMaWindow).trim() !== '',
  ).length;
  const predictionTableRows = useMemo(
    () => {
      const latestCompletedTargetDate = getLatestCompletedTargetDate(
        projection.rows,
        activeIssuedEvaluation?.rows ?? [],
      );
      const selectedProjectionRows = selectPredictionRowsForInputTable(
        projection.rows,
        inputHorizonDates,
        latestCompletedTargetDate
          ? new Set([latestCompletedTargetDate])
          : new Set<string>(),
      );
      return buildForecastCloseTableRows(
        selectedProjectionRows,
        activeIssuedEvaluation?.rows ?? [],
        chartHistoryRows,
        (targetDate) =>
          activeScope
            ? getIssuedForecastPeriodKey(activeScope.period, targetDate)
            : targetDate,
        latestActualCloseContext,
      );
    },
    [
      activeIssuedEvaluation,
      activeScope,
      chartHistoryRows,
      inputHorizonDates,
      latestActualCloseContext,
      projection.rows,
    ],
  );
  const updateButtonText =
    updateState.status === 'checking'
      ? '检查中'
      : updateState.status === 'available'
        ? `下载更新 ${updateState.latestVersion}`
        : '检查更新';
  const compactPredictionTableStyle = {
    gridTemplateColumns: '92px 94px 72px 100px 64px 44px',
    minWidth: '481px',
  };
  const expandedPredictionTableStyle = {
    gridTemplateColumns: `104px 102px 82px 116px 74px 50px repeat(${visibleMaWindows.length}, 68px)`,
    minWidth: `${548 + visibleMaWindows.length * 72}px`,
  };
  const detailRow = useMemo(
    () => projection.rows.find((row) => row.targetDate === detailTargetDate) ?? null,
    [detailTargetDate, projection.rows],
  );
  const detailIssuedRow = useMemo(
    () =>
      detailRow && activeScope
        ? issuedRowsByPeriod.get(getIssuedForecastPeriodKey(activeScope.period, detailRow.targetDate)) ?? null
        : null,
    [activeScope?.period, detailRow, issuedRowsByPeriod],
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
          label: `实时暂估MA${windowSize}`,
          color: lineColors[windowSize],
          rows: mergeLineValuePointsPreservingEarlier(
            chartHistoryRows.map((row) => ({
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
      chartHistoryRows,
      projection.actualLines,
      projection.predictedLines,
      showActualMaLines,
      visibleMaWindows,
    ],
  );
  const pointSeries = useMemo<ChartPointSeries[]>(
    () => {
      const closeRows = buildForecastCloseChartRows({
        historyRows: chartHistoryRows,
        issuedRows: activeIssuedEvaluation?.rows ?? [],
        projectionRows: projection.rows,
        actualCloseContexts: latestActualCloseContext
          ? [latestActualCloseContext]
          : [],
        getPeriodKey: (targetDate) =>
          activeScope
            ? getIssuedForecastPeriodKey(activeScope.period, targetDate)
            : targetDate,
      });

      return [
        ...(closeRows.locked.length
          ? [{
              label: '已提交预测收盘（锁定）',
              color: '#ffe600',
              borderColor: '#20251f',
              shadowColor: 'rgba(255, 230, 0, 0.55)',
              rows: closeRows.locked,
              symbol: 'diamond',
              symbolSize: 13,
              z: 120,
            } satisfies ChartPointSeries]
          : []),
        ...(closeRows.actual.length
          ? [{
              label: '真实收盘价（已收盘）',
              color: '#14745f',
              borderColor: '#f7f4ee',
              shadowColor: 'rgba(20, 116, 95, 0.5)',
              rows: closeRows.actual,
              symbol: 'pin',
              symbolSize: 14,
              z: 115,
            } satisfies ChartPointSeries]
          : []),
        ...(closeRows.provisional.length
          ? [{
              label: '实时暂估收盘（未收盘）',
              color: '#f4a340',
              borderColor: '#7a3f12',
              shadowColor: 'rgba(244, 163, 64, 0.5)',
              rows: closeRows.provisional,
              symbol: 'circle',
              symbolSize: 9,
              z: 110,
            } satisfies ChartPointSeries]
          : []),
      ];
    },
    [
      activeIssuedEvaluation,
      activeScope,
      chartHistoryRows,
      latestActualCloseContext,
      projection.rows,
    ],
  );

  function requestIssueCurrentForecast() {
    if (isResettingForecastScopeRef.current) return;
    if (!activeData || !activeScope || !baseDate || !cloudUser) {
      showToast('行情或云端账户尚未准备好，暂时不能提交预测', 'warning');
      return;
    }
    const issuableCount = projection.rows.filter(
      (row) =>
        row.isForecast &&
        row.derivedClose !== null &&
        row.calculation.reverse.predictedMa !== null &&
        row.calculation.reverse.previousSum !== null,
    ).length;
    if (!issuableCount) {
      showToast(`请先填写至少一条可计算的预测MA${inputMaWindow}`, 'warning');
      return;
    }

    setConfirmAction({
      title: `提交并锁定 MA${inputMaWindow} 预测`,
      body: `将按 ${baseDate} 收盘后的信息一次锁定 ${issuableCount} 条未来预测。以后行情刷新只更新真实值和有效MA，不会修改这些预测收盘价；再次提交会创建新版本。`,
      confirmLabel: `锁定 ${issuableCount} 条预测`,
      onConfirm: issueCurrentForecast,
    });
  }

  async function issueCurrentForecast() {
    if (
      !activeData || !activeScope || !baseDate || !cloudUser ||
      isIssuingForecast || isResettingForecastScopeRef.current
    ) return;
    const sessionGeneration = cloudSessionGenerationRef.current;
    setIsIssuingForecast(true);
    try {
      const issuedAt = new Date().toISOString();
      const revision = globalThis.crypto?.randomUUID?.() ??
        `revision-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const batch = createIssuedForecastBatch({
        stockCode: activeData.code,
        period: activeScope.period,
        inputMaWindow,
        revision,
        asOfDate: baseDate,
        issuedAt,
        points: activeData.points,
        predictions,
      });
      // The RPC writes the immutable batch and all v1 history bridge rows in a
      // single database transaction. Do not expose the lock in memory until
      // the server returns its authoritative ordering sequence.
      const savedBatch = await saveMyIssuedForecastBatchV2(batch);
      // The RPC is bound to the authenticated user that started it. If that
      // account signed out (or another account signed in) while it was in
      // flight, the cloud commit remains valid for the original account but
      // its response must never leak into the replacement UI session.
      if (sessionGeneration !== cloudSessionGenerationRef.current) return;
      const snapshots = issuedForecastBatchToHistorySnapshots(savedBatch);
      const currentWorkspace = cloudWorkspaceRef.current;
      if (!currentWorkspace) throw new Error('云端工作区尚未加载完成');
      const existing = getWorkspaceForecastHistory(currentWorkspace, activeScope);
      const merged = mergeForecastHistory(existing, snapshots);

      // Success updates only the in-memory projection of data already committed
      // by the RPC. Issued batches never enter localStorage/Electron or the
      // generic history outbox.
      updateCloudWorkspace((workspace) =>
        setWorkspaceForecastHistory(workspace, activeScope, merged),
      );
      setForecastHistory(merged);
      setIssuedForecastBatches((current) =>
        sortIssuedForecastBatches([
          ...current.filter((item) => item.id !== savedBatch.id),
          savedBatch,
        ]),
      );
      showToast(
        `已提交并锁定 MA${inputMaWindow}，云端序号 #${savedBatch.serverSequence}，共 ${savedBatch.rows.length} 条预测`,
        'success',
      );
    } catch (err) {
      if (sessionGeneration !== cloudSessionGenerationRef.current) return;
      showToast(err instanceof Error ? `提交预测失败：${err.message}` : '提交预测失败', 'warning');
    } finally {
      if (sessionGeneration === cloudSessionGenerationRef.current) setIsIssuingForecast(false);
    }
  }

  function persistPredictionDraft(rows: PredictionPoint[]) {
    if (isResettingForecastScopeRef.current) return;
    if (!activeData || !activeScope || !baseDate || !rows.length) return;
    const scope = activeScope;
    const current = cloudWorkspaceRef.current;
    const beforeRows = current ? getWorkspacePredictions(current, scope) : [];
    const mutations = createPredictionValueMutations(scope, beforeRows, rows);
    updateCloudWorkspace((workspace) => ({
      ...setWorkspacePredictions(workspace, scope, rows),
      workspace: { stockCode: scope.stockCode, period: scope.period, baseDate },
    }));
    cloudPredictionSaveQueueRef.current?.schedule(mutations);
    void saveMyWorkspacePreferences(scope.stockCode, scope.period, baseDate).catch((error: unknown) => {
      showToast(error instanceof Error ? `界面设置保存失败：${error.message}` : '界面设置保存失败', 'warning');
    });
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
  function activateStockCode(code: string) {
    const normalizedCode = normalizeStockCode(code);
    if (normalizedCode.length !== 6) return false;

    const currentCode = normalizeStockCode(queryCode);
    selectedMarketScopeRef.current = { stockCode: normalizedCode, period };
    setStockCode(normalizedCode);
    if (normalizedCode === currentCode) return false;

    setData(null);
    setDataPeriod(null);
    setPredictions([]);
    setPredictionScope(null);
    setForecastHistory([]);
    setDetailTargetDate(null);
    setHasUnsavedChanges(false);
    setError('');
    setQueryCode(normalizedCode);
    return true;
  }

  function selectCloudStockCode(code: string) {
    if (!code) return;
    void queryStockCode(code);
  }

  async function queryStockCode(code = stockCode) {
    if (isResettingForecastScopeRef.current) return;
    const queryGeneration = ++stockQueryGenerationRef.current;
    const requestedStockCode = normalizeStockCode(code);
    if (requestedStockCode.length !== 6) {
      setError('股票代码需要是6位数字');
      return;
    }

    const scopeChanged = activateStockCode(requestedStockCode);
    let registryError: unknown = null;
    if (cloudUser) {
      try {
        const canonicalStockCodes = await rememberMyStockCode(requestedStockCode);
        setCloudStockCodes(canonicalStockCodes);
      } catch (err) {
        registryError = err;
      }
    }

    const result = await refreshHistoricalData({
      targetStockCode: requestedStockCode,
      targetPeriod: period,
      skipCurrentCapture: scopeChanged,
      trigger: 'manual',
    });
    if (!result.successfulPeriods.length || !cloudUser) {
      if (registryError) {
        showToast(
          registryError instanceof Error
            ? `股票列表保存失败：${registryError.message}`
            : '股票列表保存失败，请稍后重试',
          'warning',
        );
      }
      return;
    }

    // A slower earlier query may finish after the user has already selected
    // another stock. It must never replace the latest workspace preference.
    if (queryGeneration !== stockQueryGenerationRef.current) return;

    const selectedBaseDate = result.lastCompletedDates[period] ?? baseDate;
    updateCloudWorkspace((workspace) => ({
      ...workspace,
      workspace: {
        stockCode: requestedStockCode,
        period,
        baseDate: selectedBaseDate,
      },
      updatedAt: new Date().toISOString(),
    }));
    let preferenceError: unknown = null;
    try {
      await saveMyWorkspacePreferences(requestedStockCode, period, selectedBaseDate);
    } catch (err) {
      preferenceError = err;
    }
    if (registryError) {
      try {
        const canonicalStockCodes = await rememberMyStockCode(requestedStockCode);
        setCloudStockCodes(canonicalStockCodes);
        registryError = null;
      } catch (err) {
        registryError = err;
      }
    }

    const failedDatabaseWrites = [
      preferenceError,
      registryError,
    ].filter((reason) => reason !== null);
    if (failedDatabaseWrites.length) {
      const firstError = failedDatabaseWrites[0];
      showToast(
        firstError instanceof Error
          ? `数据库保存失败：${firstError.message}`
          : '数据库保存失败，请稍后重试',
        'warning',
      );
    }
  }

  function selectKLinePeriod(nextPeriod: PeriodType) {
    if (isResettingForecastScopeRef.current) return;
    if (nextPeriod === period) return;
    // 命中缓存时同步水合，避免图表先卸载再重建（339 行 effect 会幂等重放同样的数据）。
    const cached = marketDataRef.current.get(marketScopeKey(queryCode, nextPeriod));
    if (cached) {
      const completed = filterCompletedKLineData(cached, nextPeriod);
      setData(completed.data);
      setDataPeriod(nextPeriod);
      setBaseDate(completed.lastCompletedDate ?? todayDate);
    } else {
      setData(null);
      setDataPeriod(null);
    }
    setPredictions([]);
    setPredictionScope(null);
    setForecastHistory([]);
    setDetailTargetDate(null);
    setHasUnsavedChanges(false);
    setError('');
    setPeriod(nextPeriod);
  }

  async function readCloudPredictions(user = cloudUser) {
    if (isResettingForecastScopeRef.current) return;
    if (!user) {
      setIsCloudAccountOpen(true);
      return;
    }
    await loadCloudWorkspace(user);
  }

  async function saveCurrentWorkspaceToCloud() {
    if (isResettingForecastScopeRef.current) return;
    if (!cloudUser || !cloudWorkspaceRef.current) {
      setIsCloudAccountOpen(true);
      showToast('请先登录云端账户，再保存预测数据', 'warning');
      return;
    }

    saveCurrentWorkspace({ force: true, notice: 'silent' });
    setCloudSyncState('syncing');
    try {
      await cloudPredictionSaveQueueRef.current?.flush();
      const predictionSaveError = cloudPredictionSaveQueueRef.current?.getLastError();
      if (predictionSaveError) throw predictionSaveError;
      await cloudHistorySaveQueueRef.current?.flush();
      const historySaveError = cloudHistorySaveQueueRef.current?.getLastError();
      if (historySaveError) throw historySaveError;
      const workspace = cloudWorkspaceRef.current;
      if (!workspace) throw new Error('云端工作区尚未加载完成');
      await saveMyWorkspacePreferences(
        workspace.workspace.stockCode,
        workspace.workspace.period,
        workspace.workspace.baseDate,
      );
      const verifiedRecord = await loadMyCloudWorkspace();
      if (!verifiedRecord) throw new Error('云端保存后无法读取工作区');
      assertCloudWorkspaceContainsLocalData(workspace, verifiedRecord.payload);
      cloudPredictionSaveQueueRef.current?.markAllSaved();
      cloudHistorySaveQueueRef.current?.markAllSaved();
      cloudWorkspaceBaselineRef.current = verifiedRecord.payload;
      setCloudSyncState('ready');
      const predictionScopes = Object.keys(workspace.predictions).length;
      const historyCount = Object.values(workspace.forecastHistory).reduce(
        (total, rows) => total + rows.length,
        0,
      );
      showToast(`已保存到云端并校验通过：${predictionScopes} 组预测、${historyCount} 条历史记录`, 'success');
    } catch (err) {
      setCloudSyncState('error');
      showToast(err instanceof Error ? `向云端保存失败：${err.message}` : '向云端保存失败', 'warning');
    }
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
      showToast(translateCloudError(err), 'warning');
    }
  }

  async function signOutCloudAccount() {
    if (isResettingForecastScopeRef.current) return;
    try {
      await signOutOfCloud();
      cloudSessionGenerationRef.current += 1;
      cloudPredictionSaveQueueRef.current?.switchAccount('');
      cloudHistorySaveQueueRef.current?.switchAccount('');
      cloudWorkspaceRef.current = null;
      cloudWorkspaceBaselineRef.current = null;
      setCloudUser(null);
      setCloudWorkspace(null);
      setCloudWorkspaceRevision(0);
      setCloudRole(null);
      setCloudStockCodes([]);
      setPredictions([]);
      setPredictionScope(null);
      setForecastHistory([]);
      setIssuedForecastBatches([]);
      setIsIssuingForecast(false);
      setData(null);
      setDataPeriod(null);
      setBaseDate(todayDate);
      setError('');
      setHasUnsavedChanges(false);
      setCloudEmail('');
      setCloudPassword('');
      marketDataRef.current.clear();
      setCloudPredictionSaveState({ status: 'idle', pendingCount: 0, lastSavedAt: null, error: null });
      setCloudHistorySaveState({ status: 'idle', pendingCount: 0, lastSavedAt: null, error: null });
      setCloudSyncState('signed-out');
      setIsCloudAccountOpen(false);
      showToast('已退出云端账户；已提交并锁定的预测未保存在本机。', 'info');
    } catch (err) {
      showToast(err instanceof Error ? `退出云端账户失败：${err.message}` : '退出云端账户失败', 'warning');
    }
  }

  function updatePrediction(targetDate: string, value: string) {
    if (isResettingForecastScopeRef.current) return;
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
    // 低级别提示（如自动刷新进度）不得顶掉正在显示的警告。
    const current = toastRef.current;
    if (current && TOAST_PRIORITY[current.type] > TOAST_PRIORITY[type]) return;
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }

    toastRef.current = { message, type };
    setToast(toastRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      toastRef.current = null;
      setToast(null);
      toastTimerRef.current = null;
    }, TOAST_DURATION[type]);
  }

  function closeToast() {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }

    toastRef.current = null;
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
        throw new Error(`检查更新失败（HTTP ${response.status}）`);
      }

      const manifest = normalizeUpdateManifest(await response.json());
      if (!manifest) {
        throw new Error('更新信息格式异常，请稍后重试');
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

  async function refreshHistoricalData(options: {
    targetStockCode?: string;
    targetPeriod?: PeriodType;
    skipCurrentCapture?: boolean;
    trigger?: 'manual' | 'startup' | AStockRefreshPhase;
  } = {}): Promise<MarketRefreshResult> {
    const requestedStockCode = normalizeStockCode(options.targetStockCode ?? stockCode);
    const requestKey = `${requestedStockCode}:${options.trigger ?? 'manual'}`;
    const inFlight = marketRefreshInFlightRef.current;
    if (inFlight) {
      if (inFlight.requestKey === requestKey) return inFlight.promise;
      await inFlight.promise;
      return refreshHistoricalData(options);
    }

    const task = performHistoricalDataRefresh(options);
    marketRefreshInFlightRef.current = { requestKey, promise: task };
    try {
      return await task;
    } finally {
      if (marketRefreshInFlightRef.current?.promise === task) {
        marketRefreshInFlightRef.current = null;
      }
    }
  }

  async function performHistoricalDataRefresh({
    targetStockCode = stockCode,
    targetPeriod = period,
    skipCurrentCapture = false,
    trigger = 'manual',
  }: {
    targetStockCode?: string;
    targetPeriod?: PeriodType;
    skipCurrentCapture?: boolean;
    trigger?: 'manual' | 'startup' | AStockRefreshPhase;
  } = {}): Promise<MarketRefreshResult> {
    const requestedStockCode = normalizeStockCode(targetStockCode);
    // Issued forecasts are immutable and already persisted at submission time.
    // A market refresh must never rebuild or overwrite them.
    void skipCurrentCapture;
    setIsLoading(true);
    setError('');
    const refreshMessage =
      trigger === 'open'
        ? 'A股开盘，正在自动更新日K、周K、月K...'
        : trigger === 'close'
          ? 'A股收盘，正在自动更新日K、周K、月K...'
          : '正在联网更新日K、周K、月K历史收盘价...';
    showToast(refreshMessage, 'info');

    try {
      const results = await refreshAllKLinePeriods((workspacePeriod) =>
        fetchKLines(requestedStockCode, workspacePeriod, {
          referenceData: marketDataRef.current.get(marketScopeKey(requestedStockCode, workspacePeriod)),
        }),
      );
      const successful = results.flatMap((result) => {
        if (result.status !== 'success') return [];
        const completed = filterCompletedKLineData(markAsOnlineResult(result.data), result.period);
        marketDataRef.current.set(marketScopeKey(completed.data.code, result.period), completed.data);
        return [{ period: result.period, completed }];
      });
      const active = successful.find((result) => result.period === targetPeriod);
      const failed = results.filter((result) => result.status === 'failed');

      const selectedScope = selectedMarketScopeRef.current;
      if (
        active &&
        selectedScope.stockCode === requestedStockCode &&
        selectedScope.period === targetPeriod
      ) {
        setData(active.completed.data);
        setDataPeriod(targetPeriod);
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

      return {
        successfulPeriods: successful.map(({ period: successfulPeriod }) => successfulPeriod),
        failedPeriods: failed.map(({ period: failedPeriod }) => failedPeriod),
        lastCompletedDates: Object.fromEntries(
          successful.map(({ period: successfulPeriod, completed }) => [
            successfulPeriod,
            completed.lastCompletedDate,
          ]),
        ),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : '联网更新失败';
      setError(`联网更新异常：${message}`);
      showToast('联网更新异常，继续使用本地缓存', 'warning');
      return {
        successfulPeriods: [],
        failedPeriods: [...ALL_KLINE_PERIODS],
        lastCompletedDates: {},
      };
    } finally {
      setIsLoading(false);
    }
  }

  function updateNote(value: string) {
    if (isResettingForecastScopeRef.current) return;
    const nextRows = predictions.map((row) => ({ ...row, note: value }));
    setPredictions(nextRows);
    persistPredictionDraft(nextRows);
  }

  function resetRows() {
    if (!activeData || !activeScope || !baseDate || isResettingForecastScopeRef.current) return;
    if (!cloudUser) {
      setIsCloudAccountOpen(true);
      showToast('请先登录云端账户，再清除预测数据', 'warning');
      return;
    }
    if (isIssuingForecast) {
      showToast('预测正在云端锁定，请完成后再重置', 'warning');
      return;
    }
    // Android WebView 的 window.confirm 可能恒返回 false，必须用应用内确认弹窗。
    setConfirmAction({
      title: '全部清除当前预测',
      body: `确认永久清除 ${activeData.code} 的当前${getPeriodLabel(activeScope.period)}全部预测数据吗？草稿、历史对比以及所有 MA 的已提交锁定版本都会从云端删除；真实行情 K 线和其他周期保留。`,
      confirmLabel: '永久清除',
      onConfirm: () => void doResetRows(),
    });
  }

  async function doResetRows() {
    if (
      !activeData || !activeScope || !baseDate || !cloudUser ||
      isIssuingForecast || isResettingForecastScopeRef.current
    ) return;

    const resetUser = cloudUser;
    const resetScope = {
      stockCode: normalizeStockCode(activeData.code),
      period: activeScope.period,
    } satisfies CloudWorkspaceScope;
    const resetBaseDate = baseDate;
    const resetPoints = activeData.points;
    const sessionGeneration = cloudSessionGenerationRef.current;
    isResettingForecastScopeRef.current = true;
    setIsResettingForecastScope(true);

    try {
      await Promise.all([
        cloudPredictionSaveQueueRef.current?.flush(),
        cloudHistorySaveQueueRef.current?.flush(),
      ]);
      const predictionSaveError = cloudPredictionSaveQueueRef.current?.getLastError();
      const historySaveError = cloudHistorySaveQueueRef.current?.getLastError();
      if (predictionSaveError) throw predictionSaveError;
      if (historySaveError) throw historySaveError;
      if (sessionGeneration !== cloudSessionGenerationRef.current) return;

      const deleted = await resetMyForecastScopeV1(
        resetScope.stockCode,
        resetScope.period,
        resetUser.id,
      );
      if (sessionGeneration !== cloudSessionGenerationRef.current) return;

      cloudPredictionSaveQueueRef.current?.markAllSaved();
      cloudHistorySaveQueueRef.current?.markAllSaved();
      const currentWorkspace = cloudWorkspaceRef.current;
      if (currentWorkspace) {
        const nextWorkspace = clearWorkspaceForecastScope(currentWorkspace, resetScope);
        cloudWorkspaceRef.current = nextWorkspace;
        setCloudWorkspace(nextWorkspace);
      }
      if (cloudWorkspaceBaselineRef.current) {
        cloudWorkspaceBaselineRef.current = clearWorkspaceForecastScope(
          cloudWorkspaceBaselineRef.current,
          resetScope,
        );
      }
      setIssuedForecastBatches((current) =>
        current.filter(
          (batch) => batch.stockCode !== resetScope.stockCode || batch.period !== resetScope.period,
        ),
      );

      const selectedScope = selectedMarketScopeRef.current;
      if (
        selectedScope.stockCode === resetScope.stockCode &&
        selectedScope.period === resetScope.period
      ) {
        setShowActualMaLines(true);
        setPredictions(
          generatePredictionRows(resetPoints, resetScope.period, resetBaseDate, forecastRowCount),
        );
        setPredictionScope(resetScope);
        setForecastHistory([]);
        setIsHistoryModalOpen(false);
        setDetailTargetDate(null);
        setHasUnsavedChanges(false);
      }

      showToast(
        `已清除当前${getPeriodLabel(resetScope.period)}全部预测：` +
          `草稿值 ${deleted.predictionValuesDeleted}、历史 ${deleted.forecastHistoryDeleted}、` +
          `锁定版本 ${deleted.issuedBatchesDeleted}；真实行情已保留`,
        'success',
      );
    } catch (err) {
      if (sessionGeneration !== cloudSessionGenerationRef.current) return;
      showToast(
        err instanceof Error ? `全部清除失败：${err.message}` : '全部清除失败',
        'warning',
      );
    } finally {
      isResettingForecastScopeRef.current = false;
      setIsResettingForecastScope(false);
    }
  }

  function exportAllData() {
    saveCurrentWorkspace({ force: true, notice: 'silent' });
    const workspace = cloudWorkspaceRef.current;
    if (!workspace) {
      showToast('云端数据尚未加载，无法导出', 'warning');
      return;
    }
    const backup = createFullWorkspaceBackup(workspace, appVersion);
    const blob = new Blob([JSON.stringify(backup, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `gupiao-full-prediction-backup-${formatDate(new Date())}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    const predictionScopes = Object.keys(workspace.predictions).length;
    const historyCount = Object.values(workspace.forecastHistory).reduce(
      (total, rows) => total + rows.length,
      0,
    );
    showToast(`已导出全部数据：${predictionScopes} 组预测、${historyCount} 条历史记录`, 'success');
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

    // 只解析并确认；真正覆盖云端在 applyImportedWorkspace 里执行，
    // 避免误选文件时零确认覆盖且不可撤销。
    try {
      const rawFile = JSON.parse(await file.text()) as unknown;
      let workspace: CloudWorkspace;
      try {
        workspace = readFullWorkspaceImport(rawFile);
      } catch {
        workspace = createCloudWorkspaceFromLegacyBackup(rawFile);
      }
      if (!cloudUser) throw new Error('请先登录云端账户，再导入数据');
      const predictionScopes = Object.keys(workspace.predictions).length;
      const historyCount = Object.values(workspace.forecastHistory).reduce(
        (total, rows) => total + rows.length,
        0,
      );
      setConfirmAction({
        title: '导入并覆盖云端',
        body: `文件包含 ${predictionScopes} 组预测、${historyCount} 条历史记录。导入会完全覆盖云端现有数据，无法撤销。建议先点“导出”备份。`,
        confirmLabel: '覆盖云端',
        onConfirm: () => void applyImportedWorkspace(workspace),
      });
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导入失败', 'warning');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function applyImportedWorkspace(workspace: CloudWorkspace) {
    if (!cloudUser) return;

    let predictionQueueDetached = false;
    try {
      await cloudPredictionSaveQueueRef.current?.flush();
      await cloudHistorySaveQueueRef.current?.flush();
      cloudPredictionSaveQueueRef.current?.switchAccount('');
      cloudHistorySaveQueueRef.current?.switchAccount('');
      predictionQueueDetached = true;
      await replaceMyCloudWorkspace(workspace);
      saveCloudPredictionOutbox(cloudUser.id, {
        mutations: [],
        lastSavedAt: new Date().toISOString(),
      });
      saveCloudHistoryOutbox(cloudUser.id, {
        snapshots: [],
        lastSavedAt: new Date().toISOString(),
      });
      await loadCloudWorkspace(cloudUser);
      predictionQueueDetached = false;
      const predictionScopes = Object.keys(workspace.predictions).length;
      const historyCount = Object.values(workspace.forecastHistory).reduce(
        (total, rows) => total + rows.length,
        0,
      );
      showToast(`已导入并覆盖云端：${predictionScopes} 组预测、${historyCount} 条历史记录`, 'success');
    } catch (err) {
      if (predictionQueueDetached && cloudUser) {
        cloudPredictionSaveQueueRef.current = createPredictionSaveQueueForUser(
          cloudUser,
          loadCloudPredictionOutbox(cloudUser.id),
        );
        cloudHistorySaveQueueRef.current = createHistorySaveQueueForUser(
          cloudUser,
          loadCloudHistoryOutbox(cloudUser.id),
        );
      }
      showToast(err instanceof Error ? err.message : '导入失败', 'warning');
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
    const predictionTableStyle = expanded
      ? expandedPredictionTableStyle
      : compactPredictionTableStyle;

    return (
      <div
        className={`prediction-table ma40-table ${expanded ? 'expanded-table' : 'compact-table'}`}
        role="table"
        aria-label={`预测MA${inputMaWindow}输入表`}
      >
        <div className="prediction-row table-head" style={predictionTableStyle} role="row">
          <span className="date-column" role="columnheader">目标周期</span>
          <span className="input-column" role="columnheader">预测MA{inputMaWindow}</span>
          <span className="num-cell" role="columnheader">锁定预测</span>
          <span className="status-column" role="columnheader">收盘状态</span>
          <span className="num-cell" role="columnheader">有效MA</span>
          <span className="action-column" role="columnheader">明细</span>
          {expanded
            ? visibleMaWindows.map((windowSize) => (
                <span className="num-cell" key={windowSize} role="columnheader">MA{windowSize}</span>
              ))
            : null}
        </div>
        {predictionTableRows.map(({
          targetDate,
          row,
          issuedRow,
          historyRow,
          actualCloseContext,
        }) => {
          const rowInputValue = row
            ? getPredictionInputValue(row, inputMaWindow)
            : '';
          const inputValue = rowInputValue.trim() !== ''
            ? rowInputValue
            : formatNumber(
                issuedRow?.inputMaValue ??
                historyRow?.inputMaValue ??
                null,
                4,
              );
          const isFilled = inputValue !== '' && inputValue !== '--';
          const recordedClose =
            issuedRow?.predictedClose ??
            historyRow?.predictedClose ??
            null;
          const closeCell = getForecastCloseCell(
            row,
            issuedRow,
            historyRow,
            actualCloseContext,
          );
          const isSettled = closeCell.kind === 'actual';
          return (
              <div
                className={`prediction-row ${isFilled ? 'row-filled' : 'row-empty'} ${issuedRow || historyRow ? 'row-locked' : ''} ${isSettled ? 'row-settled' : ''}`}
                key={`${actualCloseContext ? 'actual-context' : 'forecast'}:${targetDate}`}
                style={predictionTableStyle}
                role="row"
            >
              <span className="date-cell" role="cell">{targetDate}</span>
              <div className="prediction-input-cell" role="cell">
                {row ? (
                  <input
                    className="prediction-input forecast-ma40-input"
                    aria-label={`${targetDate} 预测MA${inputMaWindow}`}
                    type="text"
                    inputMode="decimal"
                    disabled={isResettingForecastScope || isSettled}
                    value={inputValue}
                    onChange={(event) => updatePrediction(targetDate, event.target.value)}
                    onBlur={() => formatPredictionInput(targetDate)}
                    onFocus={(event) => event.currentTarget.select()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === 'ArrowDown') {
                        event.preventDefault();
                        movePredictionFocus(event.currentTarget, 1);
                      } else if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        movePredictionFocus(event.currentTarget, -1);
                      }
                    }}
                    placeholder="0.0000"
                  />
                ) : (
                  <span
                    className="settled-ma-value"
                    role="status"
                    aria-label={
                      issuedRow
                        ? `${targetDate} 已锁定预测MA${inputMaWindow}`
                        : historyRow
                          ? `${targetDate} 历史预测MA${inputMaWindow}`
                        : `${targetDate} 无预测MA${inputMaWindow}记录`
                    }
                  >
                    {inputValue}
                  </span>
                )}
              </div>
              <strong className="locked-close-cell" role="cell">
                {formatNumber(recordedClose)}
                {issuedRow ? (
                  <small aria-label="已锁定">锁</small>
                ) : historyRow ? (
                  <small aria-label="历史预测记录">历</small>
                ) : null}
              </strong>
              <span
                className={`close-status-cell ${closeCell.kind}`}
                role="cell"
                aria-label={`${closeCell.label} ${formatNumber(closeCell.value)}`}
              >
                <small>{closeCell.label}</small>
                <strong>{formatNumber(closeCell.value)}</strong>
              </span>
              <span className="effective-ma-cell num-cell" role="cell">
                {formatNumber(
                  issuedRow?.currentImpliedMa ??
                  historyRow?.actualMaValues[inputMaWindow] ??
                  null,
                  4,
                )}
              </span>
              <span className="detail-cell" role="cell">
                {row ? (
                  <button
                    type="button"
                    className="detail-button"
                    tabIndex={-1}
                    onClick={() => setDetailTargetDate(targetDate)}
                  >
                    明细
                  </button>
                ) : '--'}
              </span>
              {expanded
                ? visibleMaWindows.map((windowSize) => (
                    <span className="num-cell" key={windowSize} role="cell">
                      {formatNumber(
                        row?.maValues[windowSize] ??
                        issuedRow?.predictedMaValues[windowSize] ??
                        historyRow?.predictedMaValues[windowSize] ??
                        null,
                      )}
                    </span>
                  ))
                : null}
            </div>
          );
        })}
      </div>
    );
  }

  if (!isCloudSyncConfigured()) {
    return (
      <main className="app-shell">
        <div className="error-banner" role="alert">云端服务未配置，请使用正式打包版本，或联系管理员。</div>
      </main>
    );
  }

  if (!cloudUser || isCloudWorkspaceLoading || !cloudWorkspace) {
    return (
      <main className="app-shell">
        <div className="loading">
          {isCloudWorkspaceLoading ? '正在加载云端数据…' : '请先登录云端账户'}
        </div>
        <CloudAccountModal
          email={cloudEmail}
          password={cloudPassword}
          cloudUser={cloudUser}
          isBusy={cloudSyncState === 'syncing'}
          dismissible={false}
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
      <div className="sr-only" role="status" aria-live="polite">
        {toast && toast.type !== 'warning' ? toast.message : ''}
      </div>
      <div className="sr-only" role="alert">{toast?.type === 'warning' ? toast.message : ''}</div>
      {toast ? (
        <div className={`top-toast ${toast.type}`}>
          <span>{toast.message}</span>
          <button type="button" onClick={closeToast} aria-label="关闭提示">
            关闭
          </button>
        </div>
      ) : null}

      <section className="topbar">
        <div>
          <p className="eyebrow">MA{inputMaWindow} 预测工作台</p>
          <h1>人工预测 MA{inputMaWindow} 走势</h1>
        </div>
        <div className="stock-search">
          <label htmlFor="stockCode">股票</label>
          <div className="stock-search-box">
            <input
              id="stockCode"
              disabled={isResettingForecastScope}
              value={stockCode}
              enterKeyHint="go"
              maxLength={20}
              placeholder="代码 / 名称 / 拼音"
              autoComplete="off"
              role="combobox"
              aria-expanded={searchCandidates.length > 0}
              aria-autocomplete="list"
              aria-controls="stock-suggest-list"
              onChange={(event) => handleStockInputChange(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={() => window.setTimeout(closeStockSearch, 150)}
              onKeyDown={(event) => {
                if (searchCandidates.length) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setSearchActiveIndex((index) => (index + 1) % searchCandidates.length);
                    return;
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setSearchActiveIndex(
                      (index) => (index - 1 + searchCandidates.length) % searchCandidates.length,
                    );
                    return;
                  }
                  if (event.key === 'Escape') {
                    closeStockSearch();
                    return;
                  }
                }
                if (event.key !== 'Enter') return;
                event.preventDefault();
                const trimmed = stockCode.trim();
                if (/^\d{6}$/.test(trimmed)) {
                  closeStockSearch();
                  void queryStockCode();
                  return;
                }
                if (searchCandidates.length) {
                  selectSearchCandidate(searchCandidates[searchActiveIndex] ?? searchCandidates[0]);
                } else if (trimmed.length >= 2) {
                  void runStockSearch(trimmed, true);
                }
              }}
            />
            {searchCandidates.length ? (
              <ul className="stock-suggest" id="stock-suggest-list" role="listbox" aria-label="股票搜索候选">
                {searchCandidates.map((candidate, index) => (
                  <li
                    key={candidate.code}
                    role="option"
                    aria-selected={index === searchActiveIndex}
                    className={index === searchActiveIndex ? 'active' : ''}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectSearchCandidate(candidate)}
                    onMouseEnter={() => setSearchActiveIndex(index)}
                  >
                    <b>{candidate.code}</b>
                    <span>{candidate.name}</span>
                    <small>{candidate.typeName}</small>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <select
            aria-label="云端预测股票代码"
            disabled={!cloudStockCodes.length || isResettingForecastScope}
            value={cloudStockCodes.includes(stockCode) ? stockCode : ''}
            onChange={(event) => selectCloudStockCode(event.target.value)}
          >
            <option value="" disabled>
              {cloudStockCodes.length ? '云端股票' : '暂无云端股票'}
            </option>
            {cloudStockCodes.map((code) => (
              <option key={code} value={code}>
                {stockNames[code] ? `${code} ${stockNames[code]}` : code}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void queryStockCode()} disabled={isLoading || isResettingForecastScope}>
            {isLoading ? '更新中' : '联网更新'}
          </button>
          <button
            type="button"
            className="secondary-action"
            onClick={updateState.status === 'available' ? openUpdateDownload : () => checkAppUpdate()}
            disabled={updateState.status === 'checking'}
          >
            {updateButtonText}
          </button>
          <button
            type="button"
            className="cloud-account-button"
            data-testid="cloud-account-button"
            onClick={() => setIsCloudAccountOpen(true)}
            disabled={isResettingForecastScope}
            title={cloudUser ? `当前账户：${cloudUser.email ?? '云端账户'}。可在此退出或切换账户。` : '登录或切换云端账户'}
          >
            {cloudUser ? '云端账户' : '登录云端'}
          </button>
          <button
            type="button"
            className={`cloud-sync-button ${cloudSyncState}`}
            onClick={() => (cloudUser ? void readCloudPredictions() : setIsCloudAccountOpen(true))}
            disabled={
              cloudSyncState === 'syncing' || cloudSyncState === 'unconfigured' ||
              isResettingForecastScope
            }
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
        <div className="segmented" role="group" aria-label="K线周期选择">
          {periods.map((item) => (
            <button
              key={item.value}
              type="button"
              className={period === item.value ? 'active' : ''}
              aria-pressed={period === item.value}
              onClick={() => selectKLinePeriod(item.value)}
              disabled={isResettingForecastScope}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="horizon-display ma-display" role="group" aria-label="图表均线显示选择">
          <span className="group-label" aria-hidden="true">图表均线</span>
          {MA_WINDOWS.map((windowSize) => {
            const selected = visibleMaWindows.includes(windowSize);

            return (
              <button
                key={windowSize}
                type="button"
                className={`horizon-${windowSize} ${selected ? 'selected' : 'muted'}`}
                aria-pressed={selected}
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
          aria-pressed={showActualMaLines}
          onClick={() => setShowActualMaLines((current) => !current)}
        >
          {showActualMaLines ? '只看预测线' : '显示真实K线'}
        </button>

      </section>

      {error ? <div className="error-banner" role="alert">{error}</div> : null}

      <section className="market-strip">
        <Metric label="股票" value={activeData ? `${activeData.name} ${activeData.code}` : `${queryCode}`} />
        <Metric label="数据源" value={activeData?.sourceName ?? '--'} />
        <Metric label="最新周期" value={latest?.date ?? '--'} />
        <Metric label="历史数量" value={activeData ? `${activeData.points.length}` : '--'} />
        <Metric label="预测窗口" value={`${inputMaWindow}${unit}`} />
        <Metric label="已填写" value={`${filledCount}/${inputHorizonDates.size || inputMaWindow}`} />
        <Metric label="可对比" value={`${summary.compared}`} />
        <Metric label="MAE" value={summary.mae === null ? '--' : summary.mae.toFixed(2)} />
        <Metric label="MAPE" value={summary.mape === null ? '--' : `${summary.mape.toFixed(2)}%`} />
      </section>

      <section className="workspace">
        <div className="chart-panel">
          {isLoading ? (
            <div className="loading">正在加载K线数据...</div>
          ) : activeData && activeScope ? (
            <KLineChart
              stockCode={activeData.code}
              points={activeData.points}
              lineSeries={lineSeries}
              pointSeries={pointSeries}
              forecastDates={forecastDates}
              baseDate={baseDate}
              period={activeScope.period}
              persistedViewport={persistedChartViewport}
              onViewportChange={(viewport: ChartViewport) => {
                saveChartViewport(activeData.code, activeScope.period, viewport);
              }}
              showActualKLine={showActualMaLines}
              showCloseLine={false}
              showVolume={showActualMaLines}
            />
          ) : (
            <div className="loading">
              <div className="empty-state">
                <span>尚未获取 {queryCode || '该股票'} 的{getPeriodLabel(period)}行情数据</span>
                <button type="button" className="ghost" onClick={() => void queryStockCode()} disabled={isLoading}>
                  立即联网更新
                </button>
              </div>
            </div>
          )}
          {activeData && activeScope && !isLoading ? (
            <div className="chart-hint" aria-hidden="true">
              滚轮缩放 · 拖动平移 · 点图后 ↑↓ 缩放 ←→ 平移
            </div>
          ) : null}
        </div>

        <aside className="input-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">手动填写均线</p>
              <h2>预测MA{inputMaWindow}</h2>
            </div>
            <div className="panel-actions">
              <button
                type="button"
                className="ghost primary-save"
                onClick={requestIssueCurrentForecast}
                disabled={isIssuingForecast || isResettingForecastScope}
              >
                {isIssuingForecast ? '正在云端锁定…' : '提交并锁定'}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => void saveCurrentWorkspaceToCloud()}
                disabled={isResettingForecastScope}
              >
                保存草稿
              </button>
              {cloudUser ? (
                <div
                  className={`cloud-save-indicator ${cloudSaveState.status}`}
                  title={cloudSaveState.status === 'error' ? formatCloudSaveError(cloudSaveState.error) : undefined}
                  role="status"
                  aria-live="polite"
                >
                  <span className="cloud-save-status-dot" aria-hidden="true" />
                  <span>{formatCloudSaveState(cloudSaveState)}</span>
                  {cloudSaveState.status === 'error' ? (
                    <button
                      type="button"
                      className="cloud-save-retry"
                      onClick={() => {
                        cloudPredictionSaveQueueRef.current?.retry();
                        cloudHistorySaveQueueRef.current?.retry();
                      }}
                    >
                      重试
                    </button>
                  ) : null}
                </div>
              ) : null}
              <span className="action-divider" aria-hidden="true" />
              <button type="button" className="ghost" onClick={exportAllData}>
                导出
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => fileInputRef.current?.click()}
                disabled={isResettingForecastScope}
              >
                导入
              </button>
              <button
                type="button"
                className="ghost danger"
                onClick={resetRows}
                disabled={isResettingForecastScope || isIssuingForecast}
              >
                {isResettingForecastScope ? '清除中…' : '重置'}
              </button>
              <span className="action-divider" aria-hidden="true" />
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

          {cloudUser && cloudSaveState.status === 'error' ? (
            <div className="save-error-banner">
              <span>{formatCloudSaveError(cloudSaveState.error)}</span>
              <button
                type="button"
                onClick={() => {
                  cloudPredictionSaveQueueRef.current?.retry();
                  cloudHistorySaveQueueRef.current?.retry();
                }}
              >
                重试保存
              </button>
            </div>
          ) : null}

          <div className="input-mode-strip" role="group" aria-label="预测输入均线选择">
            <span>预测输入</span>
            {MA_WINDOWS.map((windowSize) => (
              <button
                key={windowSize}
                type="button"
                className={inputMaWindow === windowSize ? 'active' : ''}
                aria-pressed={inputMaWindow === windowSize}
                onClick={() => setInputMaWindow(windowSize)}
                disabled={isResettingForecastScope}
              >
                MA{windowSize}
              </button>
            ))}
          </div>

          <div className={`forecast-lock-strip ${activeIssuedBatch ? 'locked' : 'draft'}`} role="status">
            <strong>{activeIssuedBatch ? `MA${inputMaWindow} 已提交锁定` : `MA${inputMaWindow} 尚未提交`}</strong>
            <span>
              {activeIssuedBatch
                ? `基准 ${activeIssuedBatch.asOfDate} · ${activeIssuedBatch.rows.length} 条 · 行情刷新不会改写预测收盘`
                : '当前显示的是实时暂估，收盘或历史数据变化后会重新计算'}
            </span>
          </div>

          {renderPredictionTable()}

          <label className="note-field">
            <span>备注</span>
            <textarea
              value={predictions[0]?.note ?? ''}
              onChange={(event) => updateNote(event.target.value)}
              disabled={isResettingForecastScope}
              placeholder={`例如：MA${inputMaWindow}目标、趋势判断、压力位...`}
            />
          </label>
        </aside>
      </section>

      {isTableExpanded ? (
        <div
          className="table-modal-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setIsTableExpanded(false);
          }}
        >
          <section
            className="table-modal"
            role="dialog"
            aria-modal="true"
            aria-label="完整预测表"
            ref={expandedDialogRef}
            tabIndex={-1}
          >
            <div className="table-modal-head">
              <div>
                <p className="eyebrow">完整表格</p>
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
          issuedRow={detailIssuedRow}
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

      {confirmAction ? (
        <div
          className="detail-modal-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setConfirmAction(null);
          }}
        >
          <section className="cloud-account-modal" role="dialog" aria-modal="true" aria-label={confirmAction.title}>
            <h2>{confirmAction.title}</h2>
            <p className="confirm-body">{confirmAction.body}</p>
            <div className="cloud-account-actions">
              <button
                type="button"
                className="danger"
                onClick={() => {
                  const run = confirmAction.onConfirm;
                  setConfirmAction(null);
                  run();
                }}
              >
                {confirmAction.confirmLabel}
              </button>
              <button type="button" className="ghost" onClick={() => setConfirmAction(null)}>
                取消
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function CloudAccountModal({
  email,
  password,
  cloudUser,
  isBusy,
  dismissible = true,
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
  dismissible?: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus();

  return (
    <div
      className="table-modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="cloud-account-modal"
        role="dialog"
        aria-modal="true"
        aria-label="云端账户"
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="table-modal-head">
          <div>
            <p className="eyebrow">云端同步</p>
            <h2>云端账户</h2>
          </div>
          {dismissible ? (
            <button type="button" className="ghost" onClick={onClose}>
              关闭
            </button>
          ) : null}
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
          <form
            className="cloud-account-form"
            onSubmit={(event) => {
              event.preventDefault();
              onSignIn();
            }}
          >
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
              <button type="submit" disabled={isBusy}>
                {isBusy ? '正在登录…' : '登录并同步'}
              </button>
              {/* Account provisioning is restricted to administrators.
              <button type="button" className="ghost" onClick={onSignUp} disabled={isBusy}>
                注册账户
              </button> */}
            </div>
            <p className="cloud-account-hint">账户由管理员分配，没有账户或忘记密码请联系管理员。</p>
          </form>
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
  const dialogRef = useDialogFocus();

  return (
    <div
      className="detail-modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="history-modal"
        role="dialog"
        aria-modal="true"
        aria-label="历史预测对比"
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="detail-modal-head">
          <div>
            <p className="eyebrow">历史预测</p>
            <h2>历史预测与真实价格对比</h2>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="history-table" role="table" aria-label="历史预测与真实价格对比表">
          <div className="history-row history-head" role="row">
            <span role="columnheader">预测日期</span>
            <span className="num-cell" role="columnheader">预测收盘</span>
            <span className="num-cell" role="columnheader">真实收盘</span>
            <span className="num-cell" role="columnheader">差值</span>
            <span className="num-cell" role="columnheader">预测MA{inputMaWindow}</span>
            <span className="num-cell" role="columnheader">真实MA{inputMaWindow}</span>
          </div>
          {rows.length ? (
            rows.map((row) => (
              <div className="history-row" key={row.id} role="row">
                <span className="date-cell" role="cell">{row.actualDate ?? row.targetDate}</span>
                <strong className="history-predicted num-cell" role="cell">{formatNumber(row.predictedClose)}</strong>
                <strong className="num-cell" role="cell">{formatNumber(row.actualClose)}</strong>
                <span
                  className={`num-cell ${row.closeDiff === null ? '' : row.closeDiff > 0 ? 'up' : row.closeDiff < 0 ? 'down' : ''}`}
                  role="cell"
                >
                  {formatSignedNumber(row.closeDiff)}
                </span>
                <span className="num-cell" role="cell">{formatNumber(row.predictedMaValues[inputMaWindow])}</span>
                <span className="num-cell" role="cell">{formatNumber(row.actualMaValues[inputMaWindow])}</span>
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
  issuedRow,
  inputMaWindow,
  onClose,
}: {
  row: Ma40ProjectionRow;
  issuedRow: EvaluatedIssuedForecastRow | null;
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

  const dialogRef = useDialogFocus();

  return (
    <div
      className="detail-modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label="计算明细"
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="detail-modal-head">
          <div>
            <p className="eyebrow">计算过程</p>
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

          {issuedRow ? (
            <section className="formula-card issued-formula">
              <div className="formula-card-head">
                <span>已提交预测收盘</span>
                <strong>永久锁定</strong>
              </div>
              <div className="formula-line">{formatNumber(issuedRow.predictedClose)}</div>
              <div className="formula-meta">
                <span>提交时目标MA：{formatNumber(issuedRow.inputMaValue, 4)}</span>
                <span>最新有效MA：{formatNumber(issuedRow.currentImpliedMa, 4)}</span>
                <span>条件反推价：{formatNumber(issuedRow.conditionalClose)}</span>
                {issuedRow.settlement ? (
                  <span>真实收盘：{formatNumber(issuedRow.settlement.actualClose)}</span>
                ) : null}
              </div>
              <p className="formula-explanation">
                行情更新只改变最新有效MA、条件反推价和真实结算；已提交预测收盘不会被重算覆盖。
              </p>
            </section>
          ) : null}

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

function isPeriodType(value: string): value is PeriodType {
  return value === 'day' || value === 'week' || value === 'month';
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

function selectLatestHistoryRevisionRows(rows: ForecastHistoryRow[]) {
  const latestByTarget = new Map<string, ForecastHistoryRow>();
  for (const row of rows) {
    const existing = latestByTarget.get(row.targetDate);
    if (
      !existing ||
      row.savedAt > existing.savedAt ||
      (row.savedAt === existing.savedAt && row.id > existing.id)
    ) {
      latestByTarget.set(row.targetDate, row);
    }
  }
  return [...latestByTarget.values()].sort((left, right) =>
    (left.actualDate ?? left.targetDate).localeCompare(right.actualDate ?? right.targetDate),
  );
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

function formatCloudSaveError(error: Error | null) {
  const message = error?.message?.trim();
  if (/workspace revision conflict/i.test(message ?? '')) {
    return '云端数据已在另一端更新。为避免覆盖，请先从云端读取后再保存；当前页面数据未被覆盖。';
  }
  if (!message) return '向云端保存失败，请稍后重试。';
  return `向云端保存失败：${message}`;
}

function combineCloudSaveStates(
  prediction: CloudPredictionSaveState,
  history: CloudPredictionSaveState,
): CloudPredictionSaveState {
  const states = [prediction, history];
  const errorState = states.find((state) => state.status === 'error');
  const status: CloudPredictionSaveState['status'] = errorState
    ? 'error'
    : states.some((state) => state.status === 'saving')
      ? 'saving'
      : states.some((state) => state.status === 'pending')
        ? 'pending'
        : states.some((state) => state.status === 'saved')
          ? 'saved'
          : 'idle';
  const lastSavedAt = states
    .map((state) => state.lastSavedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;
  return {
    status,
    pendingCount: states.reduce((total, state) => total + state.pendingCount, 0),
    lastSavedAt,
    error: errorState?.error ?? null,
  };
}

function formatCloudSaveState(state: CloudPredictionSaveState) {
  switch (state.status) {
    case 'pending':
      return `待保存 ${state.pendingCount} 条`;
    case 'saving':
      return `正在保存 ${state.pendingCount} 条…`;
    case 'saved':
      return state.lastSavedAt
        ? `已保存 ${new Date(state.lastSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : '已保存';
    case 'error':
      return `${state.pendingCount} 条未保存`;
    default:
      return '已同步';
  }
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
      <strong title={value}>{value}</strong>
    </div>
  );
}

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
