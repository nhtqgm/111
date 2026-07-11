import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { bootstrapElectronStorage, clearLegacyBrowserAppCache } from './utils/electronStorage';

async function startApp() {
  const rootElement = document.getElementById('root') as HTMLElement;

  try {
    await bootstrapElectronStorage();
    // Browser storage from the pre-cloud versions is never a source of truth.
    // This runs before App is imported, so legacy values cannot enter React state.
    if (!window.appStorageApi) {
      clearLegacyBrowserAppCache();
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
