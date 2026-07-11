import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { PredictionPoint } from '../src/types.ts';
import {
  applyPredictionEventsToRows,
  createPredictionEventsFromRows,
  foldPredictionEvents,
  parsePredictionEventsFromFullBackup,
  type PredictionEvent,
} from '../src/utils/cloudPredictions.ts';

const scope = { stockCode: '688571', period: 'day' as const };

test('newer user prediction event wins and is never replaced by a market value', () => {
  const events: PredictionEvent[] = [
    {
      id: 'earlier',
      stockCode: scope.stockCode,
      period: scope.period,
      targetDate: '2026-07-10',
      metric: 'ma40',
      eventType: 'set',
      value: '8.6100',
      clientEventAt: '2026-07-10T08:00:00.000Z',
      createdAt: '2026-07-10T08:00:00.000Z',
      deviceId: 'market-cache',
    },
    {
      id: 'user',
      stockCode: scope.stockCode,
      period: scope.period,
      targetDate: '2026-07-10',
      metric: 'ma40',
      eventType: 'set',
      value: '9.2000',
      clientEventAt: '2026-07-10T08:01:00.000Z',
      createdAt: '2026-07-10T08:01:00.000Z',
      deviceId: 'user-device',
    },
  ];
  const rows: PredictionPoint[] = [
    { targetDate: '2026-07-10', predictedMa40: '', predictedMaValues: {}, note: '' },
  ];

  const merged = applyPredictionEventsToRows(rows, scope, foldPredictionEvents(events));

  assert.equal(merged[0].predictedMa40, '9.2000');
  assert.equal(merged[0].predictedMaValues['40'], '9.2000');
});

test('clear event removes only the selected MA metric', () => {
  const events: PredictionEvent[] = [
    {
      id: 'clear-ma40',
      stockCode: scope.stockCode,
      period: scope.period,
      targetDate: '2026-07-10',
      metric: 'ma40',
      eventType: 'clear',
      value: null,
      clientEventAt: '2026-07-10T09:00:00.000Z',
      createdAt: '2026-07-10T09:00:00.000Z',
      deviceId: 'user-device',
    },
  ];
  const rows: PredictionPoint[] = [
    {
      targetDate: '2026-07-10',
      predictedMa40: '9.2000',
      predictedMaValues: { 20: '8.8000', 40: '9.2000' },
      note: '',
    },
  ];

  const merged = applyPredictionEventsToRows(rows, scope, foldPredictionEvents(events));

  assert.deepEqual(merged[0].predictedMaValues, { 20: '8.8000' });
  assert.equal(merged[0].predictedMa40, '');
});

test('editing a field creates one set or clear event for that MA field only', () => {
  const before: PredictionPoint[] = [
    { targetDate: '2026-07-10', predictedMa40: '9.1000', predictedMaValues: { 40: '9.1000' }, note: '' },
  ];
  const after: PredictionPoint[] = [
    { targetDate: '2026-07-10', predictedMa40: '9.2000', predictedMaValues: { 40: '9.2000' }, note: '' },
  ];

  const events = createPredictionEventsFromRows(scope, before, after, 'device-a', '2026-07-10T10:00:00.000Z');

  assert.deepEqual(events.map(({ metric, eventType, value }) => ({ metric, eventType, value })), [
    { metric: 'ma40', eventType: 'set', value: '9.2000' },
  ]);
});

test('the July 11 backup is the exact baseline and creates only 56 non-empty events', () => {
  const raw = JSON.parse(
    fs.readFileSync('C:/Users/nht/Desktop/gupiao-full-backup-2026-07-11.json', 'utf8'),
  );
  const events = parsePredictionEventsFromFullBackup(raw, 'baseline-device', '2026-07-11T04:11:29.410Z');

  assert.equal(events.length, 56);
  assert.equal(events.some((event) => event.targetDate === '2026-07-10' && event.value === '9.2000'), false);
  assert.equal(events.every((event) => event.eventType === 'set' && event.value !== null), true);
});

test('backup events use valid, device-specific UUIDs so repeated imports cannot block the outbox', () => {
  const raw = JSON.parse(
    fs.readFileSync('C:/Users/nht/Desktop/gupiao-full-backup-2026-07-11.json', 'utf8'),
  );
  const firstDevice = parsePredictionEventsFromFullBackup(raw, '3d7e4b7d-8bfb-4c39-9c76-723a57ebd3b4');
  const firstDeviceRepeat = parsePredictionEventsFromFullBackup(raw, '3d7e4b7d-8bfb-4c39-9c76-723a57ebd3b4');
  const secondDevice = parsePredictionEventsFromFullBackup(raw, '28f33f15-d4a8-4b57-a1ee-50f722b5cb24');

  assert.equal(firstDevice.every((event) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.id)), true);
  assert.notDeepEqual(
    firstDevice.map((event) => event.id),
    secondDevice.map((event) => event.id),
  );
  assert.deepEqual(
    firstDevice.map((event) => event.id),
    firstDeviceRepeat.map((event) => event.id),
  );
});
