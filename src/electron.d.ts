import type { PeriodType, StockKLineResponse } from './types';

export {};

declare global {
  interface Window {
    eastmoneyApi?: {
      fetchKLines: (code: string, period: PeriodType) => Promise<StockKLineResponse>;
    };
    appUpdateApi?: {
      getCurrentVersion: () => Promise<string>;
      openExternal: (url: string) => Promise<void>;
    };
    appStorageApi?: {
      bootstrap: (storage: Record<string, string>) => Promise<Record<string, string>>;
      save: (storage: Record<string, string>) => Promise<void>;
    };
  }
}
