import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import type { PredictionEvent } from './cloudPredictions.ts';
import type { CloudPredictionValueMutation } from './cloudPredictionStorage.ts';
import type { CloudWorkspace } from './cloudWorkspace.ts';
import type { ForecastHistorySnapshot } from './forecastHistory.ts';
import type { PeriodType } from '../types.ts';

export type CloudRole = 'user' | 'admin';

export interface CloudProfile {
  userId: string;
  role: CloudRole;
}

export interface CloudWorkspaceRecord {
  revision: number;
  payload: CloudWorkspace;
  updatedAt: string;
}

const projectUrl = import.meta.env.VITE_SUPABASE_URL ?? 'https://svupnipcyekyvdhhpbec.supabase.co';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

let client: SupabaseClient | null = null;

export function isCloudSyncConfigured() {
  return Boolean(projectUrl && anonKey);
}

export function getSupabaseClient() {
  if (!isCloudSyncConfigured()) return null;
  client ??= createClient(projectUrl, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

export async function getCloudUser() {
  const api = getSupabaseClient();
  if (!api) return null;
  const { data, error } = await api.auth.getUser();
  if (error) return null;
  return data.user;
}

export async function signInToCloud(email: string, password: string) {
  const api = requireCloudClient();
  const { data, error } = await api.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signUpForCloud(email: string, password: string) {
  const api = requireCloudClient();
  const { data, error } = await api.auth.signUp({ email, password });
  if (error) throw error;
  return { user: data.user, needsEmailConfirmation: !data.session };
}

export async function signOutOfCloud() {
  const api = getSupabaseClient();
  if (!api) return;
  const { error } = await api.auth.signOut({ scope: 'local' });
  if (error) throw error;
}

export async function replaceCloudPredictionEvents(_user: User, events: PredictionEvent[]) {
  const api = requireCloudClient();
  const { error } = await api.rpc('replace_prediction_events', {
    events: events.map((event) => ({
      id: event.id,
      stock_code: event.stockCode,
      period: event.period,
      target_date: event.targetDate,
      metric: event.metric,
      event_type: event.eventType,
      value: event.value === null ? null : Number(event.value),
      client_event_at: event.clientEventAt,
      device_id: event.deviceId,
    })),
  });
  if (error) throw error;
}

export async function getCloudProfile(): Promise<CloudProfile | null> {
  const api = requireCloudClient();
  const { data, error } = await api.rpc('get_my_profile');
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : null;
  if (!row || typeof row.user_id !== 'string' || (row.role !== 'user' && row.role !== 'admin')) return null;
  return { userId: row.user_id, role: row.role };
}

export async function loadMyCloudWorkspace(): Promise<CloudWorkspaceRecord | null> {
  const api = requireCloudClient();
  const { data, error } = await api.rpc('get_my_prediction_workspace');
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return null;
  if (
    !row.payload ||
    typeof row.payload !== 'object' ||
    (row.payload as CloudWorkspace).schema !== 'gupiao-cloud-workspace/v1'
  ) {
    throw new Error('Cloud workspace payload is invalid.');
  }
  return {
    revision: 0,
    payload: row.payload as CloudWorkspace,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
  };
}

export async function replaceMyCloudWorkspace(workspace: CloudWorkspace) {
  const api = requireCloudClient();
  const { error } = await api.rpc('replace_my_prediction_workspace', {
    p_payload: workspace,
  });
  if (error) throw error;
}

export async function saveMyPredictionValues(mutations: CloudPredictionValueMutation[]) {
  if (!mutations.length) return;
  const api = requireCloudClient();
  const { error } = await api.rpc('save_my_prediction_values', {
    p_values: mutations.map((mutation) => ({
      stock_code: mutation.stockCode,
      period: mutation.period,
      target_date: mutation.targetDate,
      metric: mutation.metric,
      value: mutation.value,
    })),
  });
  if (error) throw error;
}

export async function saveMyWorkspacePreferences(
  stockCode: string,
  period: PeriodType,
  baseDate: string,
) {
  const api = requireCloudClient();
  const { error } = await api.rpc('save_my_workspace_preferences', {
    p_stock_code: stockCode,
    p_period: period,
    p_base_date: baseDate || null,
  });
  if (error) throw error;
}

export async function upsertMyForecastHistory(snapshots: ForecastHistorySnapshot[]) {
  if (!snapshots.length) return;
  const api = requireCloudClient();
  const { error } = await api.rpc('upsert_my_forecast_history', { p_snapshots: snapshots });
  if (error) throw error;
}

export async function downloadPredictionEvents(user: User) {
  const api = requireCloudClient();
  const { data, error } = await api
    .from('prediction_events')
    .select('id, stock_code, period, target_date, metric, event_type, value, device_id, client_event_at, created_at')
    .eq('user_id', user.id)
    .order('client_event_at', { ascending: true });
  if (error) throw error;

  return (data ?? []).flatMap((row) => {
    if (
      typeof row.id !== 'string' ||
      typeof row.stock_code !== 'string' ||
      !['day', 'week', 'month'].includes(row.period) ||
      typeof row.target_date !== 'string' ||
      !['close', 'ma5', 'ma10', 'ma20', 'ma40', 'ma60'].includes(row.metric) ||
      !['set', 'clear'].includes(row.event_type) ||
      typeof row.client_event_at !== 'string' ||
      typeof row.created_at !== 'string' ||
      typeof row.device_id !== 'string'
    ) {
      return [];
    }
    return [
      {
        id: row.id,
        stockCode: row.stock_code,
        period: row.period,
        targetDate: row.target_date,
        metric: row.metric,
        eventType: row.event_type,
        value:
          row.value === null || !Number.isFinite(Number(row.value))
            ? null
            : Number(row.value).toFixed(4),
        deviceId: row.device_id,
        clientEventAt: row.client_event_at,
        createdAt: row.created_at,
      } satisfies PredictionEvent,
    ];
  });
}

function requireCloudClient() {
  const api = getSupabaseClient();
  if (!api) throw new Error('Cloud sync is not configured yet.');
  return api;
}
