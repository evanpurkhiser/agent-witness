import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

import {fileURLToPath} from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      app: fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/worker-[hash].js',
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        'service-worker': fileURLToPath(new URL('./service-worker.ts', import.meta.url)),
      },
      output: {
        entryFileNames: chunk =>
          chunk.name === 'service-worker'
            ? 'service-worker.js'
            : 'assets/[name]-[hash].js',
      },
    },
  },
  server: {
    proxy: {
      '/api/agent': {
        target: 'http://127.0.0.1:9345',
        ws: true,
      },
    },
  },
});
