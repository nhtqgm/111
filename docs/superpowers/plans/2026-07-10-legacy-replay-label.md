# Legacy Replay Label Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow “未归属历史” to be renamed per stock and K-line period without changing replay snapshot ownership.

**Architecture:** Add a small persistence API beside the existing replay snapshot storage, then wire the saved label into the replay modal option and source text. The label is UI metadata only; legacy rows continue to be identified by a missing `planId`.

**Tech Stack:** React 19, TypeScript, browser localStorage, Electron storage synchronization, Node test runner, Playwright browser verification.

---

### Task 1: Persist the legacy replay label

**Files:**
- Modify: `src/utils/replay.ts`
- Test: `scripts/replay.test.ts`

- [ ] **Step 1: Write failing storage tests**

Add tests proving the default label, normalization, stock/period isolation, and Electron synchronization:

```ts
test('legacy replay label defaults and saves per stock and period', async () => {
  const storage = new MemoryStorage();
  installStorage(storage);

  assert.equal(replay.loadLegacyReplayLabel('000166', 'month'), '未归属历史');
  await replay.saveLegacyReplayLabel('000166', 'month', '  早期预测  ');

  assert.equal(replay.loadLegacyReplayLabel('000166', 'month'), '早期预测');
  assert.equal(replay.loadLegacyReplayLabel('000166', 'week'), '未归属历史');
  assert.equal(replay.loadLegacyReplayLabel('600000', 'month'), '未归属历史');
});

test('saving a legacy replay label queues Electron persistence', async () => {
  const storage = new MemoryStorage();
  const saved: Record<string, string>[] = [];
  installStorage(storage, {
    async bootstrap(snapshot) { return snapshot; },
    async save(snapshot) { saved.push(snapshot); },
  });

  await replay.saveLegacyReplayLabel('000166', 'month', '历史方案组');

  assert.equal(saved.length, 1);
  assert.equal(
    saved[0]['prediction-ma:replay-legacy-label:000166:month:v1'],
    '历史方案组',
  );
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test scripts/replay.test.ts
```

Expected: FAIL because `loadLegacyReplayLabel` and `saveLegacyReplayLabel` do not exist.

- [ ] **Step 3: Implement the minimal persistence API**

Add to `src/utils/replay.ts`:

```ts
export const DEFAULT_LEGACY_REPLAY_LABEL = '未归属历史';
const MAX_LEGACY_REPLAY_LABEL_LENGTH = 30;

export function normalizeLegacyReplayLabel(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim().slice(0, MAX_LEGACY_REPLAY_LABEL_LENGTH) : '';
  return normalized || DEFAULT_LEGACY_REPLAY_LABEL;
}

export function loadLegacyReplayLabel(stockCode: string, period: PeriodType) {
  return normalizeLegacyReplayLabel(
    localStorage.getItem(legacyReplayLabelStorageKey(stockCode, period)),
  );
}

export function saveLegacyReplayLabel(stockCode: string, period: PeriodType, label: string) {
  const normalized = normalizeLegacyReplayLabel(label);
  localStorage.setItem(legacyReplayLabelStorageKey(stockCode, period), normalized);
  return queueElectronStorageSync().then(() => normalized);
}

function legacyReplayLabelStorageKey(stockCode: string, period: PeriodType) {
  return `prediction-ma:replay-legacy-label:${normalizeStockCode(stockCode)}:${period}:v1`;
}
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
node --test scripts/replay.test.ts
```

Expected: all replay tests pass.

### Task 2: Add replay-modal rename behavior

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Load and reset the label with the replay workspace**

Import the new replay helpers and add state:

```ts
const [legacyReplayLabel, setLegacyReplayLabel] = useState(DEFAULT_LEGACY_REPLAY_LABEL);
```

When the matching stock/period workspace loads, call:

```ts
setLegacyReplayLabel(loadLegacyReplayLabel(data.code, period));
```

When invalidating or clearing the current workspace, reset it to `DEFAULT_LEGACY_REPLAY_LABEL`.

- [ ] **Step 2: Implement the rename command**

Add a handler following the existing plan rename interaction:

```ts
async function renameLegacyReplayLabel() {
  if (!data || !hasLegacyReplayRows) return;
  const nextName = window.prompt('请输入未归属历史的新名称', legacyReplayLabel);
  if (nextName === null || !nextName.trim()) return;

  const savedLabel = await saveLegacyReplayLabel(data.code, period, nextName);
  setLegacyReplayLabel(savedLabel);
  showToast(`已重命名为：${savedLabel}`, 'success');
}
```

Catch persistence errors and show `名称保存失败，请重试` without modifying replay snapshots.

- [ ] **Step 3: Wire the label into the modal**

Pass `legacyReplayLabel` and `onRenameLegacyReplayLabel` to `ReplayReviewModal`. Render the option as:

```tsx
{hasLegacyRows ? <option value="legacy">{legacyReplayLabel}</option> : null}
```

Render a compact rename button beside the filter only when legacy rows exist:

```tsx
{hasLegacyRows ? (
  <button type="button" className="ghost replay-legacy-rename" onClick={onRenameLegacyReplayLabel}>
    重命名
  </button>
) : null}
```

Pass the label to `formatReplaySource(row, legacyReplayLabel)` so legacy row source text changes immediately while named-plan rows remain unchanged.

- [ ] **Step 4: Add narrowly scoped styling**

Keep the existing filter layout and add only enough CSS to align the new button and allow wrapping on narrow screens:

```css
.replay-filter-controls {
  display: flex;
  align-items: end;
  gap: 8px;
  flex-wrap: wrap;
}

.replay-legacy-rename {
  flex: 0 0 auto;
}
```

### Task 3: Verify, commit, and deploy the preview branch

**Files:**
- Verify: `src/utils/replay.ts`
- Verify: `src/App.tsx`
- Verify: `src/styles.css`
- Verify: `scripts/replay.test.ts`

- [ ] **Step 1: Run full automated verification**

Run:

```bash
npm run test:storage
npm run verify:ma
npm run build
git diff --check
```

Expected: 0 failures and a successful production build.

- [ ] **Step 2: Run browser verification**

Verify on the integrated preview locally:

1. Open a workspace containing a legacy replay row.
2. Open “预测复盘” and choose the legacy filter.
3. Click “重命名”, enter “早期预测”, and confirm both the option and source column update.
4. Reload and confirm the label remains “早期预测”.
5. Switch period or stock and confirm the label is isolated.
6. Confirm current-plan and all-plan filters still work.

- [ ] **Step 3: Commit the implementation**

```bash
git add src/utils/replay.ts src/App.tsx src/styles.css scripts/replay.test.ts docs/superpowers/plans/2026-07-10-legacy-replay-label.md
git commit -m "feat: rename legacy replay group"
```

- [ ] **Step 4: Push and verify preview deployment**

```bash
git push origin codex-plan-replay-integrated-v1
```

Expected preview URL:

```text
https://nhtqgm.github.io/111/preview/codex-plan-replay-integrated-v1/
```

Confirm the preview returns HTTP 200 and the `main` worktree remains untouched.
