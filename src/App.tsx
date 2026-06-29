import { useEffect, useMemo, useRef, useState } from 'react';
import KLineChart, { type ChartLineSeries } from './components/KLineChart';
import { fetchKLines } from './services/eastmoney';
import type { Horizon, PeriodType, PredictionPoint, StockKLineResponse } from './types';
import { comparePredictions, formatNumber, summarizeComparisons } from './utils/metrics';
import {
  buildProjectedAverageRows,
  calculateActualMovingAverage,
  calculateProjectedMovingAverages,
  predictionCloseLine,
} from './utils/movingAverage';
import {
  generatePredictionRows,
  loadPredictionRows,
  loadWorkspaceCache,
  predictionPlanKey,
  savePredictions,
  saveWorkspaceCache,
} from './utils/predictions';

const periods: Array<{ value: PeriodType; label: string; unit: string }> = [
  { value: 'day', label: '日K', unit: '日' },
  { value: 'week', label: '周K', unit: '周' },
  { value: 'month', label: '月K', unit: '月' },
];

const horizons: Horizon[] = [5, 10, 20];
const maxHorizon: Horizon = 20;
const todayDate = formatDate(new Date());
const initialWorkspace = loadWorkspaceCache();
const emptyLineMap: Record<Horizon, []> = { 5: [], 10: [], 20: [] };
const horizonStyles: Record<
  Horizon,
  {
    label: string;
    color: string;
    className: string;
    lineWidth: number;
    lineType: 'solid' | 'dashed' | 'dotted';
    symbol: string;
    symbolSize: number;
    symbolOffset: [number, number];
    z: number;
  }
> = {
  5: {
    label: '短线',
    color: '#2f7893',
    className: 'horizon-5',
    lineWidth: 2.2,
    lineType: 'solid',
    symbol: 'circle',
    symbolSize: 6,
    symbolOffset: [0, -7],
    z: 8,
  },
  10: {
    label: '中线',
    color: '#a87935',
    className: 'horizon-10',
    lineWidth: 2.8,
    lineType: 'dashed',
    symbol: 'circle',
    symbolSize: 6,
    symbolOffset: [0, 0],
    z: 7,
  },
  20: {
    label: '长线',
    color: '#5f7d5d',
    className: 'horizon-20',
    lineWidth: 3.6,
    lineType: 'dotted',
    symbol: 'roundRect',
    symbolSize: 7,
    symbolOffset: [0, 7],
    z: 6,
  },
};

interface PredictionFileV3 {
  schema: 'gupiao-manual-predictions/v3';
  exportedAt: string;
  stockCode: string;
  stockName?: string;
  period: PeriodType;
  baseDate: string;
  predictions: PredictionPoint[];
}

interface LegacyPredictionFileV2 {
  schema: 'gupiao-manual-predictions/v2';
  exportedAt: string;
  stockCode: string;
  stockName?: string;
  period: PeriodType;
  baseDate: string;
  predictionsByHorizon: Record<Horizon, PredictionPoint[]>;
}

export default function App() {
  const [stockCode, setStockCode] = useState(initialWorkspace?.stockCode ?? '000166');
  const [queryCode, setQueryCode] = useState(initialWorkspace?.stockCode ?? '000166');
  const [period, setPeriod] = useState<PeriodType>(initialWorkspace?.period ?? 'month');
  const [data, setData] = useState<StockKLineResponse | null>(null);
  const [baseDate, setBaseDate] = useState(initialWorkspace?.baseDate ?? todayDate);
  const [predictions, setPredictions] = useState<PredictionPoint[]>([]);
  const [visibleHorizons, setVisibleHorizons] = useState<Record<Horizon, boolean>>({
    5: true,
    10: true,
    20: true,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [fileStatus, setFileStatus] = useState('');
  const [cacheStatus, setCacheStatus] = useState(
    initialWorkspace ? `已恢复上次缓存：${initialWorkspace.stockCode}` : '本机自动缓存已开启',
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importedPlanRef = useRef<PredictionFileV3 | null>(null);
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

          return todayDate;
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

    setPredictions(loadPredictionRows(data.code, period, baseDate, data.points, maxHorizon, horizons));
  }, [baseDate, data, period]);

  useEffect(() => {
    if (!data || !baseDate || !predictions.length) return;

    savePredictions(predictionPlanKey(data.code, period, baseDate), predictions);
    saveWorkspaceCache({
      stockCode: data.code,
      period,
      horizon: maxHorizon,
      baseDate,
      updatedAt: new Date().toISOString(),
    });
    setCacheStatus(`已自动保存：${new Date().toLocaleTimeString()}`);
  }, [baseDate, data, period, predictions]);

  const predictionComparisons = useMemo(
    () => comparePredictions(predictions, data?.points ?? []),
    [data?.points, predictions],
  );
  const summary = useMemo(() => summarizeComparisons(predictionComparisons), [predictionComparisons]);
  const projectedAverageRows = useMemo(
    () => (data ? buildProjectedAverageRows(data.points, predictions, horizons) : []),
    [data, predictions],
  );
  const actualMovingAverages = useMemo(
    () =>
      data
        ? ({
            5: calculateActualMovingAverage(data.points, 5),
            10: calculateActualMovingAverage(data.points, 10),
            20: calculateActualMovingAverage(data.points, 20),
          } satisfies Record<Horizon, ReturnType<typeof calculateActualMovingAverage>>)
        : emptyLineMap,
    [data],
  );
  const projectedMovingAverages = useMemo(
    () => (data ? calculateProjectedMovingAverages(data.points, predictions, horizons) : emptyLineMap),
    [data, predictions],
  );

  const latest = data?.points.at(-1);
  const unit = periods.find((item) => item.value === period)?.unit ?? '';
  const visibleHorizonList = horizons.filter((item) => visibleHorizons[item]);
  const filledCount = countFilled(predictions);
  const lineSeries = useMemo<ChartLineSeries[]>(() => {
    const predictionClose: ChartLineSeries = {
      label: '预测收盘',
      color: '#4a3f31',
      rows: predictionCloseLine(predictions),
      lineWidth: 1.8,
      lineType: 'solid',
      symbol: 'circle',
      symbolSize: 6,
      symbolOffset: [0, -12],
      z: 10,
    };
    const averageLines = visibleHorizonList.flatMap((item) => {
      const style = horizonStyles[item];
      return [
        {
          label: `真实MA${item}`,
          color: style.color,
          rows: actualMovingAverages[item],
          lineWidth: 1.6,
          lineType: 'solid',
          symbol: 'none',
          symbolSize: 0,
          symbolOffset: [0, 0] as [number, number],
          opacity: 0.62,
          showSymbol: false,
          z: 2,
        },
        {
          label: `预测MA${item}`,
          color: style.color,
          rows: projectedMovingAverages[item],
          lineWidth: style.lineWidth,
          lineType: style.lineType,
          symbol: style.symbol,
          symbolSize: style.symbolSize,
          symbolOffset: style.symbolOffset,
          opacity: 0.78,
          z: style.z,
        },
      ] satisfies ChartLineSeries[];
    });

    return [predictionClose, ...averageLines];
  }, [actualMovingAverages, predictions, projectedMovingAverages, visibleHorizonList]);

  function toggleHorizon(item: Horizon) {
    setVisibleHorizons((current) => {
      const activeCount = horizons.filter((candidate) => current[candidate]).length;
      if (current[item] && activeCount === 1) return current;
      return { ...current, [item]: !current[item] };
    });
  }

  function updatePrediction(targetDate: string, value: string) {
    setPredictions((current) =>
      current.map((row) =>
        row.targetDate === targetDate
          ? {
              ...row,
              predictedClose: value,
            }
          : row,
      ),
    );
  }

  function updateNote(value: string) {
    setPredictions((current) => current.map((row) => ({ ...row, note: value })));
  }

  function resetRows() {
    if (!data || !baseDate) return;
    setPredictions(generatePredictionRows(data.points, period, baseDate, maxHorizon));
    setFileStatus('已重置当前预测表');
  }

  function exportPredictions() {
    if (!data || !baseDate || !predictions.length) {
      setFileStatus('暂无可导出的预测数据');
      return;
    }

    const fileData: PredictionFileV3 = {
      schema: 'gupiao-manual-predictions/v3',
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
    link.download = `${data.code}-${period}-${baseDate}-forecast-ma.json`;
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
        throw new Error('文件格式不是本系统导出的预测文件');
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
        horizon: maxHorizon,
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
          <p className="eyebrow">Eastmoney K-Line Forecast Compare</p>
          <h1>人工预测走势对比</h1>
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

        <div className="horizon-display" aria-label="显示均线">
          {horizons.map((item) => (
            <button
              aria-pressed={visibleHorizons[item]}
              className={`${horizonStyles[item].className} ${visibleHorizons[item] ? 'selected' : 'muted'}`}
              key={item}
              onClick={() => toggleHorizon(item)}
              type="button"
            >
              <b>MA{item}</b>
              <small>
                {item}
                {unit}
                均线
              </small>
            </button>
          ))}
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
        <Metric label="最新周期" value={latest?.date ?? '--'} />
        <Metric label="最新收盘" value={latest ? latest.close.toFixed(2) : '--'} />
        <Metric label="已填写" value={`${filledCount}/${predictions.length || maxHorizon}`} />
        <Metric label="可对比" value={`${summary.compared}`} />
        <Metric label="MAE" value={summary.mae === null ? '--' : summary.mae.toFixed(2)} />
        <Metric label="MAPE" value={summary.mape === null ? '--' : `${summary.mape.toFixed(2)}%`} />
      </section>

      <section className="workspace">
        <div className="chart-panel">
          {isLoading ? (
            <div className="loading">正在从东方财富加载K线数据...</div>
          ) : data ? (
            <KLineChart
              points={data.points}
              lineSeries={lineSeries}
              baseDate={baseDate}
              period={period}
            />
          ) : (
            <div className="loading">暂无K线数据</div>
          )}
        </div>

        <aside className="input-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Manual Input</p>
              <h2>预测收盘价</h2>
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

          <div className="prediction-table moving-average-table">
            <div className={`prediction-row table-head columns-${visibleHorizonList.length}`}>
              <span>目标周期</span>
              <span>预测收盘</span>
              <span>真实价</span>
              {visibleHorizonList.map((item) => (
                <span className={`horizon-head ${horizonStyles[item].className}`} key={item}>
                  MA{item}
                </span>
              ))}
            </div>
            {projectedAverageRows.map((row) => (
              <div className={`prediction-row columns-${visibleHorizonList.length}`} key={row.targetDate}>
                <span className="date-cell">{row.targetDate}</span>
                <input
                  className="prediction-input forecast-close-input"
                  aria-label={`${row.targetDate} 预测收盘价`}
                  type="number"
                  step="0.01"
                  min="0"
                  value={row.predictedClose}
                  onChange={(event) => updatePrediction(row.targetDate, event.target.value)}
                  placeholder="0.00"
                />
                <span>{formatNumber(row.actualClose)}</span>
                {visibleHorizonList.map((item) => (
                  <span className={`ma-cell ${horizonStyles[item].className}`} key={item}>
                    {formatNumber(row.ma[item])}
                  </span>
                ))}
              </div>
            ))}
          </div>

          <label className="note-field">
            <span>备注</span>
            <textarea
              value={predictions[0]?.note ?? ''}
              onChange={(event) => updateNote(event.target.value)}
              placeholder="例如：基本面判断、压力位、人工假设..."
            />
          </label>
        </aside>
      </section>
    </main>
  );
}

function normalizePredictionFile(value: unknown): PredictionFileV3 | null {
  if (isPredictionFileV3(value)) return value;
  if (isLegacyPredictionFileV2(value)) {
    return {
      schema: 'gupiao-manual-predictions/v3',
      exportedAt: value.exportedAt,
      stockCode: value.stockCode,
      stockName: value.stockName,
      period: value.period,
      baseDate: value.baseDate,
      predictions: mergeLegacyPredictionRows(value.predictionsByHorizon),
    };
  }

  return null;
}

function isPredictionFileV3(value: unknown): value is PredictionFileV3 {
  const candidate = value as PredictionFileV3;
  return (
    candidate?.schema === 'gupiao-manual-predictions/v3' &&
    typeof candidate.stockCode === 'string' &&
    ['day', 'week', 'month'].includes(candidate.period) &&
    typeof candidate.baseDate === 'string' &&
    Array.isArray(candidate.predictions)
  );
}

function isLegacyPredictionFileV2(value: unknown): value is LegacyPredictionFileV2 {
  const candidate = value as LegacyPredictionFileV2;
  return (
    candidate?.schema === 'gupiao-manual-predictions/v2' &&
    typeof candidate.stockCode === 'string' &&
    ['day', 'week', 'month'].includes(candidate.period) &&
    typeof candidate.baseDate === 'string' &&
    horizons.every((item) => Array.isArray(candidate.predictionsByHorizon?.[item]))
  );
}

function mergeLegacyPredictionRows(rowsByHorizon: Record<Horizon, PredictionPoint[]>) {
  const byDate = new Map<string, PredictionPoint>();

  for (const horizon of horizons) {
    for (const row of rowsByHorizon[horizon]) {
      const current = byDate.get(row.targetDate);
      if (!current) {
        byDate.set(row.targetDate, { ...row });
        continue;
      }

      byDate.set(row.targetDate, {
        ...current,
        predictedClose:
          current.predictedClose.trim() === '' && row.predictedClose.trim() !== ''
            ? row.predictedClose
            : current.predictedClose,
        note: current.note.trim() === '' && row.note.trim() !== '' ? row.note : current.note,
      });
    }
  }

  return Array.from(byDate.values()).sort((left, right) =>
    left.targetDate.localeCompare(right.targetDate),
  );
}

function countFilled(rows: PredictionPoint[]) {
  return rows.filter((row) => row.predictedClose.trim() !== '').length;
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
