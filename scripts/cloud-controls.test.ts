import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appSource = fs.readFileSync('src/App.tsx', 'utf8');
const supabaseSource = fs.readFileSync('src/utils/supabase.ts', 'utf8');

test('prediction controls use cloud read and cloud save instead of the local cache action', () => {
  assert.doesNotMatch(appSource, />读取缓存</);
  assert.match(appSource, /cloudUser \? '从云端读取' : '登录云端'/);
  assert.match(appSource, />\s*向云端保存\s*</);
  assert.match(appSource, /onClick=\{\(\) => \(cloudUser \? void readCloudPredictions\(\)/);
  assert.match(appSource, /onClick=\{\(\) => void saveCurrentWorkspaceToCloud\(\)\}/);
});

test('cloud-loaded stock codes are offered through a selector next to the stock code input', () => {
  assert.match(appSource, /aria-label="云端预测股票代码"/);
  assert.match(appSource, /cloudStockCodes\.map\(\(code\)/);
  assert.match(appSource, /onChange=\{\(event\) => selectCloudStockCode\(event\.target\.value\)\}/);
});

test('explicit cloud save replaces the remote prediction snapshot instead of flushing appended events', () => {
  assert.match(appSource, /replaceCloudPredictionEvents\(cloudUser, snapshotEvents\)/);
  assert.doesNotMatch(appSource, /const uploaded = await flushCloudOutbox\(cloudUser\)/);
  assert.match(supabaseSource, /\.rpc\('replace_prediction_events'/);
});
