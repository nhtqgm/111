import type { KLinePoint, PeriodType, StockKLineResponse } from '../types';

const MARKET_TIME_ZONE = 'Asia/Shanghai';
const MARKET_CLOSE_HOUR = 15;
const MARKET_CLOSE_MINUTE = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

interface DateParts {
  year: number;
  month: number;
  day: number;
}

interface MarketClock extends DateParts {
  hour: number;
  minute: number;
  weekDay: number;
}

export interface CompletedKLineData {
  data: StockKLineResponse;
  removedPoints: KLinePoint[];
  lastCompletedDate: string | null;
}

export function filterCompletedKLineData(
  data: StockKLineResponse,
  period: PeriodType,
  now = new Date(),
): CompletedKLineData {
  const clock = getMarketClock(now);
  const completedPoints: KLinePoint[] = [];
  const removedPoints: KLinePoint[] = [];

  for (const point of data.points) {
    if (isCompletedKLineDateWithClock(point.date, period, clock)) {
      completedPoints.push(point);
    } else {
      removedPoints.push(point);
    }
  }

  return {
    data: {
      ...data,
      points: completedPoints,
    },
    removedPoints,
    lastCompletedDate: completedPoints.at(-1)?.date ?? null,
  };
}

export function isCompletedKLineDate(date: string, period: PeriodType, now = new Date()) {
  return isCompletedKLineDateWithClock(date, period, getMarketClock(now));
}

function isCompletedKLineDateWithClock(date: string, period: PeriodType, clock: MarketClock) {
  const pointDate = parseDateParts(date);
  if (!pointDate) return false;
  if (compareDate(pointDate, clock) > 0) return false;

  if (period === 'day') return isCompletedDay(pointDate, clock);
  if (period === 'week') return isCompletedWeek(pointDate, clock);
  return isCompletedMonth(pointDate, clock);
}

function isCompletedDay(pointDate: DateParts, clock: MarketClock) {
  const dateComparison = compareDate(pointDate, clock);
  return dateComparison < 0 || (dateComparison === 0 && hasMarketClosed(clock));
}

function isCompletedWeek(pointDate: DateParts, clock: MarketClock) {
  const pointWeekStart = getWeekStart(pointDate);
  const currentWeekStart = getWeekStart(clock);
  const weekComparison = compareDate(pointWeekStart, currentWeekStart);

  if (weekComparison < 0) return true;
  if (weekComparison > 0) return false;

  return isCurrentWeekClosed(clock);
}

function isCompletedMonth(pointDate: DateParts, clock: MarketClock) {
  const monthComparison = compareYearMonth(pointDate, clock);
  if (monthComparison < 0) return true;
  if (monthComparison > 0) return false;

  const lastWeekday = getLastWeekdayOfMonth(clock.year, clock.month);
  const lastWeekdayComparison = compareDate(clock, lastWeekday);
  return lastWeekdayComparison > 0 || (lastWeekdayComparison === 0 && hasMarketClosed(clock));
}

function isCurrentWeekClosed(clock: MarketClock) {
  return clock.weekDay === 6 || clock.weekDay === 0 || (clock.weekDay === 5 && hasMarketClosed(clock));
}

function hasMarketClosed(clock: MarketClock) {
  if (clock.weekDay === 0 || clock.weekDay === 6) return true;
  return (
    clock.hour > MARKET_CLOSE_HOUR ||
    (clock.hour === MARKET_CLOSE_HOUR && clock.minute >= MARKET_CLOSE_MINUTE)
  );
}

function getMarketClock(now: Date): MarketClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const getPart = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const dateParts = {
    year: getPart('year'),
    month: getPart('month'),
    day: getPart('day'),
  };

  return {
    ...dateParts,
    hour: getPart('hour'),
    minute: getPart('minute'),
    weekDay: getWeekDay(dateParts),
  };
}

function parseDateParts(value: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const dateParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };

  if (
    dateParts.month < 1 ||
    dateParts.month > 12 ||
    dateParts.day < 1 ||
    dateParts.day > daysInMonth(dateParts.year, dateParts.month)
  ) {
    return null;
  }

  return dateParts;
}

function compareDate(left: DateParts, right: DateParts) {
  return toDayNumber(left) - toDayNumber(right);
}

function compareYearMonth(left: DateParts, right: DateParts) {
  if (left.year !== right.year) return left.year - right.year;
  return left.month - right.month;
}

function getWeekStart(date: DateParts): DateParts {
  const weekDay = getWeekDay(date);
  const mondayOffset = weekDay === 0 ? 6 : weekDay - 1;
  return fromDayNumber(toDayNumber(date) - mondayOffset);
}

function getLastWeekdayOfMonth(year: number, month: number): DateParts {
  let date = {
    year,
    month,
    day: daysInMonth(year, month),
  };

  while ([0, 6].includes(getWeekDay(date))) {
    date = fromDayNumber(toDayNumber(date) - 1);
  }

  return date;
}

function getWeekDay(date: DateParts) {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function toDayNumber(date: DateParts) {
  return Date.UTC(date.year, date.month - 1, date.day) / DAY_MS;
}

function fromDayNumber(dayNumber: number): DateParts {
  const date = new Date(dayNumber * DAY_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
