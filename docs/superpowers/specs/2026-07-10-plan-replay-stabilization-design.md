# Prediction Plan and Replay Stabilization Design

## Status

Approved design for the `codex-plan-replay-integrated-v1` preview branch.

## Goal

Integrate the stable `main` branch behavior with prediction-plan management and
prediction replay, while preserving all existing chart, MA calculation,
persistence, import/export, online/offline, and update behavior.

The stable `main` branch remains unchanged. All implementation and deployment
work is limited to the preview branch and its existing preview URL.

## Current Baseline

The preview branch already supports:

- multiple plans per stock and period;
- create, copy, rename, delete, select, import, and export plan operations;
- plan-level prediction editing;
- replay snapshots created when predictions are saved;
- replay summaries and detail views;
- filtering replay rows by plan.

The preview branch does not yet include all persistence and update fixes from
`main` version 0.2.8. The two preview features also have ownership, timer,
period-matching, limit, and UI-state edge cases that can cause stale state,
lost edits, or permanently pending replay records.

## Chosen Integration Approach

Merge `main` into the preview branch, then resolve the expected `src/App.tsx`
and `src/styles.css` conflicts by preserving both sets of behavior.

This is preferred over cherry-picking selected fixes because persistence,
online/offline startup, full backup, and update behavior span several files.
Rebuilding the preview features on a fresh branch would create unnecessary
regression risk.

## Architecture

The implementation keeps the existing React application structure but moves
business rules into focused utility modules:

- `predictionPlans.ts` owns plan identity, normalization, migration, limits,
  import/export, and storage keys.
- `replay.ts` owns snapshot identity, lifecycle, period-aware actual-data
  matching, review calculations, filtering, and storage keys.
- `electronStorage.ts` remains the single renderer-side bridge for syncing
  localStorage changes into Electron's origin-independent storage.
- `App.tsx` coordinates React state and user actions. It does not construct
  storage keys or duplicate normalization rules.

`plans` and `activePlanId` remain the source of truth. The visible prediction
rows are derived from the active plan; a separate top-level predictions state
must not be introduced.

## Data Ownership

### Prediction plans

Every plan is owned by this tuple:

```text
stockCode + period + planId
```

Storage buckets remain scoped by normalized stock code and period. Loaded or
imported objects must be validated against the bucket owner before they are
accepted. Invalid ownership is rejected rather than silently reassigned.

The active plan ID is independently stored for every stock and period bucket.
Switching stock or period must load that bucket's own plans and active plan.

### Replay snapshots

Replay storage remains bucketed by:

```text
stockCode + period
```

Each snapshot additionally carries `planId` and a captured `planName`. The ID
is the authoritative association. The captured name is historical display
metadata and must not override a current plan's name in selectors.

Legacy snapshots without a plan ID remain readable and are exposed through a
separate legacy filter.

## Persistence and Autosave

All plan, active-plan, and replay writes must:

1. update browser localStorage immediately;
2. queue Electron storage synchronization when the Electron bridge exists;
3. remain usable in a normal browser when the bridge is absent.

Autosave uses one stable 30-second interval. Editing a value must not recreate
or postpone the interval. The interval saves the latest state through refs or
an equivalent current-state mechanism.

Before changing stock, period, or active plan, the application flushes the
current dirty state. The manual Save button continues to save immediately and
also creates or updates replay snapshots according to the lifecycle below.

## Replay Snapshot Lifecycle

The approved V1 behavior is:

1. A saved forecast with no matching completed real K-line is pending.
2. Saving the same plan, base date, target period, and input MA again updates
   that pending snapshot instead of creating duplicate statistics.
3. Once matching completed real K-line data exists, the snapshot is resolved
   and treated as frozen historical evidence.
4. Later saves must not rewrite a resolved snapshot.
5. A forecast made from a later base date creates a new replay snapshot, even
   when it targets the same period.

Snapshot identity therefore includes stock, period, plan ID, base date, target
period, and input MA window. Resolution state is determined from current real
K-line data, not persisted as a mutable user-editable flag.

## Period-Aware Actual Data Matching

Exact date equality is not sufficient because generated period-end dates may
fall on weekends or holidays.

- Day K: match the exact completed trading date.
- Week K: match a real K-line in the same market week as the forecast target.
- Month K: match a real K-line in the same calendar month as the forecast
  target.

If more than one point exists in a period, use the latest completed point in
that period. No point from an earlier or later period may be substituted.

The same matched point is used for actual close and actual MA comparisons, so
the replay detail cannot combine values from different dates.

## Plan Limits

The application retains a maximum of 30 plans per stock and period for V1, but
must never silently delete plans.

- New, copied, or imported plans are blocked when the bucket has 30 plans.
- The UI explains the limit and asks the user to delete an existing plan.
- Loading old data never truncates it silently. If a bucket already exceeds
  the limit, all existing plans remain readable, but creation and import stay
  blocked until the count is below the limit.

## Notes

`PredictionPlan.note` is the authoritative note. Prediction-row notes remain
readable only for backward compatibility and migration.

New edits update the plan note. Replay snapshots capture the plan note at save
time. A later note edit does not rewrite a frozen replay snapshot.

## Replay Filtering

The replay filter is validated whenever stock, period, plans, or active plan
changes.

- `all` shows every snapshot in the current stock-period bucket.
- `active` shows only the active plan; when no active plan exists, it shows an
  empty result rather than all records.
- `plan:<id>` shows only that plan when it exists in current plans or replay
  history.
- `legacy` shows snapshots without a plan ID.

Invalid stale filters fall back to `active` when an active plan exists,
otherwise to `all`.

## Import and Export

Two distinct export actions remain available:

- full backup exports every application-owned localStorage record needed to
  move or restore the application;
- current-plan export exports one versioned plan document for sharing or
  duplication.

Import validates version, stock, period, plan shape, and ownership. Importing
a current-plan document adds a new uniquely named plan and does not overwrite
other plans. Full-backup import preserves the stable `main` branch behavior
and triggers Electron storage synchronization.

## UI Behavior

The existing compact layout and chart behavior are preserved.

- The plan selector and plan commands remain one coherent toolbar.
- The current-plan export action is visibly distinguishable from full backup.
- Replay opens with a valid filter for the current stock and period.
- Empty, pending, resolved, limit-reached, invalid-import, and storage-error
  states provide concise top-of-page notifications.
- No multi-plan chart comparison is added in V1.

## Compatibility and Migration

- Existing single-table prediction caches continue to migrate once into a
  default plan when no plan-format cache exists.
- Existing plan and replay V1 records remain readable.
- Old source records are not deleted during migration.
- Normalization repairs missing optional fields but rejects records whose
  explicit stock or period ownership conflicts with the current bucket.
- Browser and Electron use the same logical storage keys.

## Error Handling

Storage parsing failures return an empty or recoverable state without crashing
the page. Invalid individual records are skipped and reported where practical.
Write failures show a notification and keep in-memory edits available for a
retry.

Network-data failures do not alter locally saved plans or replay snapshots.
Replay rows remain pending until compatible completed real data is available.

## Test Strategy

Automated regression tests cover:

- plan ownership validation and legacy migration;
- active-plan isolation across stocks and periods;
- no silent plan truncation and limit enforcement;
- deep-copy behavior;
- stable filter semantics, including `active` with no plan;
- day, week, and month actual-period matching;
- pending snapshot updates and resolved snapshot freezing;
- plan-note capture;
- Electron sync calls for plan, active-plan, replay, and backup writes;
- stable autosave behavior and flush-before-context-switch where testable;
- full backup and current-plan import/export compatibility;
- existing MA calculation verification.

Browser verification covers desktop and mobile widths, plan CRUD, switching,
manual save, replay filtering/detail, refresh persistence, and preview URL
loading. Build, storage tests, MA verification, and browser checks must all pass
before deployment.

## Deployment

Only `codex-plan-replay-integrated-v1` is pushed and deployed. The preview URL
remains:

```text
https://nhtqgm.github.io/111/preview/codex-plan-replay-integrated-v1/
```

The main Pages site and `main` branch must not be modified or redeployed as
part of this work.

## Acceptance Criteria

- Existing stable features from `main` work unchanged in the preview branch.
- Plans never cross stock or period boundaries.
- Unsaved edits survive normal stock, period, and plan switching through a
  pre-switch flush.
- Browser refresh and Electron origin changes do not lose plan or replay data.
- Repeated pending saves update one snapshot; resolved snapshots do not change.
- Weekly and monthly forecasts resolve against the correct real trading period.
- Plan creation/import never silently deletes another plan.
- Replay filters never expose unrelated records.
- Both full backup and current-plan export/import are usable.
- Automated checks and browser verification pass before preview deployment.
