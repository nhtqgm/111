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

export function clearCloudOutbox() {
  localStorage.removeItem(CLOUD_OUTBOX_KEY);
  void queueElectronStorageSync();
}
