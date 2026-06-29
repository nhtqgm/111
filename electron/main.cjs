const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');

const KLT = {
  day: 101,
  week: 102,
  month: 103,
};

const DEFAULT_BEGIN = {
  day: '20240101',
  week: '20220101',
  month: '20150101',
};

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

async function fetchKLines(_event, rawCode, period) {
  const code = normalizeCode(rawCode);
  if (code.length !== 6) {
    throw new Error('股票代码需要是6位数字');
  }

  if (!Object.hasOwn(KLT, period)) {
    throw new Error('不支持的K线周期');
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?${params.toString()}`,
      {
        headers: {
          Referer: 'https://quote.eastmoney.com/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 AppleWebKit/537.36',
        },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      throw new Error(`东方财富请求失败：${response.status}`);
    }

    const payload = await response.json();
    if (payload.rc !== 0 || !payload.data?.klines?.length) {
      throw new Error('东方财富没有返回有效K线数据');
    }

    return {
      code: payload.data.code,
      name: payload.data.name,
      market: payload.data.market,
      points: payload.data.klines.map(parseKLine),
    };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error('东方财富请求超时，请确认电脑可以正常联网');
    }
    throw new Error(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
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
  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
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
