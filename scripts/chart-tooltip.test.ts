import assert from 'node:assert/strict';
import test from 'node:test';

import { formatAxisTooltip, hasTooltipValue } from '../src/utils/chartTooltip.ts';

test('axis tooltip removes empty provisional series after settlement', () => {
  const html = formatAxisTooltip([
    {
      axisValueLabel: '2026-07-27',
      marker: '<span class="locked"></span>',
      seriesName: '已提交预测收盘（锁定）',
      value: 23.12,
    },
    {
      axisValueLabel: '2026-07-27',
      marker: '<span class="actual"></span>',
      seriesName: '真实收盘价（已收盘）',
      value: 4.66,
    },
    {
      axisValueLabel: '2026-07-27',
      marker: '<span class="provisional"></span>',
      seriesName: '实时暂估收盘（未收盘）',
      value: '-',
    },
  ]);

  assert.match(html, /已提交预测收盘（锁定）.*23\.12/);
  assert.match(html, /真实收盘价（已收盘）.*4\.66/);
  assert.doesNotMatch(html, /实时暂估收盘/);
});

test('tooltip value guard rejects null placeholders and keeps zero', () => {
  assert.equal(hasTooltipValue(null), false);
  assert.equal(hasTooltipValue('-'), false);
  assert.equal(hasTooltipValue(['-', '-', '-', '-']), false);
  assert.equal(hasTooltipValue(0), true);
  assert.equal(hasTooltipValue([4.63, 4.66, 4.6, 4.68]), true);
});
