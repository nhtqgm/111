import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSupportedAShare,
  parseSuggestPayload,
  parseUlistPayload,
} from '../src/utils/stockSearchParsing.ts';

test('suggest parsing keeps every quotable A-share board, not just Classify=AStock', () => {
  // 字段取值来自真实接口返回：科创板的 Classify 是 "23" 而不是 "AStock"
  const payload = {
    QuotationCodeTable: {
      Data: [
        { Code: '000001', Name: '平安银行', Classify: 'AStock', SecurityTypeName: '深A', MktNum: '0' },
        { Code: '300750', Name: '宁德时代', Classify: 'AStock', SecurityTypeName: '深A', MktNum: '0' },
        { Code: '601318', Name: '中国平安', Classify: 'AStock', SecurityTypeName: '沪A', MktNum: '1' },
        { Code: '688571', Name: '杭华股份', Classify: '23', SecurityTypeName: '科创板', MktNum: '1' },
      ],
    },
  };

  assert.deepEqual(
    parseSuggestPayload(payload).map((item) => item.code),
    ['000001', '300750', '601318', '688571'],
  );
});

test('suggest parsing rejects indices, funds, bonds, HK, BSE and duplicates', () => {
  const payload = {
    QuotationCodeTable: {
      Data: [
        { Code: '000001', Name: '上证指数', Classify: 'Index', SecurityTypeName: '指数', MktNum: '1' },
        { Code: '399001', Name: '深证成指', Classify: 'Index', SecurityTypeName: '指数', MktNum: '0' },
        { Code: '510210', Name: '上证指数ETF', Classify: 'Fund', SecurityTypeName: '基金', MktNum: '1' },
        { Code: '751264', Name: '中国平安债', Classify: 'Bond', SecurityTypeName: '债券', MktNum: '1' },
        { Code: '02318', Name: '中国平安H', Classify: 'HK', SecurityTypeName: '港股', MktNum: '116' },
        { Code: '920185', Name: '贝特瑞', Classify: 'NEEQ', SecurityTypeName: '京A', MktNum: '0' },
        { Code: '601318', Name: '中国平安', Classify: 'AStock', SecurityTypeName: '沪A', MktNum: '1' },
        { Code: '601318', Name: '中国平安', Classify: 'AStock', SecurityTypeName: '沪A', MktNum: '1' },
        { Code: '000002', Name: '', Classify: 'AStock', SecurityTypeName: '深A', MktNum: '0' },
      ],
    },
  };

  assert.deepEqual(
    parseSuggestPayload(payload).map((item) => item.code),
    ['601318'],
  );
});

test('structural A-share check pairs market number with code range', () => {
  assert.equal(isSupportedAShare('000001', '0'), true); // 深主板
  assert.equal(isSupportedAShare('300750', '0'), true); // 创业板
  assert.equal(isSupportedAShare('601318', '1'), true); // 沪主板
  assert.equal(isSupportedAShare('688571', '1'), true); // 科创板
  assert.equal(isSupportedAShare('000001', '1'), false); // 沪市指数
  assert.equal(isSupportedAShare('399001', '0'), false); // 深市指数段
  assert.equal(isSupportedAShare('510210', '1'), false); // 基金
  assert.equal(isSupportedAShare('920185', '0'), false); // 北交所
  assert.equal(isSupportedAShare('02318', '116'), false); // 港股
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
        { f12: '688571', f14: '杭华股份' },
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
  assert.equal(fromArray.get('688571'), '杭华股份');
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
