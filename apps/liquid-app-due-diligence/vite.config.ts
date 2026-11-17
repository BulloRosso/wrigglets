import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// relative base: the app host serves the app below /apps/<id>/
export default defineConfig({ base: './', plugins: [react()], build: { outDir: 'dist', emptyOutDir: true } });
