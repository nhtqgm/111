import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appSource = fs.readFileSync('src/App.tsx', 'utf8');
const supabaseSource = fs.readFileSync('src/utils/supabase.ts', 'utf8');

test('prediction controls separate immutable submission from cloud draft saving', () => {
  assert.doesNotMatch(appSource, />读取缓存</);
  assert.match(appSource, /cloudUser \? '从云端读取' : '登录云端'/);
  assert.match(appSource, /isIssuingForecast \? '正在云端锁定…' : '提交并锁定'/);
  assert.match(appSource, />\s*保存草稿\s*</);
  assert.match(appSource, /onClick=\{requestIssueCurrentForecast\}/);
  assert.match(appSource, /onClick=\{\(\) => \(cloudUser \? void readCloudPredictions\(\)/);
  assert.match(appSource, /onClick=\{\(\) => void saveCurrentWorkspaceToCloud\(\)\}/);
});

test('cloud-loaded stock codes are offered through a selector next to the stock code input', () => {
  assert.match(appSource, /aria-label="云端预测股票代码"/);
  assert.match(appSource, /cloudStockCodes\.map\(\(code\)/);
  assert.match(appSource, /onChange=\{\(event\) => selectCloudStockCode\(event\.target\.value\)\}/);
});

test('every signed-in account gets its stock selector from the database registry', () => {
  assert.match(appSource, /loadMyStockCodes\(\)/);
  assert.match(appSource, /setCloudStockCodes\(remoteStockCodes\)/);
  assert.match(supabaseSource, /rpc\('get_my_stock_codes'\)/);
  assert.doesNotMatch(appSource, /collectCloudStockCodes|loadStoredStockCodes|rememberStockCodes/);
});

test('manual cloud save flushes durable prediction and history queues and verifies the readback', () => {
  const activeSave = appSource.slice(
    appSource.lastIndexOf('  async function saveCurrentWorkspaceToCloud()'),
    appSource.indexOf('  async function submitCloudAccount'),
  );
  assert.match(activeSave, /cloudPredictionSaveQueueRef\.current\?\.flush\(\)/);
  assert.match(activeSave, /cloudHistorySaveQueueRef\.current\?\.flush\(\)/);
  assert.match(activeSave, /assertCloudWorkspaceContainsLocalData\(workspace, verifiedRecord\.payload\)/);
  assert.doesNotMatch(activeSave, /replaceMyCloudWorkspace\(/);
  assert.match(supabaseSource, /\.rpc\('save_my_prediction_values'/);
});
