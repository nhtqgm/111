import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import type { PredictionPoint } from '../src/types.ts';
import {
  advancePredictionEditClock,
  createPredictionValueMutations,
  createPredictionValueSaveQueue,
  normalizeRejectedPredictionRows,
  type CloudPredictionValueMutation,
} from '../src/utils/cloudPredictionStorage.ts';

const scope = { stockCode: '000166', period: 'day' as const };

test('editing one MA produces one independent user prediction mutation', () => {
  const before: PredictionPoint[] = [row('2026-07-10', '9.1000')];
  const after: PredictionPoint[] = [row('2026-07-10', '9.2000')];

  assert.deepEqual(
    createPredictionValueMutations(scope, before, after, { editedAt: '2026-07-26T08:00:00.000Z' }),
    [
      {
        stockCode: '000166',
        period: 'day',
        targetDate: '2026-07-10',
        metric: 'ma40',
        value: '9.2000',
        editedAt: '2026-07-26T08:00:00.000Z',
      },
    ],
  );
});

test('every mutation carries a monotonic edit stamp even without an explicit one', () => {
  const before: PredictionPoint[] = [row('2026-07-10', '9.1000')];
  const after: PredictionPoint[] = [row('2026-07-10', '9.2000')];

  const first = createPredictionValueMutations(scope, before, after);
  const second = createPredictionValueMutations(scope, before, after);
  assert.equal(first.length, 1);
  assert.ok(Number.isFinite(Date.parse(first[0]!.editedAt)));
  // Even inside the same millisecond a later edit must stamp strictly later.
  assert.ok(Date.parse(second[0]!.editedAt) > Date.parse(first[0]!.editedAt));
});

test('clearing one MA deletes only that exact stored prediction value', () => {
  const before: PredictionPoint[] = [row('2026-07-10', '9.2000')];
  const after: PredictionPoint[] = [row('2026-07-10', '')];

  assert.deepEqual(
    createPredictionValueMutations(scope, before, after, { editedAt: '2026-07-26T08:00:00.000Z' }),
    [
      {
        stockCode: '000166',
        period: 'day',
        targetDate: '2026-07-10',
        metric: 'ma40',
        value: null,
        editedAt: '2026-07-26T08:00:00.000Z',
      },
    ],
  );
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

test('save queue reports server-rejected stale cells unless the user already re-edited them', async () => {
  const rejectedBatches: CloudPredictionValueMutation[][] = [];
  const survivingCloudValue: CloudPredictionValueMutation = {
    ...mutation('2026-07-10', '9.9000'),
    editedAt: '2026-07-26T09:00:00.000Z',
  };
  let saves = 0;
  const queue = createPredictionValueSaveQueue({
    accountId: 'user-a',
    debounceMs: 0,
    save: async () => {
      saves += 1;
      return saves === 1 ? [survivingCloudValue] : [];
    },
    onRejected: (mutations) => rejectedBatches.push(mutations),
  });

  queue.schedule([mutation('2026-07-10', '9.2000')]);
  await queue.flush();
  assert.deepEqual(rejectedBatches, [[survivingCloudValue]]);

  // If the same cell is re-edited while the save is in flight, the pending
  // local value is newer than the cloud's — the rejection must not clobber it.
  rejectedBatches.length = 0;
  saves = 0;
  const raceQueue = createPredictionValueSaveQueue({
    accountId: 'user-a',
    debounceMs: 0,
    save: async () => {
      saves += 1;
      if (saves === 1) {
        raceQueue.schedule([mutation('2026-07-10', '9.3000')]);
        return [survivingCloudValue];
      }
      return [];
    },
    onRejected: (mutations) => rejectedBatches.push(mutations),
  });
  raceQueue.schedule([mutation('2026-07-10', '9.2000')]);
  await raceQueue.flush();
  assert.deepEqual(rejectedBatches, []);
});

test('edited_at migration arbitrates prediction writes and keeps clears as tombstones', () => {
  const sql = fs.readFileSync('supabase/20260726_prediction_value_edited_at.sql', 'utf8');

  assert.match(sql, /add column if not exists edited_at timestamptz/i);
  assert.match(sql, /set edited_at = updated_at/i);
  assert.match(sql, /where excluded\.edited_at >= pv\.edited_at/i);
  // Clears must persist as empty-value tombstones so a stale offline device
  // cannot resurrect a value the user deleted on another device. Any delete
  // that targets a specific incoming cell would be a regression back to the
  // old delete-style clearing.
  const saver = sql.slice(sql.indexOf('create function public.save_my_prediction_values'));
  const saverBody = saver.slice(0, saver.indexOf('$$;'));
  assert.match(saverBody, /coalesce\(item\.value, ''\)/i);
  // The only allowed delete is the aged-tombstone sweep; a delete that
  // references the incoming item would be per-cell delete-style clearing.
  const deleteStatements = saverBody.match(/delete from[\s\S]*?;/gi) ?? [];
  assert.equal(deleteStatements.length, 1);
  assert.doesNotMatch(deleteStatements[0]!, /item\./i);
  assert.match(deleteStatements[0]!, /btrim\(pv\.value\) = ''\s+and pv\.edited_at < now\(\) - interval '90 days'/i);
});

test('workspace loader hides tombstones and seeds the client clock past every stored edit stamp', () => {
  const sql = fs.readFileSync('supabase/20260726_prediction_value_edited_at.sql', 'utf8');
  const loader = sql.slice(
    sql.indexOf('create or replace function public.get_my_prediction_workspace'),
    sql.indexOf('create or replace function public.replace_my_prediction_workspace'),
  );

  assert.match(loader, /btrim\(value\) <> ''/i);
  // edited_at can run ahead of every server-written updated_at (clamped
  // client stamp). The login seed must cover it or a fast-clocked device
  // suppresses edits other devices make after signing in.
  assert.match(loader, /max\(prediction_value\.edited_at\)/i);
});

test('full import tombstones dropped cells instead of deleting their arbitration baseline', () => {
  const sql = fs.readFileSync('supabase/20260726_prediction_value_edited_at.sql', 'utf8');
  const replacer = sql.slice(sql.indexOf('create or replace function public.replace_my_prediction_workspace'));

  // A wholesale delete would let a stale offline outbox re-insert values the
  // import intentionally dropped.
  assert.doesNotMatch(replacer, /delete from public\.user_prediction_values/i);
  assert.match(replacer, /set value = '', edited_at = now\(\), updated_at = now\(\)/i);
  assert.match(replacer, /set value = excluded\.value, edited_at = now\(\), updated_at = now\(\)/i);
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

test('normalized workspace loader qualifies updated_at columns so cloud login can load a workspace', () => {
  for (const fileName of [
    'supabase/20260711_normalized_predictions.sql',
    'supabase/20260711_fix_workspace_loader.sql',
  ]) {
    const sql = fs.readFileSync(fileName, 'utf8');
    const loader = sql.slice(sql.indexOf('create or replace function public.get_my_prediction_workspace()'));

    assert.match(loader, /max\(prediction_value\.updated_at\)/i, fileName);
    assert.match(loader, /max\(forecast_history\.updated_at\)/i, fileName);
    assert.doesNotMatch(loader, /max\(updated_at\)/i, fileName);
  }
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

test('rejected-row payloads from the server are validated, normalized, and advance the edit clock', () => {
  const editedAt = new Date(Date.now() + 3_600_000).toISOString();
  const rows = normalizeRejectedPredictionRows([
    {
      r_stock_code: '000166',
      r_period: 'day',
      r_target_date: '2026-07-10',
      r_metric: 'ma40',
      r_value: '9.9000',
      r_edited_at: editedAt,
    },
    // Tombstone: the surviving cloud state is "cleared".
    {
      r_stock_code: '000166',
      r_period: 'day',
      r_target_date: '2026-07-11',
      r_metric: 'ma40',
      r_value: '',
      r_edited_at: editedAt,
    },
    // Malformed rows must be dropped, not trusted.
    { r_stock_code: '000166', r_period: 'day', r_target_date: '2026-07-12', r_metric: 'ma40', r_value: '1' },
    { r_stock_code: 'bogus!', r_period: 'day', r_target_date: '2026-07-12', r_metric: 'ma40', r_value: '1', r_edited_at: editedAt },
    null,
  ]);

  assert.deepEqual(rows, [
    { stockCode: '000166', period: 'day', targetDate: '2026-07-10', metric: 'ma40', value: '9.9000', editedAt },
    { stockCode: '000166', period: 'day', targetDate: '2026-07-11', metric: 'ma40', value: null, editedAt },
  ]);
  assert.deepEqual(normalizeRejectedPredictionRows(null), []);
  assert.deepEqual(normalizeRejectedPredictionRows(undefined), []);

  // Seeing a rejection must advance the local clock past the surviving cloud
  // stamp so the user's very next edit outranks it.
  const [next] = createPredictionValueMutations(scope, [row('2026-07-10', '9.9000')], [row('2026-07-10', '9.5000')]);
  assert.ok(Date.parse(next!.editedAt) > Date.parse(editedAt));
});

test('the edit clock never runs behind timestamps observed from the cloud', () => {
  const future = new Date(Date.now() + 7_200_000).toISOString();
  advancePredictionEditClock(future);
  const [m] = createPredictionValueMutations(scope, [row('2026-07-10', '9.1000')], [row('2026-07-10', '9.2000')]);
  assert.ok(Date.parse(m!.editedAt) > Date.parse(future));
  // Garbage input must not corrupt the clock.
  advancePredictionEditClock('not-a-date');
  advancePredictionEditClock(null);
  const [after] = createPredictionValueMutations(scope, [row('2026-07-10', '9.2000')], [row('2026-07-10', '9.3000')]);
  assert.ok(Date.parse(after!.editedAt) > Date.parse(future));
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
  return {
    stockCode: '000166',
    period: 'day',
    targetDate,
    metric: 'ma40',
    value,
    editedAt: '2026-07-26T08:00:00.000Z',
  };
}
