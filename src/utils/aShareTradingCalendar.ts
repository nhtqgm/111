import type { PeriodType } from '../types';

// Official SSE annual closure notices for 2025 and 2026. Weekend make-up
// workdays remain non-trading days for the exchange.
const OFFICIAL_CLOSURE_RANGES: ReadonlyArray<readonly [string, string]> = [
  ['2025-01-01', '2025-01-01'],
  ['2025-01-28', '2025-02-04'],
  ['2025-04-04', '2025-04-06'],
  ['2025-05-01', '2025-05-05'],
  ['2025-05-31', '2025-06-02'],
  ['2025-10-01', '2025-10-08'],
  ['2026-01-01', '2026-01-03'],
  ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'],
  ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
];

const OFFICIAL_CLOSURES = buildClosureSet(OFFICIAL_CLOSURE_RANGES);

export function generateFutureAStockDates(
  period: PeriodType,
  seed: string,
  count: number,
) {
  if (count <= 0) return [];

  const result: string[] = [];
  let cursor = parseDate(seed);

  while (result.length < count) {
    if (period === 'day') {
      cursor = nextTradingDay(cursor);
    } else if (period === 'week') {
      cursor = nextTradingWeekClose(cursor);
    } else {
      cursor = nextTradingMonthClose(cursor);
    }

    result.push(formatDate(cursor));
  }

  return result;
}

export function isAStockTradingDay(value: string | Date) {
  const date = typeof value === 'string' ? parseDate(value) : value;
  const weekday = date.getDay();
  if (weekday === 0 || weekday === 6) return false;
  return !OFFICIAL_CLOSURES.has(formatDate(date));
}

function nextTradingDay(seed: Date) {
  const candidate = addDays(seed, 1);
  while (!isAStockTradingDay(candidate)) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

function nextTradingWeekClose(seed: Date) {
  let weekStart = startOfWeek(seed);
  weekStart.setDate(weekStart.getDate() + 7);

  while (true) {
    for (let offset = 4; offset >= 0; offset -= 1) {
      const candidate = addDays(weekStart, offset);
      if (isAStockTradingDay(candidate)) return candidate;
    }
    weekStart.setDate(weekStart.getDate() + 7);
  }
}

function nextTradingMonthClose(seed: Date) {
  const candidate = new Date(seed.getFullYear(), seed.getMonth() + 2, 0);
  while (!isAStockTradingDay(candidate)) {
    candidate.setDate(candidate.getDate() - 1);
  }
  return candidate;
}

function startOfWeek(date: Date) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = result.getDay();
  result.setDate(result.getDate() + (weekday === 0 ? -6 : 1 - weekday));
  return result;
}

function buildClosureSet(ranges: ReadonlyArray<readonly [string, string]>) {
  const result = new Set<string>();
  for (const [start, end] of ranges) {
    const cursor = parseDate(start);
    const last = parseDate(end);
    while (cursor <= last) {
      result.add(formatDate(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return result;
}

function addDays(date: Date, days: number) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setDate(result.getDate() + days);
  return result;
}

function parseDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
