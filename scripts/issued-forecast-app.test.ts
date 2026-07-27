import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appSource = fs.readFileSync('src/App.tsx', 'utf8');
const stylesSource = fs.readFileSync('src/styles.css', 'utf8');

function sliceFunction(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('issued forecasts are created only by the explicit submit action', () => {
  const issueFunction = sliceFunction(
    appSource,
    '  async function issueCurrentForecast()',
    '  function persistPredictionDraft(',
  );

  assert.match(appSource, /onClick=\{requestIssueCurrentForecast\}/);
  assert.match(issueFunction, /createIssuedForecastBatch\(/);
  assert.match(issueFunction, /await saveMyIssuedForecastBatchV2\(batch\)/);
  assert.match(issueFunction, /const sessionGeneration = cloudSessionGenerationRef\.current/);
  assert.match(issueFunction, /if \(sessionGeneration !== cloudSessionGenerationRef\.current\) return/);
  assert.match(issueFunction, /issuedForecastBatchToHistorySnapshots\(savedBatch\)/);
  assert.match(issueFunction, /setIssuedForecastBatches/);
  assert.doesNotMatch(issueFunction, /appendIssuedForecastBatch|scheduleCloudHistorySave|persistPredictionDraft/);
});

test('issued forecasts load only from the dedicated cloud RPC and clear on logout', () => {
  assert.match(appSource, /loadMyIssuedForecastBatchesV2\(\)/);
  assert.match(appSource, /setIssuedForecastBatches\(remoteIssuedBatches\)/);
  assert.match(appSource, /setIssuedForecastBatches\(\[\]\)/);
  assert.doesNotMatch(appSource, /appendIssuedForecastBatch|loadIssuedForecastBatches|recoverIssuedForecastBatches/);
});

test('history and summary use only the server-selected issued revision', () => {
  assert.match(appSource, /filter\(\(snapshot\) => !isIssuedForecastSnapshot\(snapshot\)\)/);
  assert.match(appSource, /const canonicalIssuedSnapshots = activeIssuedBatch/);
  assert.match(appSource, /savedAt: activeIssuedBatch\.serverPersistedAt \?\? snapshot\.savedAt/);
});

test('draft saving and market refresh never issue or overwrite a submitted forecast', () => {
  const draftSave = sliceFunction(
    appSource,
    '  function saveCurrentWorkspace({',
    '  const projection = useMemo(',
  );
  const marketRefresh = sliceFunction(
    appSource,
    '  async function refreshHistoricalData(',
    '  async function performHistoricalDataRefresh(',
  );

  assert.match(draftSave, /persistPredictionDraft\(predictions\)/);
  assert.doesNotMatch(draftSave, /createIssuedForecastBatch|saveMyIssuedForecastBatchV2/);
  assert.doesNotMatch(marketRefresh, /createIssuedForecastBatch|saveMyIssuedForecastBatchV2/);
});

test('the UI distinguishes frozen, provisional, effective, and actual values', () => {
  assert.match(appSource, /已提交预测收盘（锁定）/);
  assert.match(appSource, /实时暂估收盘（未收盘）/);
  assert.match(appSource, /真实收盘价（已收盘）/);
  assert.match(appSource, /实时暂估MA\$\{windowSize\}/);
  assert.match(appSource, />锁定预测</);
  assert.match(appSource, />收盘状态</);
  assert.match(appSource, />有效MA</);
  assert.match(appSource, /getForecastCloseCell\(\s*row,\s*issuedRow,\s*historyRow,\s*actualCloseContext,\s*\)/);
  assert.match(appSource, /行情刷新不会改写预测收盘/);
});

test('the sidebar table stays compact and keeps detailed MA columns in the expanded table', () => {
  const renderTable = sliceFunction(
    appSource,
    '  function renderPredictionTable(',
    '  if (!isCloudSyncConfigured()) {',
  );

  assert.match(appSource, /gridTemplateColumns: '92px 94px 72px 100px 64px 44px'/);
  assert.match(stylesSource, /grid-template-columns: 92px 94px 72px 100px 64px 44px;/);
  assert.match(appSource, /minWidth: '481px'/);
  assert.match(appSource, /minWidth: `\$\{548 \+ visibleMaWindows\.length \* 72\}px`/);
  assert.match(renderTable, /expanded \? 'expanded-table' : 'compact-table'/);
  assert.match(renderTable, /expanded\s+\?\s+visibleMaWindows\.map/g);
  assert.match(stylesSource, /\.prediction-table\s*\{[\s\S]*?align-content: start;[\s\S]*?gap: 0;/);
  assert.match(stylesSource, /\.prediction-row\.table-head > \.date-column\s*\{[\s\S]*?padding-left: 17px;/);
  assert.match(stylesSource, /\.ma40-table \.date-cell::before\s*\{[\s\S]*?flex: 0 0 7px;/);
  assert.match(stylesSource, /\.table-modal \.prediction-row:not\(\.table-head\)\s*\{[\s\S]*?min-height: 44px;/);
  assert.match(stylesSource, /@media \(pointer: coarse\)[\s\S]*?\.settled-ma-value\s*\{[\s\S]*?min-height: 42px;/);
  assert.match(stylesSource, /@media \(pointer: coarse\)[\s\S]*?\.close-status-cell\s*\{[\s\S]*?height: 42px;/);
});

test('real K-lines are visible by default and reset restores that view', () => {
  const resetFunction = sliceFunction(
    appSource,
    '  async function doResetRows()',
    '  function exportAllData()',
  );

  assert.match(appSource, /useState\(true\);[\s\S]*?setShowActualMaLines/);
  assert.match(resetFunction, /setShowActualMaLines\(true\)/);
  assert.match(appSource, /\{showActualMaLines \? '只看预测线' : '显示真实K线'\}/);
  assert.match(appSource, /showActualKLine=\{showActualMaLines\}/);
});

test('legacy history uses the same recorded close in the chart and table', () => {
  assert.match(appSource, /buildForecastCloseTableRows\([\s\S]*?chartHistoryRows,/);
  assert.match(appSource, /historyRow,\s*actualCloseContext,/);
  assert.match(appSource, /historyRow\?\.predictedClose/);
  assert.match(appSource, /historyRow\?\.inputMaValue/);
  assert.match(appSource, /historyRow\?\.predictedMaValues\[windowSize\]/);
  assert.match(appSource, /<small aria-label="历史预测记录">历<\/small>/);
});
