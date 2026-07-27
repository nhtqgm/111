import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import type { PredictionPoint } from '../src/types.ts';
import type { ForecastHistorySnapshot } from '../src/utils/forecastHistory.ts';
import {
  clearWorkspaceForecastScope,
  createEmptyCloudWorkspace,
  getWorkspaceForecastHistory,
  getWorkspacePredictions,
  hasPredictionDraftContent,
  setWorkspaceForecastHistory,
  setWorkspacePredictions,
} from '../src/utils/cloudWorkspace.ts';

const resetScope = { stockCode: '000166', period: 'month' as const };
const otherPeriod = { stockCode: '000166', period: 'day' as const };
const otherStock = { stockCode: '688571', period: 'month' as const };

test('workspace reset removes only the selected stock and period', () => {
  let workspace = createEmptyCloudWorkspace();
  workspace = setWorkspacePredictions(workspace, resetScope, predictionRows('9.1000'));
  workspace = setWorkspaceForecastHistory(workspace, resetScope, [history(resetScope, 'reset-history')]);
  workspace = setWorkspacePredictions(workspace, otherPeriod, predictionRows('8.1000'));
  workspace = setWorkspaceForecastHistory(workspace, otherPeriod, [history(otherPeriod, 'other-period')]);
  workspace = setWorkspacePredictions(workspace, otherStock, predictionRows('7.1000'));
  workspace = setWorkspaceForecastHistory(workspace, otherStock, [history(otherStock, 'other-stock')]);

  const cleared = clearWorkspaceForecastScope(workspace, resetScope);

  assert.deepEqual(getWorkspacePredictions(cleared, resetScope), []);
  assert.deepEqual(getWorkspaceForecastHistory(cleared, resetScope), []);
  assert.deepEqual(getWorkspacePredictions(cleared, otherPeriod), predictionRows('8.1000'));
  assert.equal(getWorkspaceForecastHistory(cleared, otherPeriod)[0].id, 'other-period');
  assert.deepEqual(getWorkspacePredictions(cleared, otherStock), predictionRows('7.1000'));
  assert.equal(getWorkspaceForecastHistory(cleared, otherStock)[0].id, 'other-stock');
  assert.equal(Object.hasOwn(cleared.predictions, '000166:month'), false);
  assert.equal(Object.hasOwn(cleared.forecastHistory, '000166:month'), false);
  assert.equal(Object.hasOwn(workspace.predictions, '000166:month'), true, 'input remains immutable');
});

test('blank hydrated rows do not recreate an empty prediction scope after reset', () => {
  const blankRows: PredictionPoint[] = [{
    targetDate: '2026-08-31',
    predictedMa40: '',
    predictedMaValues: {},
    note: '',
  }];
  const workspace = setWorkspacePredictions(createEmptyCloudWorkspace(), resetScope, blankRows);

  assert.equal(hasPredictionDraftContent(blankRows), false);
  assert.equal(Object.hasOwn(workspace.predictions, '000166:month'), false);
});

test('cloud reset RPC is authenticated, account-bound, scoped, and atomic across all prediction tables', () => {
  const sql = fs.readFileSync('supabase/20260727_reset_forecast_scope.sql', 'utf8');
  const bodyStart = sql.indexOf('create or replace function public.reset_my_forecast_scope_v1');
  const bodyEnd = sql.indexOf('\n$$;', bodyStart);
  const body = sql.slice(bodyStart, bodyEnd);

  assert.match(body, /v_user_id uuid := auth\.uid\(\)/i);
  assert.match(body, /p_expected_user_id is distinct from v_user_id/i);
  assert.match(body, /p_stock_code !~ '\^\\d\{6\}\$'/i);
  assert.match(body, /p_period not in \('day', 'week', 'month'\)/i);
  for (const table of [
    'user_prediction_values',
    'user_forecast_history',
    'user_issued_forecast_batches',
  ]) {
    assert.match(
      body,
      new RegExp(
        `delete from public\\.${table}[\\s\\S]{0,180}` +
          'user_id = v_user_id[\\s\\S]{0,100}' +
          'stock_code = p_stock_code[\\s\\S]{0,100}' +
          'period = p_period',
        'i',
      ),
      table,
    );
  }
  assert.doesNotMatch(body, /delete from public\.(?:user_stock_codes|user_workspace_preferences)/i);
  assert.match(body, /lock table public\.user_issued_forecast_batches in share row exclusive mode/i);
  assert.match(body, /lock table public\.user_forecast_history in share row exclusive mode/i);
  assert.match(body, /lock table public\.user_prediction_values in share row exclusive mode/i);
  assert.ok(
    body.indexOf('lock table public.user_issued_forecast_batches') <
      body.indexOf('lock table public.user_prediction_values'),
  );
  assert.ok(
    body.indexOf('lock table public.user_prediction_values') <
      body.indexOf('lock table public.user_forecast_history'),
  );
  assert.match(sql, /revoke all on function public\.reset_my_forecast_scope_v1\(text, text, uuid\)\s+from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.reset_my_forecast_scope_v1\(text, text, uuid\)\s+to authenticated/i);
  assert.equal(body.includes('commit;'), false, 'all deletes share the RPC transaction');
});

test('app reset flushes durable queues and clears draft, history, and every issued revision only after RPC success', () => {
  const app = fs.readFileSync('src/App.tsx', 'utf8');
  const supabase = fs.readFileSync('src/utils/supabase.ts', 'utf8');
  const start = app.indexOf('  async function doResetRows()');
  const end = app.indexOf('\n  function exportAllData()', start);
  const reset = app.slice(start, end);
  const rpcIndex = reset.indexOf('await resetMyForecastScopeV1(');

  assert.notEqual(rpcIndex, -1);
  assert.ok(reset.indexOf('cloudPredictionSaveQueueRef.current?.flush()') < rpcIndex);
  assert.ok(reset.indexOf('cloudHistorySaveQueueRef.current?.flush()') < rpcIndex);
  assert.ok(reset.indexOf('getLastError()') < rpcIndex);
  assert.ok(reset.indexOf('clearWorkspaceForecastScope(') > rpcIndex);
  assert.ok(reset.indexOf('setForecastHistory([])') > rpcIndex);
  assert.ok(reset.indexOf('setIssuedForecastBatches(') > rpcIndex);
  assert.match(reset, /batch\.stockCode !== resetScope\.stockCode \|\| batch\.period !== resetScope\.period/);
  assert.doesNotMatch(reset, /persistPredictionDraft\(/);
  assert.match(app, /草稿、历史对比以及所有 MA 的已提交锁定版本都会从云端删除/);
  assert.match(app, /disabled=\{isResettingForecastScope \|\| isIssuingForecast\}/);
  assert.match(supabase, /!Array\.isArray\(data\) \|\| data\.length !== 1/);
  assert.match(supabase, /requireDeletedCount\(row, 'prediction_values_deleted'\)/);
  assert.match(supabase, /!Number\.isSafeInteger\(count\) \|\| count < 0/);
});

function predictionRows(value: string): PredictionPoint[] {
  return [{
    targetDate: '2026-08-31',
    predictedMa40: value,
    predictedMaValues: { 40: value },
    note: '',
  }];
}

function history(
  scope: { stockCode: string; period: 'day' | 'week' | 'month' },
  id: string,
): ForecastHistorySnapshot {
  return {
    schema: 'gupiao-forecast-history/v1',
    id,
    stockCode: scope.stockCode,
    period: scope.period,
    targetDate: '2026-08-31',
    inputMaWindow: 40,
    inputMaValue: 9.1,
    predictedClose: 9.2,
    predictedMaValues: { 5: 9, 10: 9, 20: 9, 40: 9.1, 60: 9 },
    note: '',
    savedAt: '2026-07-27T10:00:00.000Z',
  };
}
