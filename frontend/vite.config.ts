/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The dashboard calls the backend through `/api`, proxied to the Express server in dev and preview,
// so no CORS or credentials are needed in the browser bundle.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.BACKEND_URL ?? 'http://localhost:4000';
  const proxy = { '/api': { target, changeOrigin: true, rewrite: (path: string) => path.replace(/^\/api/, '') } };
  return {
    plugins: [react()],
    // Allow importing the shared demo batch from ../samples.
    server: { port: 5173, proxy, fs: { allow: ['..'] } },
    preview: { port: 4173, proxy },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
  };
});
