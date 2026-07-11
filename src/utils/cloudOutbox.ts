import type { PredictionEvent } from './cloudPredictions.ts';
import { uploadPredictionEvents } from './supabase.ts';
import type { User } from '@supabase/supabase-js';
import { queueElectronStorageSync } from './electronStorage.ts';

export const CLOUD_OUTBOX_KEY = 'prediction-ma40:cloud-outbox:v1';
const DEVICE_ID_KEY = 'prediction-ma40:cloud-device-id:v1';

export function getCloudDeviceId() {
  const saved = localStorage.getItem(DEVICE_ID_KEY);
  if (saved) return saved;
  const next = globalThis.crypto?.randomUUID?.() ?? `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(DEVICE_ID_KEY, next);
  return next;
}

export function loadCloudOutbox() {
  const raw = localStorage.getItem(CLOUD_OUTBOX_KEY);
  if (!raw) return [] as PredictionEvent[];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PredictionEvent[]) : [];
  } catch {
    return [];
  }
}

export function enqueueCloudEvents(events: PredictionEvent[]) {
  if (!events.length) return;
  const knownIds = new Set(loadCloudOutbox().map((event) => event.id));
  const next = [...loadCloudOutbox(), ...events.filter((event) => !knownIds.has(event.id))];
  localStorage.setItem(CLOUD_OUTBOX_KEY, JSON.stringify(next));
  void queueElectronStorageSync();
}

export async function flushCloudOutbox(user: User) {
  const pending = loadCloudOutbox();
  if (!pending.length) return 0;
  await uploadPredictionEvents(user, pending);
  const ids = new Set(pending.map((event) => event.id));
  const remaining = loadCloudOutbox().filter((event) => !ids.has(event.id));
  localStorage.setItem(CLOUD_OUTBOX_KEY, JSON.stringify(remaining));
  void queueElectronStorageSync();
  return pending.length;
}
