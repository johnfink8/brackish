#!/usr/bin/env node
// `preinstall` hook: a hard version gate so `npm i` aborts on too-old Node instead of just warning.
// Pure Node + builtins only — deps aren't installed yet at preinstall time.

// Must match package.json `engines.node`.
const REQUIRED = [22, 0, 0];
const current = process.versions.node;
const parts = current.split('.').map((n) => Number.parseInt(n, 10));

function isOk() {
  for (let i = 0; i < REQUIRED.length; i++) {
    const have = parts[i] ?? 0;
    const need = REQUIRED[i];
    if (have > need) return true;
    if (have < need) return false;
  }
  return true;
}

if (isOk()) process.exit(0);

const msg = [
  '',
  `  brackish-cli requires Node >= ${REQUIRED.join('.')} (you have v${current}).`,
  '',
  '  Runtime dependencies (undici, better-sqlite3, @hono/node-server) need Node 22+;',
  '  loading them on older Node fails with cryptic errors like',
  '  `ReferenceError: File is not defined` or `webidl.util.markAsUncloneable is not a function`.',
  '',
  '  Install Node 22 via nvm (per-user, no sudo, easy to bump later):',
  '    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash',
  '    . ~/.nvm/nvm.sh && nvm install 22 && nvm use 22',
  '',
  '  Alternatives: https://nodejs.org/ or a system package manager (e.g. NodeSource for Debian/Ubuntu).',
  '',
].join('\n');

process.stderr.write(`${msg}\n`);
process.exit(1);
