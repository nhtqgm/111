import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { KLinePoint, PeriodType, StockKLineResponse } from '../types';

const KLT: Record<PeriodType, number> = {
  day: 101,
  week: 102,
  month: 103,
};

const DEFAULT_BEGIN: Record<PeriodType, string> = {
  day: '20240101',
  week: '20220101',
  month: '20150101',
};

function getMarketId(code: string) {
  return code.startsWith('6') || code.startsWith('9') ? 1 : 0;
}

function normalizeCode(code: string) {
  return code.replace(/\D/g, '').slice(0, 6);
}

function parseKLine(raw: string): KLinePoint {
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

export async function fetchKLines(
  rawCode: string,
  period: PeriodType,
): Promise<StockKLineResponse> {
  if (window.eastmoneyApi) {
    return window.eastmoneyApi.fetchKLines(rawCode, period);
  }

  const code = normalizeCode(rawCode);
  if (code.length !== 6) {
    throw new Error('股票代码需要是6位数字');
  }

  const market = getMarketId(code);
  const params = new URLSearchParams({
    secid: `${market}.${code}`,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: String(KLT[period]),
    fqt: '1',
    beg: DEFAULT_BEGIN[period],
    end: '20500101',
    _: String(Date.now()),
  });
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?${params.toString()}`;

  if (Capacitor.isNativePlatform()) {
    return fetchKLinesNative(url);
  }

  return fetchKLinesViaBrowserProxy(params);
}

async function fetchKLinesNative(url: string) {
  try {
    const response = await CapacitorHttp.get({
      url,
      headers: {
        Referer: 'https://quote.eastmoney.com/',
      },
      connectTimeout: 12000,
      readTimeout: 12000,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`东方财富请求失败：${response.status}`);
    }

    return parsePayload(response.data);
  } catch (error) {
    throw new Error(`东方财富请求失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fetchKLinesViaBrowserProxy(params: URLSearchParams) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);

  let response: Response;
  try {
    response = await fetch(`/eastmoney/api/qt/stock/kline/get?${params.toString()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('东方财富请求超时，请确认网络正常后刷新页面');
    }
    throw new Error(`东方财富请求失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    window.clearTimeout(timeout);
  }

  if (!response.ok) throw new Error(`东方财富请求失败：${response.status}`);

  return parsePayload(await response.json());
}

function parsePayload(payload: any): StockKLineResponse {
  if (payload.rc !== 0 || !payload.data?.klines?.length) {
    throw new Error('东方财富没有返回有效K线数据');
  }

  return {
    code: payload.data.code,
    name: payload.data.name,
    market: payload.data.market,
    points: payload.data.klines.map(parseKLine),
  };
}
