import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createEmptyCloudWorkspace, setWorkspaceForecastHistory, setWorkspacePredictions } from '../src/utils/cloudWorkspace.ts';

function row(targetDate: string, value: string) {
  return { targetDate, predictedMa40: value, predictedMaValues: { 40: value }, note: '' };
}

test('full export preserves every stock, period, prediction and forecast history scope', async () => {
  const module = await import('../src/utils/cloudWorkspace.ts');
  assert.equal(typeof module.createFullWorkspaceBackup, 'function');
  assert.equal(typeof module.readFullWorkspaceImport, 'function');

  let workspace = createEmptyCloudWorkspace();
  workspace = setWorkspacePredictions(workspace, { stockCode: '000166', period: 'month' }, [row('2026-08-31', '4.8310')]);
  workspace = setWorkspacePredictions(workspace, { stockCode: '688571', period: 'day' }, [row('2026-07-10', '9.1500')]);
  workspace = setWorkspacePredictions(workspace, { stockCode: '688571', period: 'week' }, [row('2026-07-10', '8.1700')]);
  workspace = setWorkspaceForecastHistory(workspace, { stockCode: '688571', period: 'day' }, [{
    schema: 'gupiao-forecast-history/v1',
    id: '688571:day:2026-07-10:MA40',
    stockCode: '688571',
    period: 'day',
    targetDate: '2026-07-10',
    inputMaWindow: 40,
    inputMaValue: 9.15,
    predictedClose: 9.17,
    predictedMaValues: { 5: 9, 10: 9, 20: 9, 40: 9.15, 60: 9 },
    note: '',
    savedAt: '2026-07-09T12:00:00.000Z',
  }]);

  const backup = module.createFullWorkspaceBackup(workspace, '0.3.0', '2026-07-11T00:00:00.000Z');
  const restored = module.readFullWorkspaceImport(backup);

  assert.deepEqual(Object.keys(restored.predictions).sort(), [
    '000166:month',
    '688571:day',
    '688571:week',
  ]);
  assert.equal(restored.predictions['688571:day'][0].predictedMa40, '9.1500');
  assert.equal(restored.predictions['688571:week'][0].predictedMa40, '8.1700');
  assert.equal(restored.forecastHistory['688571:day'][0].predictedClose, 9.17);
});

test('manual cloud save preserves history while explicit import keeps atomic replacement', () => {
  const appSource = fs.readFileSync('src/App.tsx', 'utf8');
  const supabaseSource = fs.readFileSync('src/utils/supabase.ts', 'utf8');
  const sqlSource = fs.readFileSync('supabase/20260711_replace_prediction_workspace.sql', 'utf8');
  const manualSaveSource = appSource.slice(
    appSource.lastIndexOf('  async function saveCurrentWorkspaceToCloud()'),
    appSource.indexOf('  async function submitCloudAccount'),
  );
  const importSource = appSource.slice(
    appSource.indexOf('  async function importPredictions'),
    appSource.indexOf('  function renderPredictionTable'),
  );

  assert.match(supabaseSource, /replaceMyCloudWorkspace/);
  assert.match(supabaseSource, /rpc\('replace_my_prediction_workspace'/);
  assert.doesNotMatch(manualSaveSource, /replaceMyCloudWorkspace\(/);
  assert.match(manualSaveSource, /cloudHistorySaveQueueRef\.current\?\.flush\(\)/);
  assert.match(manualSaveSource, /assertCloudWorkspaceContainsLocalData\(workspace, verifiedRecord\.payload\)/);
  assert.match(importSource, /replaceMyCloudWorkspace\(workspace\)/);
  assert.match(sqlSource, /delete from public\.user_prediction_values/i);
  assert.match(sqlSource, /delete from public\.user_forecast_history/i);
  assert.match(sqlSource, /insert into public\.user_prediction_values/i);
  assert.match(sqlSource, /insert into public\.user_forecast_history/i);
});
