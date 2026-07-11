import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import type { PredictionPoint } from '../src/types.ts';
import {
  createPredictionValueMutations,
  createPredictionValueSaveQueue,
  type CloudPredictionValueMutation,
} from '../src/utils/cloudPredictionStorage.ts';

const scope = { stockCode: '000166', period: 'day' as const };

test('editing one MA produces one independent user prediction mutation', () => {
  const before: PredictionPoint[] = [row('2026-07-10', '9.1000')];
  const after: PredictionPoint[] = [row('2026-07-10', '9.2000')];

  assert.deepEqual(createPredictionValueMutations(scope, before, after), [
    {
      stockCode: '000166',
      period: 'day',
      targetDate: '2026-07-10',
      metric: 'ma40',
      value: '9.2000',
    },
  ]);
});

test('clearing one MA deletes only that exact stored prediction value', () => {
  const before: PredictionPoint[] = [row('2026-07-10', '9.2000')];
  const after: PredictionPoint[] = [row('2026-07-10', '')];

  assert.deepEqual(createPredictionValueMutations(scope, before, after), [
    {
      stockCode: '000166',
      period: 'day',
      targetDate: '2026-07-10',
      metric: 'ma40',
      value: null,
    },
  ]);
});

test('mutation queue coalesces repeated edits of one prediction without discarding another date', async () => {
  const sent: CloudPredictionValueMutation[][] = [];
  const queue = createPredictionValueSaveQueue({
    accountId: 'user-a',
    debounceMs: 0,
    save: async (mutations) => { sent.push(mutations); },
  });

  queue.schedule([
    mutation('2026-07-10', '9.1000'),
    mutation('2026-07-11', '8.8000'),
  ]);
  queue.schedule([mutation('2026-07-10', '9.2000')]);
  await queue.flush();

  assert.deepEqual(sent, [[mutation('2026-07-10', '9.2000'), mutation('2026-07-11', '8.8000')]]);
});

test('normalized migration stores each prediction value separately and does not use a workspace revision', () => {
  const sql = fs.readFileSync('supabase/20260711_normalized_predictions.sql', 'utf8');

  assert.match(sql, /create table if not exists public\.user_prediction_values/i);
  assert.match(sql, /primary key \(user_id, stock_code, period, target_date, metric\)/i);
  assert.match(sql, /create or replace function public\.save_my_prediction_values/i);
  assert.doesNotMatch(
    sql.slice(sql.indexOf('create or replace function public.save_my_prediction_values')),
    /p_expected_revision/i,
  );
});

test('legacy workspace cleanup migration removes the old table and revision RPCs after normalization', () => {
  const sql = fs.readFileSync('supabase/20260711_drop_legacy_workspace.sql', 'utf8');

  assert.match(sql, /drop function if exists public\.get_my_workspace\(\)/i);
  assert.match(sql, /drop function if exists public\.save_my_workspace\(jsonb, bigint\)/i);
  assert.match(sql, /drop function if exists public\.admin_workspace_count\(\)/i);
  assert.match(sql, /drop table if exists public\.user_workspaces/i);
});

test('active app flow reads and writes normalized prediction RPCs instead of the old workspace save RPC', () => {
  const app = fs.readFileSync('src/App.tsx', 'utf8');
  const supabase = fs.readFileSync('src/utils/supabase.ts', 'utf8');

  assert.match(app, /createPredictionValueSaveQueue/);
  assert.match(app, /saveMyPredictionValues\(mutations\)/);
  assert.doesNotMatch(app, /saveMyCloudWorkspace/);
  assert.match(supabase, /rpc\('get_my_prediction_workspace'\)/);
  assert.match(supabase, /rpc\('save_my_prediction_values'/);
});

function row(targetDate: string, ma40: string): PredictionPoint {
  return {
    targetDate,
    predictedMa40: ma40,
    predictedMaValues: ma40 ? { 40: ma40 } : {},
    note: '',
  };
}

function mutation(targetDate: string, value: string): CloudPredictionValueMutation {
  return { stockCode: '000166', period: 'day', targetDate, metric: 'ma40', value };
}
