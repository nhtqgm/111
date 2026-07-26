import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSuggestPayload, parseUlistPayload } from '../src/utils/stockSearchParsing.ts';

test('suggest parsing keeps only supported A-share stocks and deduplicates codes', () => {
  const payload = {
    QuotationCodeTable: {
      Data: [
        { Code: '000001', Name: '平安银行', Classify: 'AStock', SecurityTypeName: '深A' },
        { Code: '601318', Name: '中国平安', Classify: 'AStock', SecurityTypeName: '沪A' },
        { Code: '000001', Name: '平安银行', Classify: 'AStock', SecurityTypeName: '深A' },
        { Code: '02318', Name: '中国平安H', Classify: 'HK', SecurityTypeName: '港股' },
        { Code: '830799', Name: '某北交所股', Classify: 'AStock', SecurityTypeName: '北A' },
        { Code: '000002', Name: '', Classify: 'AStock', SecurityTypeName: '深A' },
      ],
    },
  };

  const results = parseSuggestPayload(payload);
  assert.deepEqual(
    results.map((item) => item.code),
    ['000001', '601318'],
  );
  assert.equal(results[0].name, '平安银行');
  assert.equal(results[1].typeName, '沪A');
});

test('suggest parsing tolerates empty or malformed payloads', () => {
  assert.deepEqual(parseSuggestPayload(null), []);
  assert.deepEqual(parseSuggestPayload({}), []);
  assert.deepEqual(parseSuggestPayload({ QuotationCodeTable: { Data: null } }), []);
});

test('ulist parsing maps codes to names from array or object diff shapes', () => {
  const arrayPayload = {
    data: {
      diff: [
        { f12: '000166', f14: '申万宏源' },
        { f12: '600000', f14: '浦发银行' },
        { f12: '000167', f14: '-' },
      ],
    },
  };
  const objectPayload = {
    data: {
      diff: {
        '0': { f12: '000166', f14: '申万宏源' },
        '1': { f12: '600000', f14: '浦发银行' },
      },
    },
  };

  const fromArray = parseUlistPayload(arrayPayload);
  assert.equal(fromArray.get('000166'), '申万宏源');
  assert.equal(fromArray.get('600000'), '浦发银行');
  assert.equal(fromArray.has('000167'), false);

  const fromObject = parseUlistPayload(objectPayload);
  assert.equal(fromObject.get('000166'), '申万宏源');
  assert.equal(fromObject.size, 2);
});

test('ulist parsing tolerates empty or malformed payloads', () => {
  assert.equal(parseUlistPayload(null).size, 0);
  assert.equal(parseUlistPayload({}).size, 0);
  assert.equal(parseUlistPayload({ data: { diff: null } }).size, 0);
});
