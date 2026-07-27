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

export interface ForecastCloseTableEntry<
  TProjection extends ProjectionCloseRow,
  TIssued extends IssuedCloseRow,
> {
  targetDate: string;
  row: TProjection | null;
  issuedRow: TIssued | undefined;
}

export function buildForecastCloseChartRows({
  projectionRows,
  issuedRows,
  historyRows,
}: {
  projectionRows: readonly ProjectionCloseRow[];
  issuedRows: readonly IssuedCloseRow[];
  historyRows: readonly HistoryCloseRow[];
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
  const actual = mergeLineValuePoints(
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
    issuedRows.flatMap((row) =>
      row.settlement
        ? [{
            targetDate: row.settlement.actualDate,
            value: row.settlement.actualClose,
          }]
        : [],
    ),
  );

  return { locked, provisional, actual };
}

export function getForecastCloseCell(
  row: ProjectionCloseRow | null,
  issuedRow?: IssuedCloseRow,
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
>(
  projectionRows: readonly TProjection[],
  issuedRows: readonly TIssued[],
  getPeriodKey: (targetDate: string) => string,
): Array<ForecastCloseTableEntry<TProjection, TIssued>> {
  const issuedByPeriod = new Map(issuedRows.map((row) => [row.periodKey, row]));
  const entries: Array<ForecastCloseTableEntry<TProjection, TIssued>> =
    projectionRows.map((row) => ({
      targetDate: row.targetDate,
      row,
      issuedRow: issuedByPeriod.get(getPeriodKey(row.targetDate)),
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
    });
  }

  return entries.sort((left, right) => {
    const leftDate = left.issuedRow?.settlement?.actualDate ?? left.targetDate;
    const rightDate = right.issuedRow?.settlement?.actualDate ?? right.targetDate;
    return leftDate.localeCompare(rightDate);
  });
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
