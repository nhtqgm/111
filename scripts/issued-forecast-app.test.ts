import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appSource = fs.readFileSync('src/App.tsx', 'utf8');

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
  assert.match(appSource, /getForecastCloseCell\(row, issuedRow\)/);
  assert.match(appSource, /行情刷新不会改写预测收盘/);
});
