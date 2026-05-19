// `brackish demo` — one-shot ephemeral daemon + seeded negotiation + browser URL.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { BrackishClient, redeemInvite } from '../client.js';
import { seedChatterDemo } from '../demo.js';
import { IdentitySchema } from '../models.js';
import { startServer } from '../server.js';
import { errExit } from './common.js';

export function register(program: Command): void {
  program
    .command('demo [doc]')
    .description(
      "one-shot: starts an ephemeral brackish daemon in a tmp sandbox, seeds a sample chat-API negotiation (with rejections, multiple content types, a WS endpoint), and prints a ready-to-open /ui URL. Stays in the foreground; ^C tears down and cleans up. Doesn't touch your existing brackish state — no `init`/`serve` needed.",
    )
    .option('--bind <addr>', 'TCP host:port (default 127.0.0.1:0 = ephemeral port)', '127.0.0.1:0')
    .option('--alice <name>', 'identity for the proposing side', 'alice')
    .option('--bob <name>', 'identity for the accepting/rejecting side', 'bob')
    .option('--ttl <seconds>', 'lifetime of the issued browser token (default 3600)', '3600')
    .option('--keep', 'keep the sandbox dir after shutdown (default: removed)')
    .action(
      async (
        docArg: string | undefined,
        opts: { bind: string; alice: string; bob: string; ttl: string; keep?: boolean },
      ) => {
        const docName = docArg ?? 'chatter-api';
        IdentitySchema.parse(opts.alice);
        IdentitySchema.parse(opts.bob);
        const ttl = Number.parseInt(opts.ttl, 10);
        if (!Number.isFinite(ttl) || ttl < 60)
          errExit(2, 'demo: --ttl must be at least 60 seconds');

        const sandbox = mkdtempSync(join(tmpdir(), 'brackish-demo-'));
        const socketPath = join(sandbox, 'brackish.sock');
        const dataPath = join(sandbox, 'brackish.db');

        process.stderr.write(`brackish demo: sandbox=${sandbox}\n`);
        process.stderr.write(`               starting ephemeral daemon...\n`);
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
          await seedChatterDemo({
            socketPath,
            documentName: docName,
            alice: opts.alice,
            bob: opts.bob,
            onStep: (m) => process.stderr.write(`                 ${m}\n`),
          });
        } catch (err) {
          await server.close();
          if (!opts.keep) rmSync(sandbox, { recursive: true, force: true });
          throw err;
        }

        const admin = new BrackishClient({ socketPath, identity: opts.alice });
        let url: string;
        try {
          const invite = await admin.createInvite('viewer', ttl);
          const tcpUrl = `http://127.0.0.1:${server.tcpAddress.port}`;
          const persistent = await redeemInvite(tcpUrl, invite.inviteToken);
          url = `${tcpUrl}/ui/${encodeURIComponent(docName)}?token=${persistent.token}`;
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
            `Other views (while this is running):`,
            `  BRACKISH_HOME=${sandbox} BRACKISH_IDENTITY=${opts.alice} brackish visualize ${docName} --format markdown | less`,
            `  curl -s "${url.replace('/ui/', '/documents/').replace(`?token=`, `/openapi.yaml?token=`)}"`,
            '',
            '(Ctrl-C to stop and clean up the sandbox.)',
            '',
          ].join('\n'),
        );

        // Block forever — the bound sockets keep the event loop alive until SIGINT.
      },
    );
}
