import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import KLineChart, { type ChartLineSeries } from './components/KLineChart';
import { fetchKLines } from './services/eastmoney';
import type { PeriodType, PredictionPoint, StockKLineResponse } from './types';
import { compareProjectionRows, formatNumber, summarizeComparisons } from './utils/metrics';
import {
  buildMa40Projection,
  calculateMovingAverage,
  type LineValuePoint,
  MA40_WINDOW,
  MA_WINDOWS,
  type MaWindow,
} from './utils/movingAverage';
import {
  generatePredictionRows,
  loadPredictionRows,
  loadWorkspaceCache,
  normalizePredictionPoint,
  predictionPlanKey,
  savePredictions,
  saveWorkspaceCache,
} from './utils/predictions';

const periods: Array<{ value: PeriodType; label: string; unit: string }> = [
  { value: 'day', label: '日K', unit: '日' },
  { value: 'week', label: '周K', unit: '周' },
  { value: 'month', label: '月K', unit: '月' },
];

const forecastRowCount = 40;
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

export default function App() {
  const [stockCode, setStockCode] = useState(initialWorkspace?.stockCode ?? '000166');
  const [queryCode, setQueryCode] = useState(initialWorkspace?.stockCode ?? '000166');
  const [period, setPeriod] = useState<PeriodType>(initialWorkspace?.period ?? 'month');
  const [data, setData] = useState<StockKLineResponse | null>(null);
  const [baseDate, setBaseDate] = useState(initialWorkspace?.baseDate ?? todayDate);
  const [predictions, setPredictions] = useState<PredictionPoint[]>([]);
  const [visibleMaWindows, setVisibleMaWindows] = useState<MaWindow[]>([5, 10, 20, 40, 60]);
  const [inputMaWindow, setInputMaWindow] = useState<MaWindow>(40);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [fileStatus, setFileStatus] = useState('');
  const [cacheStatus, setCacheStatus] = useState(
    initialWorkspace ? `已恢复上次缓存：${initialWorkspace.stockCode}` : '本机自动缓存已开启',
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importedPlanRef = useRef<PredictionFileV5 | null>(null);
  const initialWorkspaceRef = useRef(initialWorkspace);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError('');

    fetchKLines(queryCode, period)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setBaseDate(() => {
          const importedPlan = importedPlanRef.current;
          if (
            importedPlan &&
            importedPlan.stockCode === result.code &&
            importedPlan.period === period
          ) {
            return importedPlan.baseDate;
          }

          const cachedWorkspace = initialWorkspaceRef.current;
          if (
            cachedWorkspace &&
            cachedWorkspace.stockCode === result.code &&
            cachedWorkspace.period === period
          ) {
            initialWorkspaceRef.current = null;
            return cachedWorkspace.baseDate;
          }

          return result.points.at(-1)?.date ?? todayDate;
        });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setData(null);
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [period, queryCode]);

  useEffect(() => {
    if (!data || !baseDate) return;

    const importedPlan = importedPlanRef.current;
    if (
      importedPlan &&
      importedPlan.stockCode === data.code &&
      importedPlan.period === period &&
      importedPlan.baseDate === baseDate
    ) {
      setPredictions(importedPlan.predictions);
      savePredictions(predictionPlanKey(data.code, period, baseDate), importedPlan.predictions);
      importedPlanRef.current = null;
      setFileStatus('预测文件已加载');
      return;
    }

    setPredictions(loadPredictionRows(data.code, period, baseDate, data.points, forecastRowCount));
  }, [baseDate, data, period]);

  useEffect(() => {
    if (!data || !baseDate || !predictions.length) return;

    savePredictions(predictionPlanKey(data.code, period, baseDate), predictions);
    saveWorkspaceCache({
      stockCode: data.code,
      period,
      baseDate,
      updatedAt: new Date().toISOString(),
    });
    setCacheStatus(`已自动保存：${new Date().toLocaleTimeString()}`);
  }, [baseDate, data, period, predictions]);

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
  const latestActualMa40 = useMemo(
    () => (data ? calculateMovingAverage(data.points).at(-1)?.value ?? null : null),
    [data],
  );
  const unit = periods.find((item) => item.value === period)?.unit ?? '';
  const filledCount = predictions.filter(
    (row) => getPredictionInputValue(row, inputMaWindow).trim() !== '',
  ).length;
  const predictionTableStyle = {
    gridTemplateColumns: `132px 112px 104px 86px repeat(${visibleMaWindows.length}, 72px)`,
    minWidth: `${456 + visibleMaWindows.length * 80}px`,
  };
  const lineSeries = useMemo<ChartLineSeries[]>(
    () =>
      visibleMaWindows.flatMap((windowSize) => [
        {
          label: `真实MA${windowSize}`,
          color: lineColors[windowSize],
          rows: projection.actualLines[windowSize],
          lineWidth: windowSize === 40 ? 2.5 : 1.8,
          lineType: 'solid' as const,
          symbol: 'none',
          symbolSize: 0,
          symbolOffset: [0, 0] as [number, number],
          opacity: windowSize === 40 ? 0.82 : 0.66,
          showSymbol: false,
          z: 3 + windowSize,
        },
        {
          label: `预测MA${windowSize}`,
          color: lineColors[windowSize],
          rows: projection.predictedLines[windowSize],
          lineWidth: windowSize === 40 ? 3.2 : 2.5,
          lineType: 'dashed' as const,
          symbol: 'circle',
          symbolSize: windowSize === 40 ? 7 : 5,
          symbolOffset: [0, 0] as [number, number],
          opacity: 0.96,
          showSymbol: windowSize === 40,
          z: 10 + windowSize,
        },
      ]),
    [projection.actualLines, projection.predictedLines, visibleMaWindows],
  );

  function toggleMaWindow(windowSize: MaWindow) {
    setVisibleMaWindows((current) => {
      if (current.includes(windowSize)) {
        return current.length === 1 ? current : current.filter((item) => item !== windowSize);
      }

      return MA_WINDOWS.filter((item) => current.includes(item) || item === windowSize);
    });
  }

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

  function updateNote(value: string) {
    setPredictions((current) => current.map((row) => ({ ...row, note: value })));
  }

  function resetRows() {
    if (!data || !baseDate) return;
    setPredictions(generatePredictionRows(data.points, period, baseDate, forecastRowCount));
    setFileStatus('已重置当前预测表');
  }

  function exportPredictions() {
    if (!data || !baseDate || !predictions.length) {
      setFileStatus('暂无可导出的预测数据');
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
    setFileStatus('预测文件已导出');
  }

  async function importPredictions(file: File | undefined) {
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = normalizePredictionFile(JSON.parse(text));
      if (!parsed) {
        throw new Error('文件格式不是本系统导出的 MA40 预测文件');
      }

      importedPlanRef.current = parsed;
      setStockCode(parsed.stockCode);
      setQueryCode(parsed.stockCode);
      setPeriod(parsed.period);
      setBaseDate(parsed.baseDate);
      setPredictions(parsed.predictions);
      savePredictions(predictionPlanKey(parsed.stockCode, parsed.period, parsed.baseDate), parsed.predictions);
      saveWorkspaceCache({
        stockCode: parsed.stockCode,
        period: parsed.period,
        baseDate: parsed.baseDate,
        updatedAt: new Date().toISOString(),
      });
      setFileStatus(`已选择文件：${file.name}`);
    } catch (err) {
      setFileStatus(err instanceof Error ? err.message : '导入失败');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">MA40 Forecast Console</p>
          <h1>人工预测 MA40 走势</h1>
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
          <button type="submit">加载</button>
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

        <label className="select-field">
          <span>预测起点</span>
          <input
            type="date"
            value={baseDate}
            onChange={(event) => setBaseDate(event.target.value || todayDate)}
          />
        </label>
      </section>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="market-strip">
        <Metric label="股票" value={data ? `${data.name} ${data.code}` : '申万宏源 000166'} />
        <Metric label="数据源" value={data?.sourceName ?? '--'} />
        <Metric label="最新周期" value={latest?.date ?? '--'} />
        <Metric label="最新收盘" value={latest ? latest.close.toFixed(2) : '--'} />
        <Metric label="最新MA40" value={formatNumber(latestActualMa40)} />
        <Metric label="预测窗口" value={`${MA40_WINDOW}${unit}`} />
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
              baseDate={baseDate}
              period={period}
              showCloseLine={false}
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
              <button type="button" className="ghost" onClick={() => fileInputRef.current?.click()}>
                导入
              </button>
              <button type="button" className="ghost" onClick={resetRows}>
                重置
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
          {fileStatus ? <div className="file-status">{fileStatus}</div> : null}
          <div className="cache-status">{cacheStatus}</div>

          <div className="input-mode-strip" aria-label="反推基准选择">
            <span>反推基准</span>
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

          <div className="prediction-table ma40-table">
            <div className="prediction-row table-head" style={predictionTableStyle}>
              <span>目标周期</span>
              <span>预测MA{inputMaWindow}</span>
              <span>反推收盘</span>
              <span>真实收盘</span>
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
                {visibleMaWindows.map((windowSize) => (
                  <span key={windowSize}>{formatNumber(row.maValues[windowSize])}</span>
                ))}
              </div>
            ))}
          </div>

          <label className="note-field">
            <span>备注</span>
            <textarea
              value={predictions[0]?.note ?? ''}
              onChange={(event) => updateNote(event.target.value)}
              placeholder="例如：MA40目标、趋势判断、压力位..."
            />
          </label>
        </aside>
      </section>
    </main>
  );
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
