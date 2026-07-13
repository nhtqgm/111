const { app, BrowserWindow, ipcMain, shell, net } = require('electron');
const path = require('node:path');
const { createAppStorageStore } = require('./app-storage.cjs');

const KLT = {
  day: 101,
  week: 102,
  month: 103,
};

const TENCENT_PERIOD = {
  day: 'day',
  week: 'week',
  month: 'month',
};

const DEFAULT_BEGIN = {
  day: '20240101',
  week: '20220101',
  month: '20150101',
};

const REMOTE_APP_URL = 'https://nhtqgm.github.io/111/';
let appStorageStore = null;

const QUOTE_SOURCES = [
  { name: '腾讯不复权', provider: 'tencent', adjust: 'bfq' },
  { name: '东方财富不复权', provider: 'eastmoney', adjust: 'bfq' },
];

function getMarketId(code) {
  return code.startsWith('6') || code.startsWith('9') ? 1 : 0;
}

function normalizeCode(code) {
  return String(code ?? '').replace(/\D/g, '').slice(0, 6);
}

function parseKLine(raw) {
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

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    };

    const request = net.request({ method: 'GET', url });

    Object.entries(headers).forEach(([key, value]) => {
      request.setHeader(key, value);
    });

    const timeout = setTimeout(() => {
      request.abort();
      finish(new Error('Eastmoney request timed out. Please check the network.'));
    }, 12000);

    request.on('response', (response) => {
      let body = '';

      response.on('data', (chunk) => {
        body += chunk.toString();
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish(new Error(`Eastmoney request failed: ${response.statusCode}`));
          return;
        }

        try {
          finish(null, JSON.parse(body));
        } catch (error) {
          finish(new Error('Eastmoney returned invalid JSON'));
        }
      });
    });

    request.on('error', (error) => {
      finish(error);
    });
    request.end();
  });
}

function checkRemoteApp() {
  return getJson(`${REMOTE_APP_URL}version.json?_=${Date.now()}`, {
    Accept: 'application/json,text/plain,*/*',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 Chrome/108.0 Safari/537.36',
  }).then((payload) => payload && payload.app === 'gupiao-ma40');
}

function parseEastmoneyPayload(payload) {
  if (payload.rc !== 0 || !payload.data?.klines?.length) {
    throw new Error('Eastmoney returned no valid K-line data.');
  }

  return {
    code: payload.data.code,
    name: payload.data.name,
    market: payload.data.market,
    points: payload.data.klines.map(parseKLine),
  };
}

function getTencentSymbol(code) {
  return `${code.startsWith('6') || code.startsWith('9') ? 'sh' : 'sz'}${code}`;
}

function parseTencentKLine(row, previousClose) {
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

function parseTencentPayload(payload, code, period) {
  return parseTencentPayloadWithSource(payload, code, period, {
    name: '腾讯不复权',
    provider: 'tencent',
    adjust: 'bfq',
  });
}

function parseTencentPayloadWithSource(payload, code, period, source) {
  if (payload.code !== 0) {
    throw new Error(`Tencent quote request failed: ${payload.msg || payload.code}`);
  }

  const symbol = getTencentSymbol(code);
  const stock = payload.data?.[symbol];
  const key = TENCENT_PERIOD[period];
  const rows = stock?.[key] || stock?.[TENCENT_PERIOD[period]];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Tencent returned no valid K-line data.');
  }

  return {
    code,
    name: stock?.qt?.[symbol]?.[1] || code,
    market: symbol.startsWith('sh') ? 1 : 0,
    sourceName: source.name,
    sourceProvider: source.provider ?? 'tencent',
    adjustment: source.adjust,
    points: rows.map((row, index) => parseTencentKLine(row, rows[index - 1]?.[2])),
  };
}

async function fetchTencentKLines(code, period, source = { name: '腾讯不复权', provider: 'tencent', adjust: 'bfq' }) {
  const symbol = getTencentSymbol(code);
  const params = `${symbol},${TENCENT_PERIOD[period]},,,800,${source.adjust}`;
  const payload = await getJson(
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(params)}&_=${Date.now()}`,
    {
      Referer: 'https://gu.qq.com/',
      Accept: 'application/json,text/plain,*/*',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 Chrome/108.0 Safari/537.36',
    },
  );

  return parseTencentPayloadWithSource(payload, code, period, source);
}

async function fetchEastmoneyKLines(code, period, source) {
  const market = getMarketId(code);
  const params = new URLSearchParams({
    secid: `${market}.${code}`,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: String(KLT[period]),
    fqt: '0',
    beg: DEFAULT_BEGIN[period],
    end: '20500101',
    _: String(Date.now()),
  });

  const payload = await getJson(
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?${params.toString()}`,
    {
      Referer: 'https://quote.eastmoney.com/',
      Accept: 'application/json,text/plain,*/*',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 Chrome/108.0 Safari/537.36',
    },
  );
  const parsed = parseEastmoneyPayload(payload);
  return {
    ...parsed,
    sourceName: source.name,
    sourceProvider: source.provider,
    adjustment: source.adjust,
  };
}

function validateQuoteCandidate(candidate, expectedCode) {
  if (normalizeCode(candidate.code) !== expectedCode) {
    throw new Error(`Quote stock code mismatch: requested ${expectedCode}, received ${candidate.code}`);
  }
  if (candidate.adjustment !== 'bfq') {
    throw new Error('Quote adjustment mismatch: only unadjusted prices are allowed.');
  }
  if (!Array.isArray(candidate.points) || candidate.points.length === 0) {
    throw new Error('Quote source returned no valid K-line data.');
  }

  let previousDate = '';
  candidate.points.forEach((point, index) => {
    if (!isValidDate(point.date) || (previousDate && point.date <= previousDate)) {
      throw new Error(`Invalid or unordered K-line date at row ${index + 1}: ${point.date}`);
    }
    previousDate = point.date;

    const prices = [point.open, point.close, point.high, point.low];
    if (prices.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error(`Invalid K-line price at ${point.date}.`);
    }
    if (point.high < Math.max(point.open, point.close, point.low) || point.low > Math.min(point.open, point.close, point.high)) {
      throw new Error(`Invalid K-line high/low relationship at ${point.date}.`);
    }
    if (!Number.isFinite(point.volume) || point.volume < 0) {
      throw new Error(`Invalid K-line volume at ${point.date}.`);
    }
  });
}

function validateQuoteConsistency(candidate, referenceData) {
  if (
    !referenceData ||
    referenceData.adjustment !== 'bfq' ||
    normalizeCode(referenceData.code) !== normalizeCode(candidate.code) ||
    !Array.isArray(referenceData.points)
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
      `Quote consistency check failed at ${mismatch.date}: new ${mismatch.close.toFixed(2)}, existing unadjusted ${mismatch.referenceClose.toFixed(2)}.`,
    );
  }
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function fetchKLines(_event, rawCode, period, options = {}) {
  const code = normalizeCode(rawCode);
  if (code.length !== 6) {
    throw new Error('Stock code must be 6 digits.');
  }

  if (!Object.prototype.hasOwnProperty.call(KLT, period)) {
    throw new Error('Unsupported K-line period.');
  }

  const errors = [];
  for (const source of QUOTE_SOURCES) {
    try {
      let candidate;
      if (source.provider === 'tencent') {
        candidate = await fetchTencentKLines(code, period, source);
      } else {
        candidate = await fetchEastmoneyKLines(code, period, source);
      }
      validateQuoteCandidate(candidate, code);
      validateQuoteConsistency(candidate, options?.referenceData);
      return candidate;
    } catch (error) {
      errors.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Quote data request failed after ${QUOTE_SOURCES.length} sources: ${errors.join('; ')}`);
}

async function migrateLegacyBundledStorage(mainWindow, localIndex) {
  if (!appStorageStore || !(await appStorageStore.needsLegacyMigration())) return true;

  try {
    await mainWindow.loadFile(localIndex);
    const snapshot = await mainWindow.webContents.executeJavaScript(`(() => {
      const result = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key || (!key.startsWith('prediction-ma40:') && !key.startsWith('prediction-ma:'))) continue;
        const value = localStorage.getItem(key);
        if (value !== null) result[key] = value;
      }
      return result;
    })()`);
    await appStorageStore.completeLegacyMigration(snapshot);
    return true;
  } catch (error) {
    console.error('Legacy app storage migration failed:', error);
    return false;
  }
}

async function createWindow() {
  const mainWindow = new BrowserWindow({
    show: false,
    width: 1440,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#eee7dc',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  await loadApp(mainWindow);
  mainWindow.show();
}

async function loadApp(mainWindow) {
  const localIndex = path.join(__dirname, '..', 'dist', 'index.html');

  if (!app.isPackaged) {
    await mainWindow.loadFile(localIndex);
    return;
  }

  const migrationReady = await migrateLegacyBundledStorage(mainWindow, localIndex);
  if (!migrationReady) {
    await mainWindow.loadFile(localIndex);
    return;
  }

  try {
    const remoteReady = await checkRemoteApp();
    if (remoteReady) {
      await mainWindow.loadURL(`${REMOTE_APP_URL}?_=${Date.now()}`);
      return;
    }
  } catch {
    // Fall back to bundled files when the remote app is unavailable.
  }

  await mainWindow.loadFile(localIndex);
}

function assertTrustedRenderer(event) {
  const rendererUrl = event.senderFrame?.url || event.sender.getURL();
  if (rendererUrl.startsWith('file://') || rendererUrl.startsWith(REMOTE_APP_URL)) return;
  throw new Error('Untrusted renderer cannot access application storage.');
}

app.whenReady().then(async () => {
  appStorageStore = createAppStorageStore(path.join(app.getPath('userData'), 'app-data'));
  ipcMain.handle('eastmoney:fetchKLines', fetchKLines);
  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:openExternal', (_event, url) => {
    const target = String(url ?? '');
    if (!/^https:\/\/(github\.com|nhtqgm\.github\.io)\//.test(target)) {
      throw new Error('Unsupported update URL.');
    }
    return shell.openExternal(target);
  });
  ipcMain.handle('app-storage:bootstrap', async (event, storage) => {
    assertTrustedRenderer(event);
    return appStorageStore.bootstrap(storage);
  });
  ipcMain.handle('app-storage:save', async (event, storage) => {
    assertTrustedRenderer(event);
    await appStorageStore.replace(storage);
  });
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
