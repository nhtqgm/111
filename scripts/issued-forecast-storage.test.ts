import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  ISSUED_FORECAST_BATCH_SCHEMA,
  createIssuedForecastBatchId,
  selectActiveIssuedForecastBatch,
  type IssuedForecastBatch,
} from '../src/utils/issuedForecastBatch.ts';
import {
  isIssuedForecastSnapshot,
  issuedForecastBatchToSnapshots,
  issuedForecastBatchesFromSnapshots,
  loadMyIssuedForecastBatchesV2,
  saveMyIssuedForecastBatchV2,
} from '../src/utils/issuedForecastStorage.ts';

const scope = { stockCode: '688571', period: 'day' as const, inputMaWindow: 5 as const };

test('issued batch round-trips through history snapshots without changing frozen prices', () => {
  const batch = makeBatch('r1', '2026-07-10T07:00:00.000Z', 8.52);
  const snapshots = issuedForecastBatchToSnapshots(batch);

  assert.equal(snapshots.length, batch.rows.length);
  assert.equal(snapshots.every(isIssuedForecastSnapshot), true);
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.id)).size, snapshots.length);
  assert.equal(snapshots[0].issuedForecast.batchId, batch.id);
  assert.deepEqual(issuedForecastBatchesFromSnapshots(snapshots), [batch]);
});

test('cloud save sends batch and all snapshots in one transaction and waits for server sequence', async () => {
  const batch = makeBatch('r1', '2026-07-10T07:00:00.000Z', 8.52);
  const calls: Array<{ name: string; parameters?: Record<string, unknown> }> = [];
  const saved = await saveMyIssuedForecastBatchV2(batch, 'issued', async (name, parameters) => {
    calls.push({ name, parameters });
    return {
      error: null,
      data: [{
        server_sequence: 41,
        batch_payload: batch,
        source: 'issued',
        persisted_at: '2026-07-10T07:01:00.000Z',
      }],
    };
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'insert_my_issued_forecast_batch_v2');
  assert.deepEqual(calls[0].parameters?.p_batch, batch);
  assert.equal((calls[0].parameters?.p_snapshots as unknown[]).length, batch.rows.length);
  assert.equal(calls[0].parameters?.p_source, 'issued');
  assert.equal(saved.serverSequence, 41);
  assert.equal(saved.serverPersistedAt, '2026-07-10T07:01:00.000Z');
  assert.equal(saved.rows[0].predictedClose, 8.52);
});

test('cloud load and active selection use server_sequence instead of client timestamps', async () => {
  const olderServerBatch = makeBatch('r1', '2026-07-10T09:00:00.000Z', 8.52);
  const newerServerBatch = makeBatch('r2', '2026-07-10T06:00:00.000Z', 8.61);
  const loaded = await loadMyIssuedForecastBatchesV2(async (name) => ({
    error: null,
    data: name === 'get_my_issued_forecast_batches_v2' ? [
      row(newerServerBatch, 42),
      row(olderServerBatch, 41),
    ] : [],
  }));

  assert.deepEqual(loaded.map((batch) => batch.serverSequence), [41, 42]);
  assert.equal(selectActiveIssuedForecastBatch(loaded, scope)?.id, newerServerBatch.id);
});

test('cloud load fails loudly instead of hiding a malformed immutable row', async () => {
  await assert.rejects(
    loadMyIssuedForecastBatchesV2(async () => ({
      error: null,
      data: [{ server_sequence: 42, batch_payload: null, source: 'issued', persisted_at: 'bad' }],
    })),
    /不可变契约校验/,
  );
});

test('cloud save fails closed when the server does not return an authoritative sequence', async () => {
  const batch = makeBatch('r1', '2026-07-10T07:00:00.000Z', 8.52);
  await assert.rejects(
    saveMyIssuedForecastBatchV2(batch, 'issued', async () => ({ data: [], error: null })),
    /server_sequence/,
  );
});

test('client and cloud accept the same URL-safe revision contract', async () => {
  const unsafe = { ...makeBatch('r1', '2026-07-10T07:00:00.000Z', 8.52), revision: '中文 版本' };
  await assert.rejects(
    saveMyIssuedForecastBatchV2(unsafe, 'issued', async () => ({ data: [], error: null })),
    /Invalid issued forecast batch/,
  );
});

test('issued forecast storage implementation has no local or Electron persistence path', () => {
  const source = fs.readFileSync('src/utils/issuedForecastStorage.ts', 'utf8');
  assert.doesNotMatch(source, /localStorage|StorageLike|ElectronStorage|queueElectronStorageSync/);
  assert.doesNotMatch(source, /appendIssuedForecastBatch|issuedForecastStorageKey|loadIssuedForecastBatches/);
  assert.match(source, /insert_my_issued_forecast_batch_v2/);
  assert.match(source, /get_my_issued_forecast_batches_v2/);
});

function row(batch: IssuedForecastBatch, serverSequence: number) {
  return {
    server_sequence: serverSequence,
    batch_payload: batch,
    source: 'issued',
    persisted_at: '2026-07-10T07:01:00.000Z',
  };
}

function makeBatch(
  revision: string,
  issuedAt: string,
  firstPredictedClose: number,
): IssuedForecastBatch {
  const id = createIssuedForecastBatchId({
    ...scope,
    revision,
    asOfDate: '2026-07-10',
  });
  const predictedCloses = [firstPredictedClose, 8.6];
  return {
    schema: ISSUED_FORECAST_BATCH_SCHEMA,
    id,
    ...scope,
    revision,
    asOfDate: '2026-07-10',
    asOfPeriodKey: '2026-07-10',
    issuedAt,
    rows: predictedCloses.map((predictedClose, index) => {
      const horizon = index + 1;
      const periodKey = `2026-07-${String(10 + horizon).padStart(2, '0')}`;
      return {
        id: `${id}:${periodKey}:H${horizon}`,
        targetDate: periodKey,
        periodKey,
        horizon,
        inputMaValue: 9.13,
        predictedClose,
        predictedMaValues: { 5: 9.13, 10: 9.2, 20: 9.3, 40: 9.4, 60: null },
        note: `row ${horizon}`,
        previousSumAtIssue: 37.13,
        basisValues: Array.from({ length: 4 }, (_, basisIndex) => ({
          periodKey: `basis-${basisIndex}`,
          targetDate: `2026-07-0${basisIndex + 6}`,
          value: 9.1 + basisIndex * 0.01,
          source: basisIndex === 3 && horizon > 1 ? 'predicted' as const : 'actual' as const,
        })),
      };
    }),
  };
}
