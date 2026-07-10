export interface StableIntervalApi {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(id: unknown): void;
}

export function createStableAutosave(
  initialCallback: () => void,
  intervalMs: number,
  api: StableIntervalApi,
) {
  let callback = initialCallback;
  let disposed = false;
  const intervalId = api.setInterval(() => callback(), intervalMs);

  return {
    update(nextCallback: () => void) {
      callback = nextCallback;
    },
    dispose() {
      if (disposed) return;

      disposed = true;
      api.clearInterval(intervalId);
    },
  };
}

export function runWorkspaceTransition(
  hasUnsavedChanges: boolean,
  flush: () => void,
  change: () => void,
) {
  if (hasUnsavedChanges) flush();
  change();
}
