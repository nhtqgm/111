import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { StockKLineResponse } from '../src/types.ts';
import { fetchKLines } from '../src/services/eastmoney.ts';

test('web and bundled EXE fallback sources never switch away from unadjusted prices', () => {
  const webSource = fs.readFileSync('src/services/eastmoney.ts', 'utf8');
  const electronSource = fs.readFileSync('electron/main.cjs', 'utf8');
  const preloadSource = fs.readFileSync('electron/preload.cjs', 'utf8');
  const appSource = fs.readFileSync('src/App.tsx', 'utf8');

  for (const source of [webSource, electronSource]) {
    const quoteSourceBlock = source.slice(
      source.indexOf('const QUOTE_SOURCES'),
      source.indexOf('];', source.indexOf('const QUOTE_SOURCES')) + 2,
    );
    assert.doesNotMatch(quoteSourceBlock, /adjust:\s*['"]qfq['"]|adjust:\s*['"]hfq['"]/);
    assert.equal((quoteSourceBlock.match(/adjust:\s*['"]bfq['"]/g) ?? []).length, 2);
  }

  assert.match(appSource, /fetchKLines\(requestedStockCode,\s*workspacePeriod,\s*\{\s*referenceData:/s);
  assert.match(preloadSource, /fetchKLines:\s*\(code, period, options\).*invoke\([^\n]+options/s);
  assert.match(electronSource, /validateQuoteCandidate\(candidate/);
  assert.match(electronSource, /validateQuoteConsistency\(candidate, options\?\.referenceData\)/);
});

test('invalid Tencent data is rejected and the same-basis Eastmoney source is used', async () => {
  const requests: string[] = [];
  installBrowserGlobals(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('gtimg.cn')) {
      return jsonResponse(tencentPayload([['2026-07-10', '9.00', '-1.00', '9.20', '8.90', '1000']]));
    }
    return jsonResponse(eastmoneyPayload('9.20'));
  });

  const result = await fetchKLines('000166', 'day');

  assert.equal(result.sourceProvider, 'eastmoney');
  assert.equal(result.adjustment, 'bfq');
  assert.equal(result.points.at(-1)?.close, 9.2);
  assert.equal(requests.length, 2);
  assert.equal(requests.some((url) => /qfq|hfq|fqt=1|fqt=2/.test(url)), false);
});

test('a fallback source that disagrees with the existing unadjusted history is rejected', async () => {
  installBrowserGlobals(async (input) => {
    const url = String(input);
    if (url.includes('gtimg.cn')) return jsonResponse({}, 503);
    return jsonResponse(eastmoneyPayload('8.10'));
  });
  const referenceData: StockKLineResponse = {
    code: '000166',
    name: '申万宏源',
    market: 0,
    sourceName: '腾讯不复权',
    sourceProvider: 'tencent',
    adjustment: 'bfq',
    points: [point('2026-07-10', 9.2)],
  };

  await assert.rejects(
    () => fetchKLines('000166', 'day', { referenceData }),
    /行情一致性校验失败/,
  );
});

function installBrowserGlobals(fetchImpl: typeof fetch) {
  Object.assign(globalThis, {
    window: {
      location: { protocol: 'https:', hostname: 'nhtqgm.github.io' },
      setTimeout,
      clearTimeout,
    },
    fetch: fetchImpl,
  });
}

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response);
}

function tencentPayload(rows: string[][]) {
  return {
    code: 0,
    data: {
      sz000166: {
        day: rows,
        qt: { sz000166: ['sz000166', '申万宏源'] },
      },
    },
  };
}

function eastmoneyPayload(close: string) {
  const closeValue = Number(close);
  const high = Math.max(9.3, closeValue).toFixed(2);
  const low = Math.min(8.9, closeValue).toFixed(2);
  return {
    rc: 0,
    data: {
      code: '000166',
      name: '申万宏源',
      market: 0,
      klines: [`2026-07-10,9.00,${close},${high},${low},1000,0,0,0,0,0`],
    },
  };
}

function point(date: string, close: number) {
  return {
    date,
    open: close,
    close,
    high: close,
    low: close,
    volume: 0,
    amount: 0,
    amplitude: 0,
    pctChange: 0,
    change: 0,
    turnover: 0,
  };
}
