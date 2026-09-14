import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

/** Keeps the listener on one origin while Express remains the API authority. */
export default defineConfig({
  base: '/finitude/',
  plugins: [react()],
  build: {
    manifest: true,
    outDir: 'dist',
    rollupOptions: {
      output: {
        onlyExplicitManualChunks: true,
        // Vite preloads the dependency graph; redundant import stubs add bytes to every lazy route.
        hoistTransitiveImports: false,
        // Keep hashed URLs compact in import/preload tables; the manifest retains readable names.
        chunkFileNames: 'assets/c-[hash].js',
        manualChunks: (id) => {
          // The renderer has no application imports and can be cached across listener changes.
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react-runtime';
          // Shared helpers must not make the room runtime eagerly load the social identity page.
          return id.endsWith('/web/src/features/social/SocialPage.module.css')
            || id.endsWith('/web/src/api/socialSchemas.ts')
            || id.endsWith('/web/src/api/socialReadRequest.ts')
            || id.endsWith('/web/src/api/socialFailure.ts') ? 'social-shared' : undefined;
        }
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/auth': 'http://127.0.0.1:8080',
      '/content': 'http://127.0.0.1:8080',
      '/feed': 'http://127.0.0.1:8080',
      '/video': 'http://127.0.0.1:8080',
      '/api': { target: 'http://127.0.0.1:8080', ws: true }
    }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    exclude: [...configDefaults.exclude, 'e2e/**', 'e2e-social/**'],
    css: true,
    globals: true,
    restoreMocks: true
  }
});
