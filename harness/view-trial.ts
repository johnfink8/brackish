// Spin up a brackish daemon against an existing trial's brackish-home, mint a viewer
// token, and print a /ui URL. Stays in the foreground; ^C tears down (the trial's
// sqlite data is untouched).
//
// Run: `npx tsx harness/view-trial.ts <trial-dir> [doc-name]`
//
// `trial-dir` is anything under `trials/`; `doc-name` defaults to the scenario's
// documentName from the trial config.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { z } from 'zod';
import { BrackishClient, redeemInvite } from '../src/client/client.js';
import { startServer } from '../src/daemon/server.js';

const TrialConfigSchema = z.object({
  documentName: z.string(),
});

async function main(): Promise<void> {
  const trialArg = process.argv[2];
  const docArg = process.argv[3];
  if (!trialArg) {
    console.error('usage: view-trial <trial-dir> [doc-name]');
    process.exit(2);
  }
  const trialDir = resolve(trialArg);
  const brackishHome = join(trialDir, 'brackish-home');
  const socketPath = join(brackishHome, 'brackish.sock');
  const dataPath = join(brackishHome, 'brackish.db');
  const configPath = join(trialDir, 'config.json');

  if (!existsSync(dataPath)) {
    console.error(`no brackish.db at ${dataPath} — wrong trial dir?`);
    process.exit(2);
  }
  if (existsSync(socketPath)) {
    console.error(
      `socket ${socketPath} already exists — another daemon is running for this trial, or stale; rm it if stale`,
    );
    process.exit(2);
  }

  let docName = docArg;
  if (!docName) {
    const parsed = TrialConfigSchema.safeParse(JSON.parse(readFileSync(configPath, 'utf8')));
    if (!parsed.success) {
      console.error(`couldn't read documentName from ${configPath}; pass [doc-name] as arg`);
      process.exit(2);
    }
    docName = parsed.data.documentName;
  }

  process.stderr.write(`view-trial: starting daemon for ${trialDir}\n`);
  const server = await startServer({
    config: { socketPath, dataPath, bind: '127.0.0.1:0' },
  });
  if (!server.tcpAddress) {
    await server.close();
    console.error('failed to bind TCP');
    process.exit(2);
  }

  // The trial wrote events under identities 'frontend' / 'backend' / 'observer'.
  // We can use the socket transport's peer-trust to self-declare any identity to
  // mint an invite — pick 'observer' so we don't perturb either side's cursor.
  const admin = new BrackishClient({ socketPath, identity: 'observer' });
  let url: string;
  try {
    const invite = await admin.createInvite('viewer', 3600);
    const tcpUrl = `http://127.0.0.1:${server.tcpAddress.port}`;
    const persistent = await redeemInvite(tcpUrl, invite.inviteToken);
    url = `${tcpUrl}/ui/${encodeURIComponent(docName)}?token=${persistent.token}`;
  } finally {
    await admin.close();
  }

  process.stderr.write(
    [
      '',
      `Trial: ${trialDir}`,
      `Doc:   ${docName}`,
      '',
      'Open in your browser:',
      '',
      `  ${url}`,
      '',
      '(Ctrl-C to stop. The trial sqlite data is read-only from here on; nothing is mutated.)',
      '',
    ].join('\n'),
  );

  const shutdown = (sig: string): void => {
    process.stderr.write(`\nview-trial: shutting down (${sig})\n`);
    void server.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Bound sockets keep the loop alive until SIGINT.
}

main().catch((e) => {
  console.error('view-trial: fatal', e);
  process.exit(1);
});
