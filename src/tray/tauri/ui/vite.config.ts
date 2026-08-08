import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = import.meta.dirname;
const repoRoot = resolve(root, '../../../..');
const require = createRequire(import.meta.url);
const reactPath = dirname(require.resolve('react/package.json'));
const reactDomPath = dirname(require.resolve('react-dom/package.json'));

/** Browser bundle for the Tauri helper. Source lives in ui/; output is frontend/. */
export default defineConfig({
  root,
  // Resolve deps from the monorepo root so pnpm + nested Vite root share one React.
  envDir: repoRoot,
  publicDir: resolve(root, 'assets'),
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    // pnpm can surface react under both react@… and react-dom@…/node_modules/react.
    // Without this, the hook dispatcher and the renderer disagree → Invalid hook call.
    dedupe: ['react', 'react-dom'],
    alias: {
      react: reactPath,
      'react-dom': reactDomPath,
      'react/jsx-runtime': resolve(reactPath, 'jsx-runtime.js'),
      'react/jsx-dev-runtime': resolve(reactPath, 'jsx-dev-runtime.js'),
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  },
  build: {
    outDir: resolve(root, '../frontend'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      input: resolve(root, 'index.html'),
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4178,
    strictPort: true,
    fs: {
      allow: [repoRoot],
    },
  },
});
