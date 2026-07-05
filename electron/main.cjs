const { app, BrowserWindow, ipcMain, shell, net } = require('electron');
const path = require('node:path');

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

const QUOTE_SOURCES = [
  { name: '腾讯不复权', provider: 'tencent', adjust: 'bfq' },
  { name: '腾讯前复权', provider: 'tencent', adjust: 'qfq' },
  { name: '腾讯后复权', provider: 'tencent', adjust: 'hfq' },
  { name: '东方财富不复权', provider: 'eastmoney', adjust: 'bfq' },
  { name: '东方财富前复权', provider: 'eastmoney', adjust: 'qfq' },
  { name: '东方财富后复权', provider: 'eastmoney', adjust: 'hfq' },
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
    name: '腾讯前复权',
    adjust: 'qfq',
  });
}

function parseTencentPayloadWithSource(payload, code, period, source) {
  if (payload.code !== 0) {
    throw new Error(`Tencent quote request failed: ${payload.msg || payload.code}`);
  }

  const symbol = getTencentSymbol(code);
  const stock = payload.data?.[symbol];
  const key = source.adjust === 'bfq' ? TENCENT_PERIOD[period] : `${source.adjust}${TENCENT_PERIOD[period]}`;
  const rows = stock?.[key] || stock?.[TENCENT_PERIOD[period]];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Tencent returned no valid K-line data.');
  }

  return {
    code,
    name: stock?.qt?.[symbol]?.[1] || code,
    market: symbol.startsWith('sh') ? 1 : 0,
    sourceName: source.name,
    points: rows.map((row, index) => parseTencentKLine(row, rows[index - 1]?.[2])),
  };
}

async function fetchTencentKLines(code, period, source = { name: '腾讯前复权', adjust: 'qfq' }) {
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
  const fqt = source.adjust === 'bfq' ? '0' : source.adjust === 'qfq' ? '1' : '2';
  const market = getMarketId(code);
  const params = new URLSearchParams({
    secid: `${market}.${code}`,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: String(KLT[period]),
    fqt,
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
  };
}

async function fetchKLines(_event, rawCode, period) {
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
      if (source.provider === 'tencent') {
        return await fetchTencentKLines(code, period, source);
      }
      return await fetchEastmoneyKLines(code, period, source);
    } catch (error) {
      errors.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Quote data request failed after ${QUOTE_SOURCES.length} sources: ${errors.join('; ')}`);
}

function createWindow() {
  const mainWindow = new BrowserWindow({
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
  loadApp(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

async function loadApp(mainWindow) {
  const localIndex = path.join(__dirname, '..', 'dist', 'index.html');

  if (!app.isPackaged) {
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

app.whenReady().then(() => {
  ipcMain.handle('eastmoney:fetchKLines', fetchKLines);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
