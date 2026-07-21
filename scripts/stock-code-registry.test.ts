import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { mergeStockCodeLists } from '../src/utils/stockCodes.ts';

const appSource = fs.readFileSync('src/App.tsx', 'utf8');
const supabaseSource = fs.readFileSync('src/utils/supabase.ts', 'utf8');
const migrationSource = fs.readFileSync('supabase/20260721_account_stock_codes.sql', 'utf8');
const atomicMigrationSource = fs.readFileSync(
  'supabase/20260721_atomic_stock_code_registry.sql',
  'utf8',
);

test('stock-code lists merge valid codes without duplicates', () => {
  assert.deepEqual(
    mergeStockCodeLists(['000166', '688571'], ['600519', '000166'], ['bad-code']),
    ['000166', '600519', '688571'],
  );
});

test('queried stock codes use an account-scoped database table', () => {
  assert.match(migrationSource, /create table if not exists public\.user_stock_codes/i);
  assert.match(migrationSource, /user_id uuid not null references auth\.users\(id\) on delete cascade/i);
  assert.match(migrationSource, /primary key \(user_id, stock_code\)/i);
  assert.match(migrationSource, /alter table public\.user_stock_codes enable row level security/i);
  assert.match(migrationSource, /for select to authenticated using \(user_id = auth\.uid\(\)\)/i);
  assert.match(migrationSource, /for insert to authenticated with check \(user_id = auth\.uid\(\)\)/i);
  assert.match(
    migrationSource,
    /for update to authenticated using \(user_id = auth\.uid\(\)\) with check \(user_id = auth\.uid\(\)\)/i,
  );
});

test('database migration preserves codes from every existing cloud source', () => {
  assert.match(migrationSource, /from public\.user_workspace_preferences/i);
  assert.match(migrationSource, /from public\.user_prediction_values/i);
  assert.match(migrationSource, /from public\.user_forecast_history/i);
  assert.match(migrationSource, /on conflict \(user_id, stock_code\) do nothing/gi);
});

test('database triggers register codes saved through predictions, history, preferences, or imports', () => {
  assert.match(migrationSource, /register_stock_code_from_preferences/i);
  assert.match(migrationSource, /register_stock_code_from_predictions/i);
  assert.match(migrationSource, /register_stock_code_from_history/i);
  assert.match(migrationSource, /on conflict \(user_id, stock_code\) do update[\s\S]+last_opened_at = now\(\)/i);
});

test('one atomic database RPC remembers a code and returns the complete account list', () => {
  assert.match(
    atomicMigrationSource,
    /function public\.remember_and_get_my_stock_codes\(p_stock_code text\)/i,
  );
  assert.match(atomicMigrationSource, /insert into public\.user_stock_codes \(user_id, stock_code\)/i);
  assert.match(
    atomicMigrationSource,
    /on conflict on constraint user_stock_codes_pkey do update/i,
  );
  assert.match(atomicMigrationSource, /return query[\s\S]+where registry\.user_id = auth\.uid\(\)/i);
  assert.match(
    atomicMigrationSource,
    /grant execute on function public\.remember_and_get_my_stock_codes\(text\) to authenticated/i,
  );
});

test('frontend reads and remembers stock codes only through canonical database RPCs', () => {
  const stockCodeApiSource = supabaseSource.slice(
    supabaseSource.indexOf('export async function loadMyStockCodes'),
    supabaseSource.indexOf('export async function upsertMyForecastHistory'),
  );

  assert.match(stockCodeApiSource, /rpc\('get_my_stock_codes'\)/);
  assert.match(stockCodeApiSource, /rpc\('remember_and_get_my_stock_codes'/);
  assert.match(stockCodeApiSource, /return normalizeStockCodeRows\(data\)/);
  assert.doesNotMatch(stockCodeApiSource, /localStorage|user_metadata|updateUser/);
  assert.doesNotMatch(appSource, /stockCodeRegistry|loadStoredStockCodes|rememberStockCodes/);
});

test('database is the canonical source for the selector after account reload', () => {
  assert.match(appSource, /const \[profile, record, remoteStockCodes\] = await Promise\.all/);
  assert.match(appSource, /setCloudStockCodes\(remoteStockCodes\)/);
  assert.doesNotMatch(appSource, /collectCloudStockCodes/);
});
