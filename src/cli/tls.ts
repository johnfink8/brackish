// `brackish tls gen` — a thin openssl wrapper that writes a self-signed cert+key for
// `serve --tls-cert/--tls-key`. Serving is strictly BYO (it only consumes PEM files); this is
// just convenience so a peer needn't remember the openssl incantation. No openssl on PATH →
// clear error + the manual command, and you can bring a cert+key from anywhere instead.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { brackishHome, ensureBrackishHome } from '../io/config.js';
import { certFingerprint } from '../lib/tls.js';
import { emit, errExit } from './common.js';

export function register(program: Command): void {
  const tls = program
    .command('tls')
    .description('TLS helpers for cross-machine (bring-your-own cert) serving');

  tls
    .command('gen')
    .description(
      'generate a self-signed cert + key for `serve --tls-cert/--tls-key` (wraps openssl)',
    )
    .option('--cert <path>', 'output cert path (default: ~/.brackish/cert.pem)')
    .option('--key <path>', 'output key path (default: ~/.brackish/key.pem)')
    .option('--days <n>', 'validity in days', '3650')
    .option('--cn <name>', 'cert common name (cosmetic — we pin, not match)', 'brackish')
    .option('--force', 'overwrite existing cert/key')
    .action((opts: { cert?: string; key?: string; days: string; cn: string; force?: boolean }) => {
      ensureBrackishHome();
      const certPath = opts.cert ?? join(brackishHome(), 'cert.pem');
      const keyPath = opts.key ?? join(brackishHome(), 'key.pem');
      const days = Number.parseInt(opts.days, 10);
      if (!Number.isFinite(days) || days < 1) {
        errExit(2, 'tls gen: --days must be a positive integer');
      }
      if (!opts.force && (existsSync(certPath) || existsSync(keyPath))) {
        errExit(2, `tls gen: ${certPath} or ${keyPath} already exists — pass --force to overwrite`);
      }

      // No SANs: we pin the cert by fingerprint, so hostname/SAN matching never runs. That keeps
      // the invocation to the most universal `req -x509` form (OpenSSL and macOS LibreSSL alike).
      const args = [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        String(days),
        '-subj',
        `/CN=${opts.cn}`,
      ];

      if (!opensslAvailable()) {
        errExit(
          2,
          'tls gen needs `openssl` on PATH, which was not found.\n' +
            '  Install it (macOS: built in / `brew install openssl`; Debian/Ubuntu: `apt install openssl`) and retry,\n' +
            '  or bring a cert+key from any source and point `serve --tls-cert/--tls-key` at them.\n' +
            `  Manual equivalent:\n    openssl ${args.join(' ')}`,
        );
      }

      const res = spawnSync('openssl', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
      });
      if (res.status !== 0) {
        const detail = res.stderr?.trim() || res.error?.message || '(no output)';
        errExit(2, `tls gen: openssl failed:\n${detail}`);
      }
      try {
        chmodSync(keyPath, 0o600); // it's a private key
      } catch {
        /* best effort */
      }

      const pin = certFingerprint(readFileSync(certPath, 'utf8'));
      emit(
        `wrote cert ${certPath}\n` +
          `wrote key  ${keyPath}\n` +
          `pin        ${pin}\n\n` +
          'start the daemon with TLS:\n' +
          `  brackish serve --bind 0.0.0.0 --tls-cert ${certPath} --tls-key ${keyPath}\n` +
          '`brackish invite` then prints the pin in the connect line automatically.',
      );
    });
}

/** Is `openssl` invokable? `openssl version` exits 0 when present; ENOENT sets `error`. */
function opensslAvailable(): boolean {
  const r = spawnSync('openssl', ['version'], { stdio: 'ignore' });
  return r.error === undefined && r.status === 0;
}
