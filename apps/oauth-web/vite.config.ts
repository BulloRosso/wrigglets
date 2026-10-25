import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.OAUTH_URL ?? 'http://localhost:9000';

export default defineConfig({
  plugins: [react()],
  server: { port: 5175, proxy: { '/interaction': { target, bypass: (req) => (req.headers.accept?.includes('text/html') ? '/index.html' : undefined) } } },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500 },
});
