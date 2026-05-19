// Commander wiring for the brackish CLI.
//
// Output convention:
//   - default = compact text to stdout, human-and-LLM friendly, dense
//   - --json   = a single JSON object/array to stdout, suitable for piping
//   - stderr is for metadata + diagnostics; stdout is for the "thing"
//   - exit 0 = success (including timed-out wait); 1 = operation error; 2 = usage/auth/connection

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { BrackishClient, ClientError, clientOptionsFromConfig, redeemInvite } from './client.js';
import {
  defaultClientConfigPath,
  defaultDataPath,
  defaultServerConfigPath,
  defaultSocketPath,
  ensureBrackishHome,
  loadClientConfig,
  loadServerConfig,
  saveClientConfig,
  saveServerConfig,
} from './config.js';
import { IdentitySchema, TokenSchema } from './models.js';
import {
  describeArtifactVersion,
  formatArtifactSummaries,
  formatEvents,
  formatEventsStream,
  formatInbox,
  formatParties,
  formatThreads,
} from './output.js';
import { startServer } from './server.js';

const CLI_VERSION = '0.1.0';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('brackish')
    .description(
      'Claude-to-Claude contract negotiation: thread-scoped messages + propose/accept artifacts',
    )
    .version(CLI_VERSION);

  // --- setup / identity ---

  program
    .command('init')
    .description(
      'write client config (same-machine: just --identity; cross-machine: --server + --token)',
    )
    .option('--identity <name>', 'self-declared label for this client')
    .option('--server <url>', 'cross-machine: brackish server URL')
    .option('--token <tok>', 'cross-machine: persistent token issued by `brackish connect`')
    .option('--socket-path <path>', 'override default socket path')
    .action(
      async (opts: { identity?: string; server?: string; token?: string; socketPath?: string }) => {
        const identity = opts.identity ?? process.env.BRACKISH_IDENTITY;
        if (!identity) errExit(2, 'init: --identity is required (or set BRACKISH_IDENTITY)');
        IdentitySchema.parse(identity);
        const cfg = opts.server
          ? {
              identity,
              server: opts.server,
              token: opts.token
                ? TokenSchema.parse(opts.token)
                : errExit(2, 'init --server requires --token (run `brackish connect` first)'),
            }
          : {
              identity,
              socketPath: opts.socketPath ?? defaultSocketPath(),
            };
        saveClientConfig(cfg);
        const path = defaultClientConfigPath();
        process.stderr.write(
          `wrote ${path}\n  identity=${identity}\n  transport=${opts.server ? 'tcp' : 'sock'}\n`,
        );
      },
    );

  program
    .command('whoami')
    .description("show this client's identity and the server it points at")
    .option('--json', 'output JSON')
    .action(async (opts: { json?: boolean }) =>
      withClient(async (client, cfg) => {
        const me = await client.whoami();
        const summary = {
          identity: me.identity,
          serverVersion: me.serverVersion,
          target: cfg.socketPath ?? cfg.server,
        };
        if (opts.json) emitJson(summary);
        else
          emit(
            `identity=${me.identity}\nserver=${cfg.server ?? cfg.socketPath}\nversion=${me.serverVersion}`,
          );
      }),
    );

  // --- server lifecycle ---

  program
    .command('serve')
    .description('start the brackish daemon (Unix socket always; --bind also opens TCP)')
    .option('--bind <addr>', 'host:port for TCP bind (e.g. 127.0.0.1:11442, 0.0.0.0:8080)')
    .option('--socket <path>', 'override socket path')
    .option('--data <path>', 'override sqlite db path')
    .option('--config <path>', 'load server config from FILE instead of default')
    .action(async (opts: { bind?: string; socket?: string; data?: string; config?: string }) => {
      ensureBrackishHome();
      const fileCfg = loadServerConfig({ explicitPath: opts.config });
      const cfg = {
        socketPath: opts.socket ?? fileCfg.socketPath ?? defaultSocketPath(),
        dataPath: opts.data ?? fileCfg.dataPath ?? defaultDataPath(),
        ...((opts.bind ?? fileCfg.bind) ? { bind: opts.bind ?? fileCfg.bind } : {}),
      };
      // Persist the server config so subsequent `brackish serve` calls remember the choice.
      saveServerConfig(cfg, defaultServerConfigPath());
      const server = await startServer({ config: cfg });
      process.stderr.write(`brackish serve: socket=${server.socketPath}\n`);
      if (server.tcpAddress) {
        process.stderr.write(
          `               tcp=http://${server.tcpAddress.host}:${server.tcpAddress.port}\n`,
        );
      }
      process.stderr.write('  (Ctrl-C to stop)\n');

      const shutdown = async (sig: string): Promise<void> => {
        process.stderr.write(`\nbrackish serve: shutting down (${sig})\n`);
        await server.close();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      // Hold the event loop open indefinitely; the server's listening sockets do that for us.
    });

  // --- connection bootstrap ---

  program
    .command('invite <identity>')
    .description('server-side: mint a one-time invite for <identity> (TCP transport only)')
    .option('--ttl <seconds>', 'invite lifetime in seconds (default 3600)', '3600')
    .option('--json', 'output JSON')
    .action(async (identity: string, opts: { ttl: string; json?: boolean }) =>
      withClient(async (client) => {
        const ttl = Number.parseInt(opts.ttl, 10);
        if (!Number.isFinite(ttl) || ttl < 1)
          errExit(2, 'invite: --ttl must be a positive integer');
        IdentitySchema.parse(identity);
        const inv = await client.createInvite(identity, ttl);
        const cfg = await loadClientConfigForServeAddr();
        const url = cfg.tcpUrl;
        if (opts.json) {
          emitJson({
            inviteToken: inv.inviteToken,
            identity: inv.identity,
            expiresAt: inv.expiresAt,
            connectCommand: `brackish connect ${url} --token ${inv.inviteToken} --identity ${identity}`,
          });
        } else {
          emit(
            `invite issued: identity=${identity}, expires=${inv.expiresAt}\n` +
              `share with peer:\n  brackish connect ${url} --token ${inv.inviteToken} --identity ${identity}`,
          );
        }
      }),
    );

  program
    .command('connect <url>')
    .description(
      'peer-side: redeem an invite, store the persistent token in ~/.brackish/config.toml',
    )
    .requiredOption('--token <tok>', 'invite token from `brackish invite`')
    .requiredOption('--identity <name>', 'self-declared label for this client (must match invite)')
    .action(async (url: string, opts: { token: string; identity: string }) => {
      IdentitySchema.parse(opts.identity);
      const persistent = await redeemInvite(url, opts.token);
      if (persistent.identity !== opts.identity) {
        errExit(
          1,
          `connect: server issued identity "${persistent.identity}" but you asked for "${opts.identity}"`,
        );
      }
      saveClientConfig({
        identity: persistent.identity,
        server: url,
        token: persistent.token,
      });
      emit(
        `connected as ${persistent.identity} → ${url}\nconfig written to ${defaultClientConfigPath()}`,
      );
    });

  program
    .command('parties')
    .description('list registered identities (TCP path only — socket clients are ephemeral)')
    .option('--json', 'output JSON')
    .action(async (opts: { json?: boolean }) =>
      withClient(async (client) => {
        const res = await client.listParties();
        if (opts.json) emitJson(res);
        else emit(formatParties(res.parties));
      }),
    );

  program
    .command('revoke <identity>')
    .description('invalidate a party identity and all its tokens')
    .action(async (identity: string) =>
      withClient(async (client) => {
        IdentitySchema.parse(identity);
        await client.revokeParty(identity);
        emit(`revoked ${identity}`);
      }),
    );

  // --- threads ---

  program
    .command('threads')
    .description('list threads')
    .option('--json', 'output JSON')
    .action(async (opts: { json?: boolean }) =>
      withClient(async (client) => {
        const threads = await client.listThreads();
        if (opts.json) emitJson({ threads });
        else emit(formatThreads(threads));
      }),
    );

  const thread = program.command('thread').description('thread management');
  thread
    .command('new <name>')
    .description('create a new thread')
    .option('--json', 'output JSON')
    .action(async (name: string, opts: { json?: boolean }) =>
      withClient(async (client) => {
        const t = await client.createThread(name);
        if (opts.json) emitJson(t);
        else emit(`created thread "${t.name}" by ${t.createdBy}`);
      }),
    );

  // --- messages, events, wait, inbox ---

  program
    .command('send <thread> [text]')
    .description('post a message to <thread>. Use "-" to read body from stdin.')
    .action(async (thread: string, text: string | undefined) =>
      withClient(async (client) => {
        const body = text === '-' ? await readStdin() : text;
        if (!body) errExit(2, 'send: provide message text or pass "-" to read stdin');
        const event = await client.sendMessage(thread, body);
        emit(`sent event #${event.id} to ${thread}`);
      }),
    );

  program
    .command('read <thread>')
    .description("list events in <thread> since the caller's cursor (advances the cursor)")
    .option('--since <n>', 'override cursor (exclusive lower bound)')
    .option('--limit <n>', 'max events to return', '200')
    .option('--json', 'output JSON')
    .action(async (thread: string, opts: { since?: string; limit: string; json?: boolean }) =>
      withClient(async (client) => {
        const sinceN = opts.since !== undefined ? Number.parseInt(opts.since, 10) : undefined;
        const limitN = Number.parseInt(opts.limit, 10);
        const res = await client.listEvents(thread, {
          ...(sinceN !== undefined ? { since: sinceN } : {}),
          limit: limitN,
        });
        if (opts.json) emitJson(res);
        else emit(formatEvents(res.events, res.cursor));
      }),
    );

  program
    .command('wait <thread>')
    .description('long-poll <thread>: block until new events arrive or --timeout elapses')
    .option('--timeout <seconds>', 'max seconds to block (1..300)', '30')
    .option('--since <n>', 'override cursor (exclusive lower bound)')
    .option('--json', 'output JSON')
    .action(async (thread: string, opts: { timeout: string; since?: string; json?: boolean }) =>
      withClient(async (client) => {
        const timeoutSeconds = Number.parseFloat(opts.timeout);
        const sinceN = opts.since !== undefined ? Number.parseInt(opts.since, 10) : undefined;
        const res = await client.wait(thread, {
          timeoutSeconds,
          ...(sinceN !== undefined ? { since: sinceN } : {}),
        });
        if (opts.json) emitJson(res);
        else emit(formatEvents(res.events, res.cursor));
      }),
    );

  program
    .command('inbox')
    .description('summary of all threads with new events for the current identity')
    .option('--json', 'output JSON')
    .option('--quiet-if-empty', 'print nothing (and exit 0) if there are no new events anywhere')
    .action(async (opts: { json?: boolean; quietIfEmpty?: boolean }) =>
      withClient(async (client) => {
        const res = await client.inbox();
        if (opts.quietIfEmpty && res.threads.length === 0) return;
        if (opts.json) emitJson(res);
        else emit(formatInbox(res.identity, res.threads));
      }),
    );

  program
    .command('watch [thread]')
    .description('foreground live tail of events; ^C to stop. Omit <thread> to use --all.')
    .option('--all', 'tail every thread (uses inbox + iterative wait)')
    .option('--timeout <seconds>', 'inner long-poll timeout per iteration', '60')
    .action(async (thread: string | undefined, opts: { all?: boolean; timeout: string }) =>
      withClient(async (client) => {
        const timeoutSeconds = Number.parseFloat(opts.timeout);
        if (thread && !opts.all) {
          // single-thread tail
          for (;;) {
            const res = await client.wait(thread, { timeoutSeconds });
            if (res.events.length > 0) process.stdout.write(`${formatEventsStream(res.events)}\n`);
          }
        } else if (opts.all) {
          // all-threads: poll inbox; for each thread with new events, drain via listEvents
          for (;;) {
            const ib = await client.inbox();
            for (const entry of ib.threads) {
              const ev = await client.listEvents(entry.threadName);
              if (ev.events.length > 0) {
                process.stdout.write(`[${entry.threadName}]\n${formatEventsStream(ev.events)}\n`);
              }
            }
            await sleep(timeoutSeconds * 1000);
          }
        } else {
          errExit(2, 'watch: pass a <thread> or --all');
        }
      }),
    );

  // --- artifacts ---

  const artifact = program
    .command('artifact')
    .description('contract artifact management (propose/accept/reject)');

  artifact
    .command('list <thread>')
    .description('list artifacts in <thread> with current + latest-proposed versions')
    .option('--json', 'output JSON')
    .action(async (thread: string, opts: { json?: boolean }) =>
      withClient(async (client) => {
        const artifacts = await client.listArtifacts(thread);
        if (opts.json) emitJson({ artifacts });
        else emit(formatArtifactSummaries(artifacts));
      }),
    );

  artifact
    .command('propose <thread> <name>')
    .description('propose a new version of <name>; --file or "-" supplies the content')
    .requiredOption('--kind <kind>', 'artifact kind (e.g. openapi, json-schema, ts-types, text)')
    .option('--file <path>', 'read content from file (use "-" for stdin)')
    .option('--json', 'output JSON')
    .action(
      async (thread: string, name: string, opts: { kind: string; file?: string; json?: boolean }) =>
        withClient(async (client) => {
          const content = await readContent(opts.file);
          const v = await client.proposeArtifact(thread, name, opts.kind, content);
          if (opts.json) emitJson(v);
          else emit(`proposed ${describeArtifactVersion(v)}`);
        }),
    );

  artifact
    .command('get <thread> <name>')
    .description('print the artifact content (stdout); metadata to stderr. --meta to skip content.')
    .option('--version <n>', 'fetch a specific version')
    .option('--proposed', 'fetch the latest proposed version instead of the current accepted one')
    .option('--meta', 'metadata only (no content body)')
    .option('--json', 'output JSON (content is included as a string field)')
    .action(
      async (
        thread: string,
        name: string,
        opts: { version?: string; proposed?: boolean; meta?: boolean; json?: boolean },
      ) =>
        withClient(async (client) => {
          const versionN =
            opts.version !== undefined ? Number.parseInt(opts.version, 10) : undefined;
          const v = await client.getArtifact(thread, name, {
            ...(versionN !== undefined ? { version: versionN } : {}),
            ...(opts.proposed ? { proposed: true } : {}),
          });
          if (opts.json) {
            emitJson(v);
            return;
          }
          if (!opts.meta) {
            process.stdout.write(v.content);
            if (!v.content.endsWith('\n')) process.stdout.write('\n');
          }
          process.stderr.write(`${describeArtifactVersion(v)}\n`);
        }),
    );

  artifact
    .command('accept <thread> <name>')
    .description('accept the latest proposed version (or --version N)')
    .option('--version <n>', 'accept a specific version')
    .option('--json', 'output JSON')
    .action(async (thread: string, name: string, opts: { version?: string; json?: boolean }) =>
      withClient(async (client) => {
        const versionN = opts.version !== undefined ? Number.parseInt(opts.version, 10) : undefined;
        const v = await client.acceptArtifact(thread, name, versionN);
        if (opts.json) emitJson(v);
        else emit(`accepted ${describeArtifactVersion(v)}`);
      }),
    );

  artifact
    .command('reject <thread> <name> <reason>')
    .description('reject the latest proposed version (or --version N) with a reason')
    .option('--version <n>', 'reject a specific version')
    .option('--json', 'output JSON')
    .action(
      async (
        thread: string,
        name: string,
        reason: string,
        opts: { version?: string; json?: boolean },
      ) =>
        withClient(async (client) => {
          const versionN =
            opts.version !== undefined ? Number.parseInt(opts.version, 10) : undefined;
          const v = await client.rejectArtifact(thread, name, reason, versionN);
          if (opts.json) emitJson(v);
          else emit(`rejected ${describeArtifactVersion(v)}`);
        }),
    );

  return program;
}

// --- helpers ---

type LoadedClientShape = {
  client: BrackishClient;
  cfg: { socketPath?: string; server?: string; identity: string };
};

async function withClient(
  fn: (client: BrackishClient, cfg: LoadedClientShape['cfg']) => Promise<void>,
): Promise<void> {
  let client: BrackishClient | null = null;
  try {
    const cfg = loadClientConfig();
    client = new BrackishClient(clientOptionsFromConfig(cfg));
    await fn(client, {
      identity: cfg.identity,
      ...(cfg.socketPath !== undefined ? { socketPath: cfg.socketPath } : {}),
      ...(cfg.server !== undefined ? { server: cfg.server } : {}),
    });
  } catch (err) {
    if (err instanceof ClientError) {
      // 4xx + 5xx from the server: op error (1) for 4xx, conn (2) for 5xx.
      const code = err.status >= 500 ? 2 : 1;
      errExit(code, `${err.code ?? `HTTP ${err.status}`}: ${err.message}`);
    }
    if (err instanceof Error) errExit(2, err.message);
    errExit(2, String(err));
  } finally {
    if (client) await client.close();
  }
}

/** Load just enough to know what URL to print in `brackish invite`. */
async function loadClientConfigForServeAddr(): Promise<{ tcpUrl: string }> {
  const fileCfg = loadServerConfig();
  if (fileCfg.bind === undefined) {
    errExit(
      2,
      'invite: this server has no TCP bind set; invites only make sense for cross-machine use.',
    );
  }
  return { tcpUrl: `http://${fileCfg.bind.replace(/^:/, '127.0.0.1:')}` };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function readContent(file: string | undefined): Promise<string> {
  if (file === '-' || file === undefined) {
    // Treat undefined like `-` if stdin is piped — saves typing.
    if (!process.stdin.isTTY || file === '-') return readStdin();
    errExit(2, 'propose: provide --file PATH or pipe content via stdin');
  }
  return readFileSync(file, 'utf8');
}

function emit(text: string): void {
  process.stdout.write(`${text}\n`);
}

function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function errExit(code: number, message: string): never {
  process.stderr.write(`brackish: ${message}\n`);
  process.exit(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- main ---

import { fileURLToPath } from 'node:url';

const entry = process.argv[1];
const thisFile = fileURLToPath(import.meta.url);
const isMain = entry !== undefined && (entry === thisFile || thisFile.startsWith(entry));

if (isMain) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err) => {
      errExit(2, err instanceof Error ? err.message : String(err));
    });
}
