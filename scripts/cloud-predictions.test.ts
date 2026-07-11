import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { PredictionPoint } from '../src/types.ts';
import {
  applyPredictionEventsToRows,
  createPredictionEventsFromRows,
  createPredictionEventsFromStorageSnapshot,
  foldPredictionEvents,
  listPredictionStockCodes,
  parsePredictionEventsFromFullBackup,
  type PredictionEvent,
} from '../src/utils/cloudPredictions.ts';

const scope = { stockCode: '688571', period: 'day' as const };

test('cloud stock selector lists each predicted stock code once in order', () => {
  const codes = listPredictionStockCodes([
    {
      id: 'month-000166', stockCode: '000166', period: 'month', targetDate: '2026-08-31', metric: 'ma40', eventType: 'set', value: '4.8310', deviceId: 'device-a', clientEventAt: '2026-07-11T08:00:00.000Z', createdAt: '2026-07-11T08:00:00.000Z',
    },
    {
      id: 'day-688571', stockCode: '688571', period: 'day', targetDate: '2026-07-10', metric: 'ma40', eventType: 'set', value: '9.2000', deviceId: 'device-a', clientEventAt: '2026-07-11T08:00:01.000Z', createdAt: '2026-07-11T08:00:01.000Z',
    },
    {
      id: 'week-000166', stockCode: '000166', period: 'week', targetDate: '2026-07-10', metric: 'ma5', eventType: 'set', value: '4.8200', deviceId: 'device-a', clientEventAt: '2026-07-11T08:00:02.000Z', createdAt: '2026-07-11T08:00:02.000Z',
    },
  ]);

  assert.deepEqual(codes, ['000166', '688571']);
});

test('cloud save snapshot contains only the current user prediction tables', () => {
  const events = createPredictionEventsFromStorageSnapshot(
    {
      'prediction-ma:000166:month:v2': JSON.stringify([
        { targetDate: '2026-08-31', predictedMa40: '4.8310', predictedMaValues: { 40: '4.8310' }, note: '' },
      ]),
      'prediction-ma:688571:week:v2': JSON.stringify([
        { targetDate: '2026-07-10', predictedMa40: '8.1700', predictedMaValues: { 40: '8.1700' }, note: '' },
      ]),
      'prediction-ma40:kline-cache:000166:month': JSON.stringify({ data: 'not a prediction' }),
      'prediction-ma40:cloud-outbox:v1': JSON.stringify([{ value: 'stale event' }]),
    },
    'snapshot-device',
    '2026-07-11T08:00:00.000Z',
  );

  assert.deepEqual(
    events.map(({ stockCode, period, targetDate, metric, value }) => ({ stockCode, period, targetDate, metric, value })),
    [
      { stockCode: '000166', period: 'month', targetDate: '2026-08-31', metric: 'ma40', value: '4.8310' },
      { stockCode: '688571', period: 'week', targetDate: '2026-07-10', metric: 'ma40', value: '8.1700' },
    ],
  );
});

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
