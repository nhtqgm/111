import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { bootstrapElectronStorage } from './utils/electronStorage';

async function startApp() {
  const rootElement = document.getElementById('root') as HTMLElement;

  try {
    await bootstrapElectronStorage();
  } catch (error) {
    console.error('Application data restore failed:', error);
    rootElement.textContent = '本地数据恢复失败，系统已停止自动保存。请关闭软件后重新打开。';
    return;
  }

  const { default: App } = await import('./App');
  createRoot(rootElement).render(<App />);
}

void startApp();
