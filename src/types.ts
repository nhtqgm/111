export type PeriodType = 'day' | 'week' | 'month';

export type Horizon = 5 | 10 | 20;

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
  points: KLinePoint[];
}

export interface PredictionPoint {
  targetDate: string;
  predictedClose: string;
  note: string;
}

export interface ComparisonRow extends PredictionPoint {
  actualClose: number | null;
  diff: number | null;
  diffPct: number | null;
}
