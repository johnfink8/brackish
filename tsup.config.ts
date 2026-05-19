import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as {
  dependencies?: Record<string, string>;
};

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  shims: false,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  external: Object.keys(pkg.dependencies ?? {}),
});
