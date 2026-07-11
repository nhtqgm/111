import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import type { PredictionPoint } from '../src/types.ts';
import {
  createCloudWorkspaceFromLegacyBackup,
  createEmptyCloudWorkspace,
  createWorkspaceSaveQueue,
  getWorkspacePredictions,
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

test('save queue coalesces rapid changes and never sends an old account payload after switching accounts', async () => {
  const sent: Array<{ accountId: string; value: string }> = [];
  const queue = createWorkspaceSaveQueue({
    accountId: 'user-a',
    revision: 0,
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
