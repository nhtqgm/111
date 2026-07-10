import type { PeriodType } from '../types.ts';

export interface StockPeriodWorkspace {
  stockCode: string;
  period: PeriodType;
}

export function getStockPeriodWorkspaceKey(stockCode: string, period: PeriodType) {
  return `${stockCode.replace(/\D/g, '').slice(0, 6)}:${period}`;
}

export function isLoadedWorkspaceReady(
  expectedWorkspaceKey: string,
  loadedDataWorkspaceKey: string | null,
  loadedPlansWorkspaceKey: string | null,
) {
  return (
    loadedDataWorkspaceKey === expectedWorkspaceKey &&
    loadedPlansWorkspaceKey === expectedWorkspaceKey
  );
}

export function canConsumeDeferredPlanImport(
  importedPlan: StockPeriodWorkspace | null,
  expectedWorkspaceKey: string,
  loadedDataWorkspaceKey: string | null,
) {
  return (
    importedPlan !== null &&
    getStockPeriodWorkspaceKey(importedPlan.stockCode, importedPlan.period) ===
      expectedWorkspaceKey &&
    loadedDataWorkspaceKey === expectedWorkspaceKey
  );
}
