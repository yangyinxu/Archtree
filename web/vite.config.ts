import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

/** Keeps the listener on one origin while Express remains the API authority. */
export default defineConfig(({ command, mode }) => ({
  base: '/finitude/',
  plugins: [react()],
  // One isolated module asset includes LAME and its runtime; it never enters a listener route bundle.
  worker: { format: 'es', rollupOptions: { output: { inlineDynamicImports: true } } },
  css: {
    modules: {
      // Production transfers compact identifiers; development and tests retain readable names.
      generateScopedName: command === 'build' && mode === 'production'
        ? 'f_[hash:base64:6]' : undefined
    }
  },
  build: {
    manifest: true,
    outDir: 'dist',
    modulePreload: {
      // Pure helpers reuse the active application's core; keep CSS preloads for visible lazy screens.
      resolveDependencies: (_file, dependencies, context) => context.hostType === 'js'
        && !dependencies.some(file => file.endsWith('.css')) ? [] : dependencies
    },
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
            || id.endsWith('/web/src/api/roomClientId.ts')
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
    include: [...configDefaults.include.map(pattern => `src/${pattern}`), 'scripts/*.test.mjs'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    exclude: [...configDefaults.exclude, 'e2e/**', 'e2e-social/**'],
    css: true,
    globals: true,
    // Vitest 4 restores spies without clearing their call history; keep tests independent.
    clearMocks: true,
    restoreMocks: true
  }
}));
