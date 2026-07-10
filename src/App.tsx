import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import packageJson from '../package.json';
import KLineChart, {
  type ChartLineSeries,
  type ChartPointSeries,
} from './components/KLineChart';
import { fetchKLines } from './services/eastmoney';
import type { PeriodType, PredictionPoint, StockKLineResponse } from './types';
import { filterCompletedKLineData } from './utils/completedPeriods';
import { persistElectronStorage } from './utils/electronStorage';
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
  loadPredictionRows,
  loadWorkspaceCache,
  normalizePredictionPoint,
  predictionPlanKey,
  saveKLineCache,
  savePredictions,
  saveWorkspaceCache,
} from './utils/predictions';

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

export default function App() {
  const [stockCode, setStockCode] = useState(initialWorkspace?.stockCode ?? '000166');
  const [queryCode, setQueryCode] = useState(initialWorkspace?.stockCode ?? '000166');
  const [period, setPeriod] = useState<PeriodType>(initialWorkspace?.period ?? 'month');
  const [data, setData] = useState<StockKLineResponse | null>(null);
  const [baseDate, setBaseDate] = useState(todayDate);
  const [predictions, setPredictions] = useState<PredictionPoint[]>([]);
  const [visibleMaWindows, setVisibleMaWindows] = useState<MaWindow[]>([5, 10, 20, 40, 60]);
  const [showActualMaLines, setShowActualMaLines] = useState(false);
  const [inputMaWindow, setInputMaWindow] = useState<MaWindow>(MA40_WINDOW);
  const [isTableExpanded, setIsTableExpanded] = useState(false);
  const [detailTargetDate, setDetailTargetDate] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>({
    status: 'idle',
    currentVersion: appVersion,
  });
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'success' | 'warning' } | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importedPlanRef = useRef<PredictionFileV5 | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const lastSavedSignatureRef = useRef('');

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
    const cached = loadKLineCache(queryCode, period);
    setError('');

    if (!cached) {
      setData(null);
      setPredictions([]);
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

    const importedPlan = importedPlanRef.current;
    if (
      importedPlan &&
      importedPlan.stockCode === data.code &&
      importedPlan.period === period
    ) {
      setPredictions(importedPlan.predictions);
      savePredictions(predictionPlanKey(data.code, period, baseDate), importedPlan.predictions);
      importedPlanRef.current = null;
      showToast('预测文件已加载', 'success');
      return;
    }

    setPredictions(loadPredictionRows(data.code, period, baseDate, data.points, forecastRowCount));
  }, [baseDate, data, period]);

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

  function saveCurrentWorkspace({
    force = false,
    notice,
  }: {
    force?: boolean;
    notice: 'auto' | 'manual';
  }) {
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

    savePredictions(predictionPlanKey(data.code, period, baseDate), predictions);
    saveWorkspaceCache({
      stockCode: data.code,
      period,
      baseDate,
      updatedAt: new Date().toISOString(),
    });
    lastSavedSignatureRef.current = signature;
    setHasUnsavedChanges(false);

    showToast(
      notice === 'auto'
        ? `已自动保存：${new Date().toLocaleTimeString()}`
        : `已保存：${new Date().toLocaleTimeString()}`,
      'success',
    );
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

  function updatePrediction(targetDate: string, value: string) {
    const normalizedValue = normalizeDecimalInput(value);
    setPredictions((current) =>
      current.map((row) =>
        row.targetDate === targetDate
          ? setPredictionInputValue(row, inputMaWindow, normalizedValue)
          : row,
      ),
    );
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
    setPredictions((current) => current.map((row) => ({ ...row, note: value })));
  }

  function resetRows() {
    if (!data || !baseDate) return;
    setPredictions(generatePredictionRows(data.points, period, baseDate, forecastRowCount));
    showToast('已重置当前预测表', 'success');
  }

  function exportAllData() {
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
      const text = await file.text();
      const rawFile = JSON.parse(text);
      const backup = normalizeFullBackupFile(rawFile);
      if (backup) {
        restoreAppStorage(backup.storage);
        await persistElectronStorage();
        showToast(`已导入全部本地数据：${Object.keys(backup.storage).length}项，正在刷新`, 'success');
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
