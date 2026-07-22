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
});
