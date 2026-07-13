import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { KLinePoint, PeriodType, StockKLineResponse } from '../types';

const KLT: Record<PeriodType, number> = {
  day: 101,
  week: 102,
  month: 103,
};

const TENCENT_PERIOD: Record<PeriodType, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
};

const DEFAULT_BEGIN: Record<PeriodType, string> = {
  day: '20240101',
  week: '20220101',
  month: '20150101',
};

type AdjustType = 'bfq';

interface QuoteSource {
  name: string;
  provider: 'tencent' | 'eastmoney';
  adjust: AdjustType;
}

const QUOTE_SOURCES: QuoteSource[] = [
  { name: '腾讯不复权', provider: 'tencent', adjust: 'bfq' },
  { name: '东方财富不复权', provider: 'eastmoney', adjust: 'bfq' },
];

interface FetchKLineOptions {
  referenceData?: StockKLineResponse | null;
}

function getMarketId(code: string) {
  return code.startsWith('6') || code.startsWith('9') ? 1 : 0;
}

function normalizeCode(code: string) {
  return code.replace(/\D/g, '').slice(0, 6);
}

function getTencentSymbol(code: string) {
  return `${getMarketId(code) === 1 ? 'sh' : 'sz'}${code}`;
}

function parseEastmoneyKLine(raw: string): KLinePoint {
  const [
    date,
    open,
    close,
    high,
    low,
    volume,
    amount,
    amplitude,
    pctChange,
    change,
    turnover,
  ] = raw.split(',');

  return {
    date,
    open: Number(open),
    close: Number(close),
    high: Number(high),
    low: Number(low),
    volume: Number(volume),
    amount: Number(amount),
    amplitude: Number(amplitude),
    pctChange: Number(pctChange),
    change: Number(change),
    turnover: Number(turnover),
  };
}

function parseTencentKLine(row: string[], previousClose?: string): KLinePoint {
  const [date, open, close, high, low, volume] = row;
  const closeValue = Number(close);
  const previousCloseValue = Number(previousClose);
  const change = Number.isFinite(previousCloseValue) ? closeValue - previousCloseValue : 0;
  const pctChange =
    Number.isFinite(previousCloseValue) && previousCloseValue !== 0
      ? (change / previousCloseValue) * 100
      : 0;
  const highValue = Number(high);
  const lowValue = Number(low);

  return {
    date,
    open: Number(open),
    close: closeValue,
    high: highValue,
    low: lowValue,
    volume: Number(volume),
    amount: 0,
    amplitude:
      Number.isFinite(previousCloseValue) && previousCloseValue !== 0
        ? ((highValue - lowValue) / previousCloseValue) * 100
        : 0,
    pctChange,
    change,
    turnover: 0,
  };
}

export async function fetchKLines(
  rawCode: string,
  period: PeriodType,
  options: FetchKLineOptions = {},
): Promise<StockKLineResponse> {
  const isRemoteWebApp =
    window.location.protocol === 'https:' && window.location.hostname === 'nhtqgm.github.io';

  if (window.eastmoneyApi && !isRemoteWebApp) {
    const candidate = await window.eastmoneyApi.fetchKLines(rawCode, period, options);
    validateQuoteCandidate(candidate, normalizeCode(rawCode));
    validateQuoteConsistency(candidate, options.referenceData);
    return candidate;
  }

  const code = normalizeCode(rawCode);
  if (code.length !== 6) {
    throw new Error('股票代码需要是6位数字');
  }

  const errors: string[] = [];
  for (const source of QUOTE_SOURCES) {
    try {
      const candidate = await fetchFromSource(code, period, source);
      validateQuoteCandidate(candidate, code);
      validateQuoteConsistency(candidate, options.referenceData);
      return candidate;
    } catch (error) {
      errors.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`行情数据请求失败，已尝试${QUOTE_SOURCES.length}个数据源：${errors.join('；')}`);
}

async function fetchFromSource(code: string, period: PeriodType, source: QuoteSource) {
  if (source.provider === 'tencent') {
    return fetchTencentKLines(code, period, source);
  }

  return fetchEastmoneyKLines(code, period, source);
}

async function fetchTencentKLines(
  code: string,
  period: PeriodType,
  source: QuoteSource,
): Promise<StockKLineResponse> {
  const symbol = getTencentSymbol(code);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(
    `${symbol},${TENCENT_PERIOD[period]},,,800,${source.adjust}`,
  )}&_=${Date.now()}`;
  const payload = await requestJson(url);

  if (payload.code !== 0) {
    throw new Error(payload.msg || `code ${payload.code}`);
  }

  const stock = payload.data?.[symbol];
  const key = TENCENT_PERIOD[period];
  const rows = stock?.[key] || stock?.[TENCENT_PERIOD[period]];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('没有返回有效K线');
  }

  return {
    code,
    name: stock?.qt?.[symbol]?.[1] || code,
    market: symbol.startsWith('sh') ? 1 : 0,
    sourceName: source.name,
    sourceProvider: source.provider,
    adjustment: source.adjust,
    points: rows.map((row: string[], index: number) => parseTencentKLine(row, rows[index - 1]?.[2])),
  };
}

async function fetchEastmoneyKLines(
  code: string,
  period: PeriodType,
  source: QuoteSource,
): Promise<StockKLineResponse> {
  const params = new URLSearchParams({
    secid: `${getMarketId(code)}.${code}`,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: String(KLT[period]),
    fqt: '0',
    beg: DEFAULT_BEGIN[period],
    end: '20500101',
    _: String(Date.now()),
  });
  const payload = await requestJson(
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?${params.toString()}`,
  );

  if (payload.rc !== 0 || !payload.data?.klines?.length) {
    throw new Error('没有返回有效K线');
  }

  return {
    code: payload.data.code,
    name: payload.data.name,
    market: payload.data.market,
    sourceName: source.name,
    sourceProvider: source.provider,
    adjustment: source.adjust,
    points: payload.data.klines.map(parseEastmoneyKLine),
  };
}

function validateQuoteCandidate(candidate: StockKLineResponse, expectedCode: string) {
  if (normalizeCode(candidate.code) !== expectedCode) {
    throw new Error(`股票代码不一致：请求 ${expectedCode}，返回 ${candidate.code}`);
  }
  if (candidate.adjustment !== 'bfq') {
    throw new Error('行情复权口径错误：当前版本只允许不复权数据');
  }
  if (!candidate.points.length) throw new Error('没有返回有效K线');

  let previousDate = '';
  candidate.points.forEach((point, index) => {
    if (!isValidDate(point.date) || (previousDate && point.date <= previousDate)) {
      throw new Error(`K线日期无效或未严格递增：第 ${index + 1} 条 ${point.date}`);
    }
    previousDate = point.date;

    const prices = [point.open, point.close, point.high, point.low];
    if (prices.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error(`K线价格无效：${point.date}`);
    }
    if (point.high < Math.max(point.open, point.close, point.low) || point.low > Math.min(point.open, point.close, point.high)) {
      throw new Error(`K线高低价关系无效：${point.date}`);
    }
    if (!Number.isFinite(point.volume) || point.volume < 0) {
      throw new Error(`K线成交量无效：${point.date}`);
    }
  });
}

function validateQuoteConsistency(
  candidate: StockKLineResponse,
  referenceData: StockKLineResponse | null | undefined,
) {
  if (
    !referenceData ||
    referenceData.adjustment !== 'bfq' ||
    normalizeCode(referenceData.code) !== normalizeCode(candidate.code)
  ) {
    return;
  }

  const referenceCloses = new Map(
    referenceData.points
      .filter((point) => Number.isFinite(point.close) && point.close > 0)
      .map((point) => [point.date, point.close]),
  );
  const overlaps = candidate.points
    .flatMap((point) => {
      const referenceClose = referenceCloses.get(point.date);
      return referenceClose === undefined ? [] : [{ date: point.date, close: point.close, referenceClose }];
    })
    .slice(-20);

  const mismatch = overlaps.find(({ close, referenceClose }) =>
    Math.abs(close - referenceClose) > Math.max(0.02, Math.abs(referenceClose) * 0.01),
  );
  if (mismatch) {
    throw new Error(
      `行情一致性校验失败：${mismatch.date} 新数据 ${mismatch.close.toFixed(2)}，已有不复权数据 ${mismatch.referenceClose.toFixed(2)}`,
    );
  }
}

function isValidDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function requestJson(url: string) {
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({
      url,
      headers: {
        Accept: 'application/json,text/plain,*/*',
      },
      connectTimeout: 12000,
      readTimeout: 12000,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}`);
    }

    return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,*/*',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('请求超时');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
