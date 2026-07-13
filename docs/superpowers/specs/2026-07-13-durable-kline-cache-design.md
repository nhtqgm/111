# Durable K-Line Cache Design

## Goal

Persist real historical day, week, and month K-line data so the web app and
the packaged EXE can restore the latest successful market data after a page
refresh or application restart without a network connection.

## Boundaries

- Cache only real market K-line responses and the last viewed stock/period.
- Do not cache, restore, or overwrite cloud prediction values.
- Keep the cache local to the current browser or EXE installation.
- Preserve the existing rule that cloud data is the source of truth for user
  predictions.

## Storage Design

Use versioned localStorage entries under
`prediction-ma40:kline-cache:<stock>:<period>:v1`. Store `updatedAt` with every
entry so Electron can merge the newest copy when switching between the remote
GitHub Pages UI and the bundled offline UI.

Store the last viewed market scope separately under
`prediction-ma40:kline-cache:last-scope:v1`. This contains only stock code,
period, and timestamp.

In Electron, bootstrap only K-line cache entries through `appStorageApi`. Do
not restore other historical `prediction-ma*` entries into browser storage.

## Application Flow

1. Before React renders, restore valid K-line cache entries from Electron's
   durable application store.
2. Initialize the selected stock and period from the cached market scope.
3. When the selected stock or period changes, prefer the current in-memory
   response and otherwise load the persisted K-line response.
4. After every successful online refresh, persist each successful day/week/
   month response before updating the chart.
5. If a refresh fails, retain and display the persisted response.

## Validation

Reject malformed cache records, mismatched stock codes or periods, invalid
dates, and invalid OHLC values. A bad entry must be ignored without preventing
the application from starting.

## Verification

- Unit tests for save, load, validation, scope restore, and Electron bootstrap.
- Static integration assertions for App startup loading and refresh saving.
- Existing storage, chart, history, refresh, cloud, MA, and build checks.

