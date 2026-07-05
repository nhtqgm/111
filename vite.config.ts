import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'chrome108',
  },
  server: {
    proxy: {
      '/eastmoney': {
        target: 'https://push2his.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/eastmoney/, ''),
      },
    },
  },
});
