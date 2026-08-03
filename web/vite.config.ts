import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** Keeps the listener on one origin while Express remains the API authority. */
export default defineConfig({
  base: '/listen/',
  plugins: [react()],
  build: {
    manifest: true,
    outDir: 'dist'
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/auth': 'http://127.0.0.1:8080',
      '/content': 'http://127.0.0.1:8080',
      '/feed': 'http://127.0.0.1:8080',
      '/video': 'http://127.0.0.1:8080',
      '/api': 'http://127.0.0.1:8080'
    }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    globals: true,
    restoreMocks: true
  }
});
