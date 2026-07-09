import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import KLineChart, {
  type ChartLineSeries,
  type ChartPointSeries,
} from './components/KLineChart';
import { fetchKLines } from './services/eastmoney';
import type { PeriodType, PredictionPoint, StockKLineResponse } from './types';
import { filterCompletedKLineData } from './utils/completedPeriods';
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
  loadPredictionPlans,
  normalizePredictionPlanExport,
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
  saveReplaySnapshots,
  summarizeReplayRows,
  type ReplayPlanFilter,
  type ReplayReviewRow,
  type ReplaySummary,
  type ReplaySnapshot,
} from './utils/replay';

const periods: Array<{ value: PeriodType; label: string; unit: string }> = [
  { value: 'day', label: '日K', unit: '日' },
  { value: 'week', label: '周K', unit: '周' },
  { value: 'month', label: '月K', unit: '月' },
];

const forecastRowCount = 40;
const minHistoryCount = 60;
const todayDate = formatDate(new Date());
const initialWorkspace = loadWorkspaceCache();
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

export default function App() {
  const [stockCode, setStockCode] = useState(initialWorkspace?.stockCode ?? '000166');
  const [queryCode, setQueryCode] = useState(initialWorkspace?.stockCode ?? '000166');
  const [period, setPeriod] = useState<PeriodType>(initialWorkspace?.period ?? 'month');
  const [data, setData] = useState<StockKLineResponse | null>(null);
  const [baseDate, setBaseDate] = useState(todayDate);
  const [plans, setPlans] = useState<PredictionPlan[]>([]);
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
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'success' | 'warning' } | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importedPlanRef = useRef<ImportedPredictionPlan | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const lastSavedSignatureRef = useRef('');

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
    const cached = loadKLineCache(queryCode, period);
    setError('');

    if (!cached) {
      setData(null);
      setPlans([]);
      setActivePlanId(null);
      setBaseDate(todayDate);
      showToast('暂无本地历史数据，请点击“联网更新”拉取最近历史收盘价', 'warning');
      return;
    }

    const completed = filterCompletedKLineData(markAsLocalCache(cached.data), period);
    setData(completed.data);
    setBaseDate(completed.lastCompletedDate ?? todayDate);
    showToast(
      formatHistoryStatus(cached.updatedAt, completed.data.points.length, completed.removedPoints.length),
      'info',
    );
    if (completed.data.points.length < minHistoryCount) {
      setError(`本地历史数据不足${minHistoryCount}条，MA60计算可能不完整，请联网更新一次`);
    }
  }, [period, queryCode]);

  useEffect(() => {
    if (!data || !baseDate) return;

    const loaded = loadPredictionPlans(data.code, period, baseDate, data.points, forecastRowCount);
    let nextPlans = loaded.plans;
    let nextActivePlanId = loaded.activePlanId;
    const importedPlan = importedPlanRef.current;
    if (
      importedPlan &&
      importedPlan.stockCode === data.code &&
      importedPlan.period === period
    ) {
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
      savePredictionPlans(data.code, period, nextPlans);
      saveActivePlanId(data.code, period, nextActivePlanId);
      importedPlanRef.current = null;
      showToast('预测文件已加载', 'success');
    }

    setPlans(nextPlans);
    setActivePlanId(nextActivePlanId);
    lastSavedSignatureRef.current = createWorkspaceSignature(
      data.code,
      period,
      baseDate,
      nextPlans,
      nextActivePlanId,
    );
    setHasUnsavedChanges(false);
  }, [baseDate, data, period]);

  useEffect(() => {
    if (!data) {
      setReplaySnapshots([]);
      return;
    }

    setReplaySnapshots(loadReplaySnapshots(data.code, period));
  }, [data?.code, period]);

  useEffect(() => {
    if (!data || !baseDate || !plans.length) return;

    const signature = createWorkspaceSignature(data.code, period, baseDate, plans, activePlanId);
    setHasUnsavedChanges(signature !== lastSavedSignatureRef.current);
  }, [activePlanId, baseDate, data, period, plans, replaySnapshots]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      saveCurrentWorkspace({ notice: 'auto' });
    }, 30000);

    return () => window.clearInterval(timer);
  }, [activePlanId, baseDate, data, hasUnsavedChanges, period, plans, replaySnapshots]);

  function saveCurrentWorkspace({
    force = false,
    notice,
  }: {
    force?: boolean;
    notice: 'auto' | 'manual';
  }) {
    if (!data || !baseDate || !plans.length || !activePlanId) {
      if (notice === 'manual') {
        showToast('暂无可保存的数据', 'warning');
      }
      return;
    }

    if (!force && !hasUnsavedChanges) return;

    const signature = createWorkspaceSignature(data.code, period, baseDate, plans, activePlanId);
    if (signature === lastSavedSignatureRef.current) {
      setHasUnsavedChanges(false);
      if (notice === 'manual') {
        showToast(`已保存：${new Date().toLocaleTimeString()}`, 'success');
      }
      return;
    }

    const now = new Date().toISOString();
    savePredictionPlans(data.code, period, plans);
    saveActivePlanId(data.code, period, activePlanId);
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
        points: data.points,
        rows: projection.rows,
        inputMaWindow,
        existingSnapshots: replaySnapshots,
        now,
      });
      replaySnapshotCount = incomingReplaySnapshots.length;
      if (incomingReplaySnapshots.length) {
        const mergedSnapshots = mergeReplaySnapshots(replaySnapshots, incomingReplaySnapshots);
        saveReplaySnapshots(data.code, period, mergedSnapshots);
        setReplaySnapshots(mergedSnapshots);
      }
    } catch {
      replaySnapshotFailed = true;
    }
    lastSavedSignatureRef.current = signature;
    setHasUnsavedChanges(false);

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
  const replayRows = useMemo(
    () => (data ? buildReplayReviewRows(replaySnapshots, data.points) : []),
    [data, replaySnapshots],
  );
  const replayPlanOptions = useMemo(() => {
    const namesByPlanId = new Map<string, string>();
    for (const plan of plans) {
      namesByPlanId.set(plan.id, plan.name);
    }
    for (const row of replayRows) {
      if (row.planId) {
        namesByPlanId.set(row.planId, row.planName || namesByPlanId.get(row.planId) || '历史方案');
      }
    }

    return Array.from(namesByPlanId, ([id, name]) => ({ id, name }));
  }, [plans, replayRows]);
  const filteredReplayRows = useMemo(
    () => filterReplayRowsByPlan(replayRows, replayPlanFilter, activePlanId),
    [activePlanId, replayPlanFilter, replayRows],
  );
  const replaySummary = useMemo(() => summarizeReplayRows(filteredReplayRows), [filteredReplayRows]);
  const replayTotalSummary = useMemo(() => summarizeReplayRows(replayRows), [replayRows]);
  const hasLegacyReplayRows = useMemo(() => replayRows.some((row) => !row.planId), [replayRows]);
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
    if (!activePlanId) return;
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
    if (!data || !baseDate) return;
    const rows = generatePredictionRows(data.points, period, baseDate, forecastRowCount);
    const nextPlan = createEmptyPlan(data.code, period, rows, plans);
    setPlans((current) => [...current, nextPlan]);
    setActivePlanId(nextPlan.id);
    showToast(`已新建方案：${nextPlan.name}`, 'success');
  }

  function duplicatePlan() {
    if (!activePlan) return;
    const nextPlan = copyPredictionPlan(activePlan, plans);
    setPlans((current) => [...current, nextPlan]);
    setActivePlanId(nextPlan.id);
    showToast(`已复制方案：${nextPlan.name}`, 'success');
  }

  function renameActivePlan() {
    if (!activePlan) return;
    const name = window.prompt('请输入方案名称', activePlan.name);
    if (name === null) return;

    const renamed = renamePredictionPlan(activePlan, name, plans);
    setPlans((current) => current.map((plan) => (plan.id === activePlan.id ? renamed : plan)));
    showToast(`方案已重命名：${renamed.name}`, 'success');
  }

  function deleteActivePlan() {
    if (!activePlan || plans.length <= 1) {
      showToast('至少需要保留一个方案', 'warning');
      return;
    }

    const confirmed = window.confirm(`确定删除方案“${activePlan.name}”吗？`);
    if (!confirmed) return;

    const remainingPlans = plans.filter((plan) => plan.id !== activePlan.id);
    const nextActivePlanId = resolveActivePlanId(remainingPlans, null);
    setPlans(remainingPlans);
    setActivePlanId(nextActivePlanId);
    showToast('方案已删除', 'success');
  }

  function selectActivePlan(planId: string) {
    if (!plans.some((plan) => plan.id === planId)) return;
    setActivePlanId(planId);
    if (data) saveActivePlanId(data.code, period, planId);
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

  async function refreshHistoricalData() {
    setIsLoading(true);
    setError('');
    showToast('正在联网更新历史收盘价...', 'info');

    try {
      const result = await fetchKLines(stockCode, period);
      const completed = filterCompletedKLineData(markAsOnlineResult(result), period);
      saveKLineCache(completed.data, period);
      setData(completed.data);
      setBaseDate(completed.lastCompletedDate ?? todayDate);
      setStockCode(completed.data.code);
      setQueryCode(completed.data.code);
      showToast(`已联网更新：${completed.data.points.length}条，${new Date().toLocaleString()}`, 'success');
      if (completed.data.points.length < minHistoryCount) {
        setError(`联网数据不足${minHistoryCount}条，MA60计算可能不完整`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '联网更新失败';
      const cached = loadKLineCache(stockCode, period);
      if (cached) {
        const completed = filterCompletedKLineData(markAsLocalCache(cached.data), period);
        setData(completed.data);
        setBaseDate(completed.lastCompletedDate ?? todayDate);
        showToast(
          `${formatHistoryStatus(cached.updatedAt, completed.data.points.length, completed.removedPoints.length)}；联网失败，继续使用本地缓存`,
          'warning',
        );
      }
      setError(`联网更新失败：${message}`);
    } finally {
      setIsLoading(false);
    }
  }

  function updateNote(value: string) {
    updateActivePlan((plan) => ({
      ...plan,
      note: value,
      predictions: plan.predictions.map((row) => ({ ...row, note: value })),
    }));
  }

  function resetRows() {
    if (!data || !baseDate || !activePlan) return;
    const rows = generatePredictionRows(data.points, period, baseDate, forecastRowCount);
    updateActivePlan((plan) => ({
      ...plan,
      predictions: rows.map((row) => ({ ...row, note: plan.note })),
    }));
    showToast('已重置当前预测表', 'success');
  }

  function exportPredictions() {
    if (!data || !baseDate || !activePlan) {
      showToast('暂无可导出的预测数据', 'warning');
      return;
    }

    const fileData = createPredictionPlanExport(activePlan, data.name, baseDate, '0.2.6');
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
    showToast('预测文件已导出', 'success');
  }

  async function importPredictions(file: File | undefined) {
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = normalizePredictionFile(JSON.parse(text));
      if (!parsed) {
        throw new Error('文件格式不是本系统导出的预测方案文件');
      }

      if (data && baseDate && parsed.stockCode === data.code && parsed.period === period) {
        const rows = generatePredictionRows(data.points, period, baseDate, forecastRowCount);
        const imported = importPredictionPlan(parsed.plan, data.code, period, rows, plans);
        const nextPlans = [...plans, imported];
        setPlans(nextPlans);
        setActivePlanId(imported.id);
        savePredictionPlans(data.code, period, nextPlans);
        saveActivePlanId(data.code, period, imported.id);
        lastSavedSignatureRef.current = createWorkspaceSignature(
          data.code,
          period,
          baseDate,
          nextPlans,
          imported.id,
        );
        setHasUnsavedChanges(false);
        showToast(`已导入方案：${imported.name}`, 'success');
        return;
      }

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
      showToast(`已选择文件：${file.name}`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导入失败', 'warning');
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
            {(() => {
              const sliderConfig = getPredictionSliderConfig(
                row,
                inputMaWindow,
                latest?.close ?? null,
                data?.points ?? [],
              );
              return (
                <>
                  <span className="date-cell">{row.targetDate}</span>
                  <div className="prediction-input-stack">
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
                    <input
                      className="prediction-slider"
                      aria-label={`${row.targetDate} 预测MA${inputMaWindow}滑杆`}
                      type="range"
                      min={sliderConfig.min}
                      max={sliderConfig.max}
                      step={sliderConfig.step}
                      value={getPredictionSliderValue(row, inputMaWindow, sliderConfig.anchor)}
                      onChange={(event) =>
                        updatePrediction(
                          row.targetDate,
                          Number(event.target.value).toFixed(4),
                        )
                      }
                    />
                  </div>
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
                </>
              );
            })()}
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
            setQueryCode(stockCode);
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
        </form>
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
              <button type="button" className="ghost" onClick={exportPredictions}>
                导出
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
          planFilter={replayPlanFilter}
          planOptions={replayPlanOptions}
          activePlanId={activePlanId}
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

function getPredictionSliderValue(row: PredictionPoint, windowSize: MaWindow, fallback: number) {
  const input = getPredictionInputValue(row, windowSize);
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getPredictionSliderConfig(
  row: PredictionPoint,
  windowSize: MaWindow,
  latestClose: number | null,
  points: StockKLineResponse['points'],
) {
  const input = getPredictionInputValue(row, windowSize);
  const parsed = Number(input);
  const anchorBase =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : latestClose && latestClose > 0
        ? latestClose
        : 1;

  const recent = points.slice(-60).map((item) => item.close).filter((value) => value > 0);
  const volatilityPct = getCloseVolatilityPct(recent);
  const rangePct = clamp(volatilityPct * 1.8, 0.03, 0.12);

  const min = roundTo4(Math.max(0, anchorBase * (1 - rangePct)));
  const max = roundTo4(Math.max(min + 0.01, anchorBase * (1 + rangePct)));
  const step = getSliderStep(anchorBase);

  return {
    anchor: anchorBase,
    min,
    max,
    step,
  };
}

function getCloseVolatilityPct(values: number[]) {
  if (values.length < 2) return 0.03;
  const returns: number[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const prev = values[index - 1];
    const curr = values[index];
    if (prev > 0 && curr > 0) {
      returns.push(Math.abs(curr / prev - 1));
    }
  }
  if (!returns.length) return 0.03;
  const average = returns.reduce((total, value) => total + value, 0) / returns.length;
  return average;
}

function getSliderStep(value: number) {
  if (value < 10) return 0.001;
  if (value < 100) return 0.01;
  if (value < 1000) return 0.1;
  return 1;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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

function roundTo4(value: number) {
  return Number(value.toFixed(4));
}
