import assert from 'node:assert/strict';
import test from 'node:test';

async function loadLinePointsModule() {
  return await import('../src/utils/linePoints.ts');
}

test('historical forecast MA keeps its value when the future line has a real-MA anchor on the same date', async () => {
  const { mergeLineValuePointsPreservingEarlier } = await loadLinePointsModule();

  assert.deepEqual(
    mergeLineValuePointsPreservingEarlier(
      [{ targetDate: '2026-07-10', value: 9.136 }],
      [
        { targetDate: '2026-07-10', value: 9.15 },
        { targetDate: '2026-07-13', value: 9.13 },
      ],
    ),
    [
      { targetDate: '2026-07-10', value: 9.136 },
      { targetDate: '2026-07-13', value: 9.13 },
    ],
  );
});
