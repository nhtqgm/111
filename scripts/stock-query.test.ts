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
