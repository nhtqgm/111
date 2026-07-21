import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appSource = fs.readFileSync('src/App.tsx', 'utf8');
const normalizedSchema = fs.readFileSync('supabase/20260711_normalized_predictions.sql', 'utf8');

test('typing a new stock code activates that scope before its market request can finish', () => {
  const activateStart = appSource.indexOf('function activateStockCode');
  const queryStart = appSource.indexOf('async function queryStockCode');
  const periodStart = appSource.indexOf('function selectKLinePeriod');
  const querySource = appSource.slice(queryStart, periodStart);
  const activateSource = appSource.slice(activateStart, queryStart);

  assert.ok(activateStart >= 0 && queryStart > activateStart && periodStart > queryStart);
  assert.match(
    activateSource,
    /selectedMarketScopeRef\.current = \{ stockCode: normalizedCode, period \}/,
  );
  assert.match(activateSource, /setQueryCode\(normalizedCode\)/);
  assert.match(querySource, /const scopeChanged = activateStockCode\(requestedStockCode\)/);
  assert.match(querySource, /targetStockCode: requestedStockCode/);
  assert.match(querySource, /skipCurrentCapture: scopeChanged/);
});

test('manual market refresh uses the typed-code query path and supports Enter', () => {
  assert.match(appSource, /onClick=\{\(\) => void queryStockCode\(\)\}/);
  assert.match(appSource, /if \(event\.key !== 'Enter'\) return;/);
  assert.match(appSource, /void queryStockCode\(\);/);
  assert.doesNotMatch(
    appSource,
    /<button type="button" onClick=\{\(\) => void refreshHistoricalData\(\)\}/,
  );
});

test('cloud schema accepts any valid six-digit stock code without a stock master dependency', () => {
  assert.match(normalizedSchema, /stock_code text not null check \(stock_code ~ '\^\\d\{6\}\$'\)/);
  assert.doesNotMatch(normalizedSchema, /stock_code[^\n]+references\s+public\./i);
});

test('a successful new-stock query is remembered before later workspace updates', () => {
  const queryStart = appSource.indexOf('async function queryStockCode');
  const periodStart = appSource.indexOf('function selectKLinePeriod');
  const querySource = appSource.slice(queryStart, periodStart);

  assert.match(querySource, /if \(!result\.successfulPeriods\.length \|\| !cloudUser\) return;/);
  assert.match(querySource, /Promise\.allSettled\(\[/);
  assert.match(querySource, /saveMyWorkspacePreferences\(requestedStockCode, period, selectedBaseDate\)/);
  assert.match(querySource, /rememberMyStockCode\(requestedStockCode\)/);
  assert.match(querySource, /const stockRegistrySaved = stockRegistryResult\.status === 'fulfilled'/);
  assert.match(
    querySource,
    /if \(stockRegistrySaved\) \{[\s\S]+setCloudStockCodes\(\(current\) => mergeStockCodeLists\(current, \[requestedStockCode\]\)\)/,
  );
});

test('cloud workspace reload restores the full account stock registry from the database', () => {
  assert.match(appSource, /loadMyStockCodes\(\)/);
  assert.match(appSource, /setCloudStockCodes\(remoteStockCodes\)/);
  assert.doesNotMatch(appSource, /collectCloudStockCodes|loadStoredStockCodes/);
});
