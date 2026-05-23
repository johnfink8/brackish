// `brackish demo` — one-shot ephemeral daemon + replay a real chat-app trial + print browser URL.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { BrackishClient, redeemInvite } from '../client/client.js';
import { startServer } from '../daemon/server.js';
import { DEFAULT_DEMO_ADMIN, DEFAULT_DEMO_DOCUMENT, seedDemo } from '../demo.js';
import { errExit } from './common.js';

export function register(program: Command): void {
  program
    .command('demo [doc]')
    .description(
      "one-shot: starts an ephemeral brackish daemon in a tmp sandbox, replays a real chat-app trial (extracted from harness output — backend + frontend Claudes negotiating an OpenAPI doc, including one substantive rejection), and prints a ready-to-open /ui URL. Stays in the foreground; ^C tears down and cleans up. Doesn't touch your existing brackish state.",
    )
    .option('--bind <addr>', 'TCP host:port (default 127.0.0.1:0 = ephemeral port)', '127.0.0.1:0')
    .option('--ttl <seconds>', 'lifetime of the issued browser token (default 3600)', '3600')
    .option('--keep', 'keep the sandbox dir after shutdown (default: removed)')
    .action(
      async (docArg: string | undefined, opts: { bind: string; ttl: string; keep?: boolean }) => {
        const docName = docArg ?? DEFAULT_DEMO_DOCUMENT;
        const ttl = Number.parseInt(opts.ttl, 10);
        if (!Number.isFinite(ttl) || ttl < 60)
          errExit(2, 'demo: --ttl must be at least 60 seconds');

        const sandbox = mkdtempSync(join(tmpdir(), 'brackish-demo-'));
        const socketPath = join(sandbox, 'brackish.sock');
        const dataPath = join(sandbox, 'brackish.db');

        process.stderr.write(`brackish demo: sandbox=${sandbox}\n`);
        process.stderr.write('               starting ephemeral daemon...\n');
        const server = await startServer({
          config: { socketPath, dataPath, bind: opts.bind },
        });
        if (!server.tcpAddress) {
          await server.close();
          errExit(2, `demo: failed to bind TCP at ${opts.bind}`);
        }

        let shuttingDown = false;
        const shutdown = (sig: string): void => {
          if (shuttingDown) return;
          shuttingDown = true;
          process.stderr.write(`\nbrackish demo: shutting down (${sig})\n`);
          void server.close().catch(() => {});
          if (!opts.keep) {
            try {
              rmSync(sandbox, { recursive: true, force: true });
            } catch {
              /* sandbox already gone */
            }
          }
          process.exit(0);
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));

        process.stderr.write('               seeding...\n');
        try {
          await seedDemo({
            socketPath,
            dataPath,
            documentName: docName,
            onStep: (m) => process.stderr.write(`                 ${m}\n`),
          });
        } catch (err) {
          await server.close();
          if (!opts.keep) rmSync(sandbox, { recursive: true, force: true });
          throw err;
        }

        // Browser URL is plain /ui/<doc>. The daemon bound 127.0.0.1, so the auth
        // middleware treats /ui/* as public on loopback — no token in URL, no cookie,
        // no OTT. Token-bearing endpoints (everything else) still require Authorization
        // for non-loopback callers, and the demo's `brackish visualize` examples below
        // use BRACKISH_HOME + the demo identity to reach the daemon over its socket.
        const tcpUrl = `http://127.0.0.1:${server.tcpAddress.port}`;
        const url = `${tcpUrl}/ui/${encodeURIComponent(docName)}`;
        // Mint a persistent token for the curl example so the user can poke at the
        // JSON/YAML render endpoints (those still require Bearer).
        const admin = new BrackishClient({ socketPath, identity: DEFAULT_DEMO_ADMIN });
        let bearer: string;
        try {
          const invite = await admin.createInvite('viewer', ttl, [docName]);
          const persistent = await redeemInvite(tcpUrl, invite.inviteToken);
          bearer = persistent.token;
        } finally {
          await admin.close();
        }

        process.stderr.write(
          [
            '',
            'Demo ready. Open in your browser:',
            '',
            `  ${url}`,
            '',
            'Other views (while this is running):',
            `  BRACKISH_HOME=${sandbox} BRACKISH_IDENTITY=${DEFAULT_DEMO_ADMIN} brackish visualize ${docName} --format markdown | less`,
            `  curl -s -H 'Authorization: Bearer ${bearer}' "${tcpUrl}/documents/${encodeURIComponent(docName)}/openapi.yaml"`,
            '',
            '(Ctrl-C to stop and clean up the sandbox.)',
            '',
          ].join('\n'),
        );

        // Block forever — the bound sockets keep the event loop alive until SIGINT.
      },
    );
}
