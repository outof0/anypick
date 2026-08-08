import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = import.meta.dirname;
const external = [
  /^node:/,
  ...builtinModules,
  /^@clack\//,
  'commander',
  'ink',
  'picocolors',
  /^react(?:\/.*)?$/,
  /^react-dom(?:\/.*)?$/,
];

/**
 * Hotplug ships native Node ESM, not a browser bundle. Source imports remain
 * extensionless for authoring; Vite resolves them and emits executable `.js`
 * specifiers in dist while TypeScript emits declarations only.
 */
export default defineConfig({
  build: {
    target: 'node22',
    ssr: true,
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
    modulePreload: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(root, 'src/index.ts'),
        adapters: resolve(root, 'src/adapters.ts'),
        types: resolve(root, 'src/public-types.ts'),
        testing: resolve(root, 'src/testing.ts'),
        cli: resolve(root, 'src/cli.ts'),
        'providers/gemini-proxy/main': resolve(root, 'src/providers/gemini-proxy/main.ts'),
        'providers/grok-proxy/main': resolve(root, 'src/providers/grok-proxy/main.ts'),
      },
      preserveEntrySignatures: 'strict',
      external,
      output: {
        format: 'es',
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
});
