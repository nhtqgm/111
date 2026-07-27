import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration = fs.readFileSync(
  'supabase/20260727_immutable_issued_forecast_batches.sql',
  'utf8',
);

test('issued forecast cloud table is append-only with an authenticated read-only RLS policy', () => {
  assert.match(migration, /create table if not exists public\.user_issued_forecast_batches/i);
  assert.match(migration, /server_sequence bigint generated always as identity/i);
  assert.match(migration, /primary key \(user_id, batch_id\)/i);
  assert.match(migration, /alter table public\.user_issued_forecast_batches enable row level security/i);
  assert.match(
    migration,
    /for select\s+to authenticated\s+using \(user_id = auth\.uid\(\)\)/i,
  );
  assert.doesNotMatch(migration, /create policy[\s\S]{0,200}for (?:insert|update|delete|all)/i);
  assert.match(migration, /before update on public\.user_issued_forecast_batches/i);
  assert.doesNotMatch(migration, /before update or delete on public\.user_issued_forecast_batches/i);
  assert.match(migration, /Submitted forecast batches are append-only\./i);
  assert.match(
    migration,
    /revoke all on table public\.user_issued_forecast_batches from public, anon, authenticated/i,
  );
  assert.match(migration, /grant select on table public\.user_issued_forecast_batches to authenticated/i);
});

test('atomic insert RPC validates auth, source, complete batch rows, and bridge ownership', () => {
  assert.match(
    migration,
    /create or replace function public\.insert_my_issued_forecast_batch_v2\(\s*p_batch jsonb,\s*p_snapshots jsonb,\s*p_source text default 'issued'/i,
  );
  assert.match(migration, /v_user_id uuid := auth\.uid\(\)/i);
  assert.match(migration, /if v_user_id is null then[\s\S]+errcode = '42501'/i);
  assert.match(migration, /p_source not in \('issued', 'migration', 'legacy-history'\)/i);
  assert.match(migration, /server_sequence and persisted_at, both assigned by Postgres/i);
  assert.match(migration, /if not isfinite\(v_issued_at\)/i);
  assert.match(migration, /jsonb_typeof\(p_batch->'stockCode'\) is distinct from 'string'/i);
  assert.match(migration, /p_batch->>'revision' is distinct from v_revision/i);
  assert.match(migration, /jsonb_array_length\(p_snapshots\) <> v_row_count/i);
  assert.match(migration, /v_row_payload->'horizon' <> to_jsonb\(v_row\.ordinal\)/i);
  assert.match(migration, /v_row_target_date <= v_as_of_date/i);
  assert.match(migration, /Issued forecast rows must use unique period keys\./i);
  assert.match(migration, /jsonb_array_length\(v_row_payload->'basisValues'\) <> v_window - 1/i);
  assert.match(migration, /v_snapshot_payload->>'stockCode' is distinct from v_stock_code/i);
  assert.match(migration, /v_snapshot_meta->>'batchId' is distinct from v_batch_id/i);
  assert.match(migration, /v_snapshot_meta->>'rowId' is distinct from v_snapshot_row->>'id'/i);
  assert.match(migration, /v_snapshot_meta->>'source' is distinct from p_source/i);
  assert.match(migration, /p_batch->>'schema' is distinct from 'gupiao-issued-forecast-batch\/v1'/i);
  assert.match(migration, /coalesce\(v_basis\.payload->>'source', ''\) not in/i);
});

test('insert RPC atomically persists the immutable batch and existing history snapshots', () => {
  const batchInsert = migration.indexOf('insert into public.user_issued_forecast_batches');
  const historyInsert = migration.indexOf('insert into public.user_forecast_history', batchInsert);
  const functionEnd = migration.indexOf('\nend;\n$$;', historyInsert);

  assert.notEqual(batchInsert, -1);
  assert.notEqual(historyInsert, -1);
  assert.notEqual(functionEnd, -1);
  assert.equal(migration.slice(batchInsert, functionEnd).includes('commit;'), false);
  assert.match(migration.slice(batchInsert, functionEnd), /on conflict \(user_id, batch_id\) do nothing/i);
  assert.match(migration.slice(batchInsert, functionEnd), /v_stored_payload is distinct from p_batch/i);
  assert.match(migration.slice(batchInsert, functionEnd), /v_stored_snapshots is distinct from p_snapshots/i);
  assert.match(migration.slice(batchInsert, functionEnd), /v_history_payload is distinct from v_snapshot_payload/i);
  assert.match(migration.slice(batchInsert, functionEnd), /errcode = '23505'/i);
});

test('insert and get RPCs return the exact monotonic cloud record contract', () => {
  const returnContract = /returns table \(\s*server_sequence bigint,\s*batch_payload jsonb,\s*source text,\s*persisted_at timestamptz\s*\)/gi;
  assert.equal([...migration.matchAll(returnContract)].length, 2);
  assert.match(migration, /order by batches\.server_sequence/i);
  assert.match(
    migration,
    /revoke all on function public\.insert_my_issued_forecast_batch_v2\(jsonb, jsonb, text\)\s+from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.insert_my_issued_forecast_batch_v2\(jsonb, jsonb, text\)\s+to authenticated/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.get_my_issued_forecast_batches_v2\(\)\s+to authenticated/i,
  );
});
