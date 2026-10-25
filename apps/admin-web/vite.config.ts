import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.ADMIN_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: { '/api': target, '/auth': target, '/health': target } },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1500 },
});
