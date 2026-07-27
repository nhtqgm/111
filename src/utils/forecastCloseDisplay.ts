import type { LineValuePoint } from './movingAverage.ts';
import { mergeLineValuePoints } from './linePoints.ts';

interface ProjectionCloseRow {
  targetDate: string;
  actualClose: number | null;
  derivedClose: number | null;
  isForecast: boolean;
}

interface IssuedCloseRow {
  targetDate: string;
  predictedClose: number;
  settlement: {
    actualDate: string;
    actualClose: number;
  } | null;
}

interface HistoryCloseRow {
  targetDate: string;
  actualDate: string | null;
  predictedClose: number;
  actualClose: number | null;
}

export interface ForecastCloseChartRows {
  locked: LineValuePoint[];
  provisional: LineValuePoint[];
  actual: LineValuePoint[];
}

export interface ForecastCloseCell {
  kind: 'provisional' | 'actual';
  label: '实时暂估' | '真实收盘价';
  value: number | null;
}

export interface ActualCloseContext {
  actualDate: string;
  actualClose: number;
}

export function getLatestActualCloseContext(
  points: readonly { date: string; close: number }[],
  baseDate: string,
): ActualCloseContext | null {
  return points.reduce<ActualCloseContext | null>((latest, point) => {
    if (
      point.date > baseDate ||
      !Number.isFinite(point.close) ||
      (latest && point.date <= latest.actualDate)
    ) {
      return latest;
    }
    return {
      actualDate: point.date,
      actualClose: point.close,
    };
  }, null);
}

export interface ForecastCloseTableEntry<
  TProjection extends ProjectionCloseRow,
  TIssued extends IssuedCloseRow,
  THistory extends HistoryCloseRow,
> {
  targetDate: string;
  row: TProjection | null;
  issuedRow: TIssued | undefined;
  historyRow: THistory | undefined;
  actualCloseContext: ActualCloseContext | undefined;
}

export function buildForecastCloseChartRows({
  projectionRows,
  issuedRows,
  historyRows,
  actualCloseContexts = [],
  getPeriodKey = identityPeriodKey,
}: {
  projectionRows: readonly ProjectionCloseRow[];
  issuedRows: readonly IssuedCloseRow[];
  historyRows: readonly HistoryCloseRow[];
  actualCloseContexts?: readonly ActualCloseContext[];
  getPeriodKey?: (targetDate: string) => string;
}): ForecastCloseChartRows {
  const locked = mergeLineValuePoints(
    historyRows.map((row) => ({
      targetDate: row.actualDate ?? row.targetDate,
      value: row.predictedClose,
    })),
    issuedRows.map((row) => ({
      targetDate: row.settlement?.actualDate ?? row.targetDate,
      value: row.predictedClose,
    })),
  );
  const provisional = projectionRows
    .filter((row) => row.isForecast && row.derivedClose !== null)
    .map((row) => ({
      targetDate: row.targetDate,
      value: row.derivedClose,
    }));
  const actual = mergeActualLineValuePointsByPeriod(
    getPeriodKey,
    issuedRows.flatMap((row) =>
      row.settlement
        ? [{
            targetDate: row.settlement.actualDate,
            value: row.settlement.actualClose,
          }]
        : [],
    ),
    projectionRows
      .filter((row) => !row.isForecast && row.actualClose !== null)
      .map((row) => ({
        targetDate: row.targetDate,
        value: row.actualClose,
      })),
    historyRows
      .filter((row) => row.actualClose !== null)
      .map((row) => ({
        targetDate: row.actualDate ?? row.targetDate,
        value: row.actualClose,
      })),
    actualCloseContexts.map((context) => ({
      targetDate: context.actualDate,
      value: context.actualClose,
    })),
  );

  return { locked, provisional, actual };
}

export function getForecastCloseCell(
  row: ProjectionCloseRow | null,
  issuedRow?: IssuedCloseRow,
  historyRow?: HistoryCloseRow,
  actualCloseContext?: ActualCloseContext,
): ForecastCloseCell {
  if (issuedRow?.settlement) {
    return {
      kind: 'actual',
      label: '真实收盘价',
      value: issuedRow.settlement.actualClose,
    };
  }
  if (row && !row.isForecast && row.actualClose !== null) {
    return {
      kind: 'actual',
      label: '真实收盘价',
      value: row.actualClose,
    };
  }
  if (historyRow?.actualClose !== null && historyRow?.actualClose !== undefined) {
    return {
      kind: 'actual',
      label: '真实收盘价',
      value: historyRow.actualClose,
    };
  }
  if (!row && !issuedRow && !historyRow && actualCloseContext) {
    return {
      kind: 'actual',
      label: '真实收盘价',
      value: actualCloseContext.actualClose,
    };
  }
  return {
    kind: 'provisional',
    label: '实时暂估',
    value: row?.derivedClose ?? null,
  };
}

export function getLatestSettledTargetDate(rows: readonly IssuedCloseRow[]) {
  return findLatestSettledRow(rows)?.targetDate ?? null;
}

export function getLatestCompletedTargetDate(
  projectionRows: readonly ProjectionCloseRow[],
  issuedRows: readonly IssuedCloseRow[],
) {
  const latestProjectionDate = projectionRows.reduce<string | null>(
    (latest, row) =>
      !row.isForecast &&
      row.actualClose !== null &&
      (!latest || row.targetDate > latest)
        ? row.targetDate
        : latest,
    null,
  );
  const latestSettledDate = getLatestSettledTargetDate(issuedRows);
  if (!latestProjectionDate) return latestSettledDate;
  if (!latestSettledDate) return latestProjectionDate;
  return latestProjectionDate > latestSettledDate
    ? latestProjectionDate
    : latestSettledDate;
}

export function buildForecastCloseTableRows<
  TProjection extends ProjectionCloseRow,
  TIssued extends IssuedCloseRow & { periodKey: string },
  THistory extends HistoryCloseRow,
>(
  projectionRows: readonly TProjection[],
  issuedRows: readonly TIssued[],
  historyRows: readonly THistory[],
  getPeriodKey: (targetDate: string) => string,
  actualCloseContext?: ActualCloseContext | null,
): Array<ForecastCloseTableEntry<TProjection, TIssued, THistory>> {
  const issuedByPeriod = new Map(issuedRows.map((row) => [row.periodKey, row]));
  const historyByPeriod = new Map(
    historyRows.map((row) => [
      getPeriodKey(row.actualDate ?? row.targetDate),
      row,
    ]),
  );
  const entries: Array<ForecastCloseTableEntry<TProjection, TIssued, THistory>> =
    projectionRows.map((row) => ({
      targetDate: row.targetDate,
      row,
      issuedRow: issuedByPeriod.get(getPeriodKey(row.targetDate)),
      historyRow: historyByPeriod.get(getPeriodKey(row.targetDate)),
      actualCloseContext: undefined,
    }));
  const latestSettledRow = findLatestSettledRow(issuedRows);

  if (
    latestSettledRow &&
    !entries.some(
      (entry) => getPeriodKey(entry.targetDate) === latestSettledRow.periodKey,
    )
  ) {
    entries.push({
      targetDate: latestSettledRow.targetDate,
      row: null,
      issuedRow: latestSettledRow,
      historyRow: historyByPeriod.get(latestSettledRow.periodKey),
      actualCloseContext: undefined,
    });
  }

  for (const [periodKey, historyRow] of historyByPeriod) {
    if (
      entries.some(
        (entry) => getPeriodKey(entry.targetDate) === periodKey,
      )
    ) {
      continue;
    }
    entries.push({
      targetDate: historyRow.targetDate,
      row: null,
      issuedRow: issuedByPeriod.get(periodKey),
      historyRow,
      actualCloseContext: undefined,
    });
  }

  if (actualCloseContext) {
    const contextPeriodKey = getPeriodKey(actualCloseContext.actualDate);
    const hasCompletedActual = entries.some(
      (entry) =>
        getPeriodKey(entry.targetDate) === contextPeriodKey &&
        hasCompletedActualClose(entry),
    );

    if (!hasCompletedActual) {
      entries.push({
        targetDate: actualCloseContext.actualDate,
        row: null,
        issuedRow: undefined,
        historyRow: undefined,
        actualCloseContext,
      });
    }
  }

  return entries.sort((left, right) => {
    const leftDate =
      left.issuedRow?.settlement?.actualDate ??
      left.historyRow?.actualDate ??
      left.actualCloseContext?.actualDate ??
      left.targetDate;
    const rightDate =
      right.issuedRow?.settlement?.actualDate ??
      right.historyRow?.actualDate ??
      right.actualCloseContext?.actualDate ??
      right.targetDate;
    return leftDate.localeCompare(rightDate);
  });
}

function hasCompletedActualClose<
  TProjection extends ProjectionCloseRow,
  TIssued extends IssuedCloseRow,
  THistory extends HistoryCloseRow,
>(entry: ForecastCloseTableEntry<TProjection, TIssued, THistory>) {
  return Boolean(
    entry.issuedRow?.settlement ||
    (entry.row && !entry.row.isForecast && entry.row.actualClose !== null) ||
    (entry.historyRow && entry.historyRow.actualClose !== null),
  );
}

function mergeActualLineValuePointsByPeriod(
  getPeriodKey: (targetDate: string) => string,
  ...groups: LineValuePoint[][]
) {
  const values = new Map<string, LineValuePoint>();
  for (const row of groups.flat()) {
    if (row.value === null) continue;
    const periodKey = getPeriodKey(row.targetDate);
    if (!values.has(periodKey)) values.set(periodKey, row);
  }
  return [...values.values()].sort((left, right) =>
    left.targetDate.localeCompare(right.targetDate),
  );
}

function identityPeriodKey(targetDate: string) {
  return targetDate;
}

function findLatestSettledRow<TIssued extends IssuedCloseRow>(
  rows: readonly TIssued[],
): TIssued | null {
  return rows.reduce<TIssued | null>((latest, row) => {
    if (!row.settlement) return latest;
    if (!latest || row.settlement.actualDate > latest.settlement!.actualDate) {
      return row;
    }
    return latest;
  }, null);
}
