import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { clearLegacyBrowserAppCache } from './utils/electronStorage';
import { bootstrapChartViewportStorage } from './utils/chartViewport';
import { bootstrapCloudPredictionOutboxStorage } from './utils/cloudOutbox';
import { bootstrapCloudHistoryOutboxStorage } from './utils/cloudHistoryStorage';

async function startApp() {
  const rootElement = document.getElementById('root') as HTMLElement;

  try {
    // Cloud workspaces are the only business-data source. Do not bootstrap
    // the old Electron/localStorage cache before rendering the application.
    // Browser storage from the pre-cloud versions is never a source of truth.
    // This runs before App is imported, so legacy values cannot enter React state.
    if (window.appStorageApi) {
      try {
        await bootstrapCloudPredictionOutboxStorage();
        await bootstrapCloudHistoryOutboxStorage();
        await bootstrapChartViewportStorage();
      } catch (error) {
        // Damaged local UI/outbox storage must never block cloud predictions.
        console.error('Local durable state restore failed:', error);
      }
    } else {
      clearLegacyBrowserAppCache();
      await bootstrapCloudPredictionOutboxStorage();
      await bootstrapCloudHistoryOutboxStorage();
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
