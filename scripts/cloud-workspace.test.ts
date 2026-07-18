import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import type { PredictionPoint } from '../src/types.ts';
import {
  applyForecastHistoryOutboxToWorkspace,
  assertCloudWorkspaceContainsLocalData,
  createCloudWorkspaceFromLegacyBackup,
  createEmptyCloudWorkspace,
  createWorkspaceSaveQueue,
  getWorkspacePredictions,
  mergeCloudForecastHistory,
  mergeCloudWorkspaceAfterRevisionConflict,
  setWorkspaceForecastHistory,
  setWorkspacePredictions,
} from '../src/utils/cloudWorkspace.ts';

const scope = { stockCode: '000166', period: 'month' as const };

test('legacy baseline becomes an independent cloud workspace without market cache data', () => {
  const backup = JSON.parse(
    fs.readFileSync('C:/Users/nht/Desktop/gupiao-full-backup-2026-07-11.json', 'utf8'),
  );

  const workspace = createCloudWorkspaceFromLegacyBackup(backup);

  assert.equal(workspace.schema, 'gupiao-cloud-workspace/v1');
  assert.equal(Object.keys(workspace.predictions).length, 6);
  assert.equal(Object.keys(workspace.forecastHistory).every((key) => !key.includes('kline-cache')), true);
  assert.equal(JSON.stringify(workspace).includes('kline-cache'), false);
});

test('workspace predictions are scoped by stock and period without cross-account keys', () => {
  const rows: PredictionPoint[] = [
    { targetDate: '2026-08-31', predictedMa40: '4.8310', predictedMaValues: { 40: '4.8310' }, note: '' },
  ];
  const workspace = setWorkspacePredictions(createEmptyCloudWorkspace(), scope, rows);

  assert.deepEqual(getWorkspacePredictions(workspace, scope), rows);
  assert.deepEqual(getWorkspacePredictions(workspace, { stockCode: '688571', period: 'month' }), []);
});

test('revision conflict merge preserves a remote scope that this device did not change', () => {
  const baseline = setWorkspacePredictions(createEmptyCloudWorkspace(), scope, predictionRows('4.8300'));
  const local = setWorkspacePredictions(baseline, scope, predictionRows('9.2000'));
  const remote = setWorkspacePredictions(
    baseline,
    { stockCode: '688571', period: 'week' },
    predictionRows('7.1000'),
  );

  const merged = mergeCloudWorkspaceAfterRevisionConflict({ baseline, local, remote });

  assert.deepEqual(getWorkspacePredictions(merged, scope), predictionRows('9.2000'));
  assert.deepEqual(
    getWorkspacePredictions(merged, { stockCode: '688571', period: 'week' }),
    predictionRows('7.1000'),
  );
});

test('revision conflict merge keeps the current user input when both devices changed one scope', () => {
  const baseline = setWorkspacePredictions(createEmptyCloudWorkspace(), scope, predictionRows('4.8300'));
  const local = setWorkspacePredictions(baseline, scope, predictionRows('9.2000'));
  const remote = setWorkspacePredictions(baseline, scope, predictionRows('8.6100'));

  const merged = mergeCloudWorkspaceAfterRevisionConflict({ baseline, local, remote });

  assert.deepEqual(getWorkspacePredictions(merged, scope), predictionRows('9.2000'));
});

test('revision conflict merge retains remote forecast history when local history is unchanged', () => {
  const baseline = createEmptyCloudWorkspace();
  const local = setWorkspacePredictions(baseline, scope, predictionRows('9.2000'));
  const remote = {
    ...baseline,
    forecastHistory: {
      '688571:month': [{
        id: 'remote-history',
        stockCode: '688571',
        period: 'month' as const,
        targetDate: '2026-08-31',
        savedAt: '2026-07-11T10:00:00.000Z',
        predictedClose: 7.1,
        predictedMaValues: { 40: 7.1 },
      }],
    },
  };

  const merged = mergeCloudWorkspaceAfterRevisionConflict({ baseline, local, remote });

  assert.deepEqual(merged.forecastHistory, remote.forecastHistory);
});

test('cloud history merge keeps local and remote snapshots from the same scope', () => {
  const localHistory = { '000166:month': [historySnapshot('2026-07-17')] };
  const remoteHistory = { '000166:month': [historySnapshot('2026-07-16')] };

  const merged = mergeCloudForecastHistory(localHistory, remoteHistory);

  assert.deepEqual(
    merged['000166:month'].map((snapshot) => snapshot.targetDate),
    ['2026-07-16', '2026-07-17'],
  );
});

test('pending history outbox is merged into the full cloud workspace without changing other history', () => {
  let workspace = createEmptyCloudWorkspace();
  workspace = setWorkspaceForecastHistory(workspace, scope, [historySnapshot('2026-07-16')]);

  const restored = applyForecastHistoryOutboxToWorkspace(workspace, {
    snapshots: [historySnapshot('2026-07-17')],
    lastSavedAt: null,
  });

  assert.deepEqual(
    restored.forecastHistory['000166:month'].map((snapshot) => snapshot.targetDate),
    ['2026-07-16', '2026-07-17'],
  );
});

test('cloud save verification accepts a complete remote copy and rejects missing history', () => {
  let local = createEmptyCloudWorkspace();
  local = setWorkspacePredictions(local, scope, predictionRows('4.8300'));
  local = setWorkspaceForecastHistory(local, scope, [historySnapshot('2026-07-17')]);

  assert.equal(assertCloudWorkspaceContainsLocalData(local, local), true);
  assert.throws(
    () => assertCloudWorkspaceContainsLocalData(local, setWorkspacePredictions(createEmptyCloudWorkspace(), scope, predictionRows('4.8300'))),
    /Cloud history verification failed/,
  );
});

test('save queue coalesces rapid changes and never sends an old account payload after switching accounts', async () => {
  const sent: Array<{ accountId: string; value: string }> = [];
  const queue = createWorkspaceSaveQueue({
    accountId: 'user-a',
    revision: 0,
    baseline: createEmptyCloudWorkspace(),
    debounceMs: 0,
    save: async ({ payload, expectedRevision }) => {
      sent.push({ accountId: 'server-current-user', value: payload.workspace.stockCode });
      return { revision: expectedRevision + 1, payload };
    },
  });

  queue.schedule({ ...createEmptyCloudWorkspace(), workspace: { stockCode: '000166', period: 'month', baseDate: '' } });
  queue.schedule({ ...createEmptyCloudWorkspace(), workspace: { stockCode: '688571', period: 'week', baseDate: '' } });
  await queue.flush();
  assert.deepEqual(sent, [{ accountId: 'server-current-user', value: '688571' }]);

  queue.switchAccount('user-b', 0);
  queue.schedule({ ...createEmptyCloudWorkspace(), workspace: { stockCode: '000001', period: 'day', baseDate: '' } });
  await queue.flush();
  assert.deepEqual(sent, [
    { accountId: 'server-current-user', value: '688571' },
    { accountId: 'server-current-user', value: '000001' },
  ]);
});

test('save queue keeps the server failure available for a manual retry message', async () => {
  const queue = createWorkspaceSaveQueue({
    accountId: 'user-a',
    revision: 1,
    baseline: createEmptyCloudWorkspace(),
    debounceMs: 0,
    save: async () => {
      throw new Error('Workspace revision conflict.');
    },
  });

  queue.schedule(createEmptyCloudWorkspace());
  await queue.flush();

  assert.equal(queue.getStatus(), 'error');
  assert.equal(queue.getLastError()?.message, 'Workspace revision conflict.');
});

test('workspace SQL qualifies the revision column when incrementing a saved workspace', () => {
  const sql = fs.readFileSync('supabase/20260711_user_workspace.sql', 'utf8');

  assert.match(sql, /update public\.user_workspaces w\s+set[\s\S]*?revision = w\.revision \+ 1/i);
});

function predictionRows(value: string): PredictionPoint[] {
  return [
    {
      targetDate: '2026-07-10',
      predictedMa40: value,
      predictedMaValues: { 40: value },
      note: '',
    },
  ];
}

function historySnapshot(targetDate: string) {
  return {
    schema: 'gupiao-forecast-history/v1' as const,
    id: `000166:month:${targetDate}:MA40`,
    stockCode: '000166',
    period: 'month' as const,
    targetDate,
    inputMaWindow: 40 as const,
    inputMaValue: 4.83,
    predictedClose: 4.9,
    predictedMaValues: { 5: 4.8, 10: 4.8, 20: 4.8, 40: 4.83, 60: 4.8 },
    note: '',
    savedAt: `${targetDate}T10:00:00.000Z`,
  };
}
