import type { PeriodType } from '../types';

export const ALL_KLINE_PERIODS: PeriodType[] = ['day', 'week', 'month'];

export type PeriodRefreshResult<T> =
  | { period: PeriodType; status: 'success'; data: T }
  | { period: PeriodType; status: 'failed'; error: string };

export async function refreshAllKLinePeriods<T>(
  load: (period: PeriodType) => Promise<T>,
): Promise<PeriodRefreshResult<T>[]> {
  return Promise.all(
    ALL_KLINE_PERIODS.map(async (period) => {
      try {
        return { period, status: 'success', data: await load(period) } as const;
      } catch (error) {
        return {
          period,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        } as const;
      }
    }),
  );
}
