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

type AdjustType = 'bfq' | 'qfq' | 'hfq';

interface QuoteSource {
  name: string;
  provider: 'tencent' | 'eastmoney';
  adjust: AdjustType;
}

const QUOTE_SOURCES: QuoteSource[] = [
  { name: '腾讯不复权', provider: 'tencent', adjust: 'bfq' },
  { name: '腾讯前复权', provider: 'tencent', adjust: 'qfq' },
  { name: '腾讯后复权', provider: 'tencent', adjust: 'hfq' },
  { name: '东方财富不复权', provider: 'eastmoney', adjust: 'bfq' },
  { name: '东方财富前复权', provider: 'eastmoney', adjust: 'qfq' },
  { name: '东方财富后复权', provider: 'eastmoney', adjust: 'hfq' },
];

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
): Promise<StockKLineResponse> {
  const isRemoteWebApp =
    window.location.protocol === 'https:' && window.location.hostname === 'nhtqgm.github.io';

  if (window.eastmoneyApi && !isRemoteWebApp) {
    return window.eastmoneyApi.fetchKLines(rawCode, period);
  }

  const code = normalizeCode(rawCode);
  if (code.length !== 6) {
    throw new Error('股票代码需要是6位数字');
  }

  const errors: string[] = [];
  for (const source of QUOTE_SOURCES) {
    try {
      return await fetchFromSource(code, period, source);
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
  const key =
    source.adjust === 'bfq' ? TENCENT_PERIOD[period] : `${source.adjust}${TENCENT_PERIOD[period]}`;
  const rows = stock?.[key] || stock?.[TENCENT_PERIOD[period]];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('没有返回有效K线');
  }

  return {
    code,
    name: stock?.qt?.[symbol]?.[1] || code,
    market: symbol.startsWith('sh') ? 1 : 0,
    sourceName: source.name,
    points: rows.map((row: string[], index: number) => parseTencentKLine(row, rows[index - 1]?.[2])),
  };
}

async function fetchEastmoneyKLines(
  code: string,
  period: PeriodType,
  source: QuoteSource,
): Promise<StockKLineResponse> {
  const fqt = source.adjust === 'bfq' ? '0' : source.adjust === 'qfq' ? '1' : '2';
  const params = new URLSearchParams({
    secid: `${getMarketId(code)}.${code}`,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: String(KLT[period]),
    fqt,
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
    points: payload.data.klines.map(parseEastmoneyKLine),
  };
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
