import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const dir = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.API_ORIGIN || 'http://127.0.0.1:8787';

export default defineConfig({
  root: dir,
  plugins: [react()],
  base: '/',
  build: {
    outDir: path.resolve(dir, '../dist'),
    emptyOutDir: true,
    assetsDir: 'assets',
    target: 'chrome110',
    sourcemap: false,
  },
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    strictPort: false,
    proxy: Object.fromEntries(
      ['/api', '/thumb', '/blur', '/media', '/preview', '/backdrop'].map((p) => [p, { target: API, changeOrigin: false }]),
    ),
  },
});
