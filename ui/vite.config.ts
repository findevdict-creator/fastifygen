import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Built into dist/ui-app, which `fastifygen ui` serves. In development,
// run `fastifygen ui` on port 4321 and `npm run dev:ui`; Vite proxies /api to it.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/ui-app', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: { '/api': { target: 'http://127.0.0.1:4321', changeOrigin: true } },
  },
});
