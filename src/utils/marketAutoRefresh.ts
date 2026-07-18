import { isAStockTradingDay } from './aShareTradingCalendar.ts';

export const A_SHARE_TIME_ZONE = 'Asia/Shanghai';
export const A_SHARE_OPEN_HOUR = 9;
export const A_SHARE_OPEN_MINUTE = 30;
export const A_SHARE_CLOSE_HOUR = 15;
export const A_SHARE_CLOSE_MINUTE = 10;
export const MARKET_AUTO_REFRESH_CHECK_MS = 30_000;
export const MARKET_AUTO_REFRESH_RETRY_MS = 5 * 60_000;

export type AStockRefreshPhase = 'open' | 'close';

export interface AStockRefreshEvent {
  id: string;
  date: string;
  phase: AStockRefreshPhase;
}

/**
 * Returns the latest session event that should already have been refreshed.
 * The close event intentionally uses 15:10 so the quote provider has time to
 * publish the final unadjusted close before it becomes a completed K-line.
 */
export function getDueAStockRefreshEvent(now = new Date()): AStockRefreshEvent | null {
  const clock = getShanghaiClock(now);
  if (!isAStockTradingDay(clock.date)) return null;

  if (isAtOrAfter(clock.hour, clock.minute, A_SHARE_CLOSE_HOUR, A_SHARE_CLOSE_MINUTE)) {
    return createEvent(clock.date, 'close');
  }

  if (isAtOrAfter(clock.hour, clock.minute, A_SHARE_OPEN_HOUR, A_SHARE_OPEN_MINUTE)) {
    return createEvent(clock.date, 'open');
  }

  return null;
}

export function shouldAttemptAStockRefresh(
  event: AStockRefreshEvent,
  completedEventId: string | null,
  lastAttempt: { eventId: string; at: number } | null,
  now = Date.now(),
) {
  if (completedEventId === event.id) return false;
  if (
    lastAttempt?.eventId === event.id &&
    now - lastAttempt.at < MARKET_AUTO_REFRESH_RETRY_MS
  ) {
    return false;
  }
  return true;
}

export function isAStockRefreshEventFresh(
  event: AStockRefreshEvent,
  latestCompletedDay: string | null | undefined,
) {
  return event.phase === 'open' || Boolean(latestCompletedDay && latestCompletedDay >= event.date);
}

export function getShanghaiClock(now: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: A_SHARE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const getPart = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');

  return {
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    hour: getPart('hour'),
    minute: getPart('minute'),
  };
}

function createEvent(date: string, phase: AStockRefreshPhase): AStockRefreshEvent {
  return { id: `${date}:${phase}`, date, phase };
}

function isAtOrAfter(hour: number, minute: number, targetHour: number, targetMinute: number) {
  return hour > targetHour || (hour === targetHour && minute >= targetMinute);
}
