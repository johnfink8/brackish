import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as {
  dependencies?: Record<string, string>;
};

// Runs before any `import` resolves, so it fires even when deps would crash at load time on
// older Node. Must stay in sync with `engines.node` in package.json.
const NODE_VERSION_CHECK = `(() => {
  const p = process.versions.node.split('.').map((n) => Number.parseInt(n, 10));
  const need = [22, 0, 0];
  for (let i = 0; i < need.length; i++) {
    const have = p[i] || 0;
    if (have > need[i]) return;
    if (have < need[i]) {
      process.stderr.write('\\nbrackish-cli requires Node >= ' + need.join('.') + ' (you have v' + process.versions.node + ').\\nInstall via nvm: https://github.com/nvm-sh/nvm (per-user, no sudo)\\n\\n');
      process.exit(1);
    }
  }
})();`;

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  shims: false,
  sourcemap: true,
  banner: { js: `#!/usr/bin/env node\n${NODE_VERSION_CHECK}` },
  external: Object.keys(pkg.dependencies ?? {}),
});
