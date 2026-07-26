import { Capacitor } from '@capacitor/core';
import { getMarketId, requestJson } from './eastmoney';
import {
  parseSuggestPayload,
  parseUlistPayload,
  SUPPORTED_STOCK_CODE,
  type StockSuggestion,
} from '../utils/stockSearchParsing';

export type { StockSuggestion };

const SUGGEST_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';

let jsonpCounter = 0;

/**
 * searchapi.eastmoney.com 不返回 CORS 头，网页端与 Electron 壳只能走 JSONP；
 * 安卓端 CapacitorHttp 是原生请求，不受 CORS 限制，直接取 JSON。
 */
function jsonpRequest(baseUrl: string, timeoutMs = 8000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    jsonpCounter += 1;
    const callbackName = `__gupiaoJsonp_${Date.now()}_${jsonpCounter}`;
    const script = document.createElement('script');
    const globalScope = window as unknown as Record<string, unknown>;

    const cleanup = () => {
      window.clearTimeout(timer);
      delete globalScope[callbackName];
      script.remove();
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('请求超时'));
    }, timeoutMs);

    globalScope[callbackName] = (payload: unknown) => {
      cleanup();
      resolve(payload);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error('请求失败'));
    };
    script.src = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}cb=${callbackName}`;
    document.head.appendChild(script);
  });
}

export async function searchStocks(keyword: string): Promise<StockSuggestion[]> {
  const trimmed = keyword.trim();
  if (!trimmed) return [];

  const url =
    'https://searchapi.eastmoney.com/api/suggest/get' +
    `?input=${encodeURIComponent(trimmed)}&type=14&token=${SUGGEST_TOKEN}&count=20`;
  const payload = Capacitor.isNativePlatform() ? await requestJson(url) : await jsonpRequest(url);
  return parseSuggestPayload(payload);
}

async function fetchNamesViaUlist(codes: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let index = 0; index < codes.length; index += 50) {
    const secids = codes
      .slice(index, index + 50)
      .map((code) => `${getMarketId(code)}.${code}`)
      .join(',');
    const url =
      'https://push2.eastmoney.com/api/qt/ulist.np/get' +
      `?secids=${secids}&fields=f12,f14&fltt=2&_=${Date.now()}`;
    const payload = await requestJson(url);
    parseUlistPayload(payload).forEach((name, code) => names.set(code, name));
  }
  return names;
}

/**
 * 批量把 6 位代码解析为股票名称。
 * 优先 push2 批量接口（正式网页域名 CORS 放行、安卓原生请求可用）；
 * 该接口拒绝 JSONP 且对部分环境不放行 CORS，失败或漏解析时逐码退回联想接口。
 */
export async function fetchStockNames(codes: string[]): Promise<Map<string, string>> {
  const valid = Array.from(new Set(codes.filter((code) => SUPPORTED_STOCK_CODE.test(code))));
  if (!valid.length) return new Map();

  const names = await fetchNamesViaUlist(valid).catch(() => new Map<string, string>());
  const missing = valid.filter((code) => !names.has(code));
  for (const code of missing.slice(0, 30)) {
    try {
      const match = (await searchStocks(code)).find((item) => item.code === code);
      if (match) names.set(code, match.name);
    } catch {
      break; // 网络不可用时立即止损，等下次触发再补
    }
  }
  return names;
}
