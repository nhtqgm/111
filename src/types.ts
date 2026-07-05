export type PeriodType = 'day' | 'week' | 'month';

export interface KLinePoint {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
  amplitude: number;
  pctChange: number;
  change: number;
  turnover: number;
}

export interface StockKLineResponse {
  code: string;
  name: string;
  market: number;
  sourceName?: string;
  points: KLinePoint[];
}

export interface PredictionPoint {
  targetDate: string;
  predictedMa40: string;
  note: string;
}

export interface ComparisonRow extends PredictionPoint {
  actualClose: number | null;
  derivedClose: number | null;
  diff: number | null;
  diffPct: number | null;
}
