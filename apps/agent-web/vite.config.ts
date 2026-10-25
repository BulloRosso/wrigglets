import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `pnpm --filter @cw/agent-web dev` proxies to a running agent container (default: first agent port).
const target = process.env.AGENT_URL ?? 'http://localhost:8101';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': target, '/auth': target, '/health': target },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1500 },
});
