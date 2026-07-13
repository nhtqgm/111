import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { clearLegacyBrowserAppCache } from './utils/electronStorage';
import { bootstrapChartViewportStorage } from './utils/chartViewport';
import { bootstrapCloudPredictionOutboxStorage } from './utils/cloudOutbox';
import { bootstrapKLineCacheStorage } from './utils/kLineCache';

async function startApp() {
  const rootElement = document.getElementById('root') as HTMLElement;

  try {
    // Cloud workspaces remain the only source of prediction data. Restore only
    // durable UI/outbox state and real market history before App is imported.
    if (window.appStorageApi) {
      try {
        await bootstrapCloudPredictionOutboxStorage();
        await bootstrapChartViewportStorage();
        await bootstrapKLineCacheStorage();
      } catch (error) {
        // Damaged local state must never block cloud predictions.
        console.error('Local durable state restore failed:', error);
      }
    } else {
      clearLegacyBrowserAppCache();
      await bootstrapCloudPredictionOutboxStorage();
      await bootstrapKLineCacheStorage();
    }
  } catch (error) {
    console.error('Application data restore failed:', error);
    rootElement.textContent = '本地数据恢复失败，系统已停止自动保存。请关闭软件后重新打开。';
    return;
  }

  const { default: App } = await import('./App');
  createRoot(rootElement).render(<App />);
}

void startApp();
