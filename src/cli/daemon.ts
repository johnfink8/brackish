// Daemon + identity lifecycle: init, whoami, serve, up, down.

import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { BrackishClient } from '../client/client.js';
import { startServer } from '../daemon/server.js';
import {
  brackishHome,
  defaultClientConfigPath,
  defaultDataPath,
  defaultServerConfigPath,
  defaultSocketPath,
  ensureBrackishHome,
  loadClientConfig,
  loadServerConfig,
  parseBindAddress,
  saveClientConfig,
  saveServerConfig,
} from '../io/config.js';
import { IdentitySchema, TokenSchema } from '../lib/models.js';
import { normalizePin } from '../lib/tls.js';
import {
  emit,
  emitJson,
  errExit,
  inferReachableHost,
  sanitizeIdentity,
  sleep,
  withClient,
} from './common.js';

export function register(program: Command): void {
  // --- setup / identity ---

  program
    .command('init')
    .description(
      'write client config (same-machine: just --identity; cross-machine: --server + --token)',
    )
    .option('--identity <name>', 'self-declared label for this client')
    .option('--server <url>', 'cross-machine: brackish server URL')
    .option('--token <tok>', 'cross-machine: persistent token issued by `brackish connect`')
    .option('--tls-pin <pin>', 'cross-machine over https://: pin the server cert by fingerprint')
    .option('--socket-path <path>', 'override default socket path')
    .action(
      async (opts: {
        identity?: string;
        server?: string;
        token?: string;
        tlsPin?: string;
        socketPath?: string;
      }) => {
        const identity = opts.identity ?? process.env.BRACKISH_IDENTITY;
        if (!identity) errExit(2, 'init: --identity is required (or set BRACKISH_IDENTITY)');
        IdentitySchema.parse(identity);
        const tlsPin = opts.tlsPin !== undefined ? normalizePin(opts.tlsPin) : undefined;
        if (opts.server?.startsWith('https://') && tlsPin === undefined) {
          errExit(
            2,
            'init --server https:// requires --tls-pin (the fingerprint from the invite line)',
          );
        }
        const cfg = opts.server
          ? {
              identity,
              server: opts.server,
              token: opts.token
                ? TokenSchema.parse(opts.token)
                : errExit(2, 'init --server requires --token (run `brackish connect` first)'),
              ...(tlsPin !== undefined ? { tlsPin } : {}),
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
    .option(
      '--bind [addr]',
      'enable TCP. Bare `--bind` → 127.0.0.1:11442 (loopback); pass `--bind 0.0.0.0` to expose on the LAN; `--bind 0.0.0.0:8080` → exact host+port',
    )
    .option('--socket <path>', 'override socket path')
    .option('--data <path>', 'override sqlite db path')
    .option('--config <path>', 'load server config from FILE instead of default')
    .option(
      '--tls-cert <path>',
      'serve TLS on the TCP bind with this PEM cert (requires --bind; pairs with --tls-key). Generate one with `brackish tls gen`.',
    )
    .option('--tls-key <path>', 'PEM private key for --tls-cert')
    .option(
      '--invite <identity>',
      'after starting, mint a one-time connect token for <identity> and print the connect command (requires --bind)',
    )
    .option(
      '--invite-ttl <seconds>',
      'lifetime of the --invite token in seconds (default 3600)',
      '3600',
    )
    .action(
      async (opts: {
        bind?: string | boolean;
        socket?: string;
        data?: string;
        config?: string;
        tlsCert?: string;
        tlsKey?: string;
        invite?: string;
        inviteTtl: string;
      }) => {
        ensureBrackishHome();
        const fileCfg = loadServerConfig({ explicitPath: opts.config });

        const tlsCert = opts.tlsCert ?? fileCfg.tlsCert;
        const tlsKey = opts.tlsKey ?? fileCfg.tlsKey;
        if ((tlsCert === undefined) !== (tlsKey === undefined)) {
          errExit(2, 'serve: --tls-cert and --tls-key must be given together');
        }
        if (tlsCert !== undefined && tlsKey !== undefined) {
          if (!existsSync(tlsCert)) errExit(2, `serve: --tls-cert file not found: ${tlsCert}`);
          if (!existsSync(tlsKey)) errExit(2, `serve: --tls-key file not found: ${tlsKey}`);
        }

        let inviteTtl: number | null = null;
        if (opts.invite !== undefined) {
          IdentitySchema.parse(opts.invite);
          inviteTtl = Number.parseInt(opts.inviteTtl, 10);
          if (!Number.isFinite(inviteTtl) || inviteTtl < 1) {
            errExit(2, 'serve --invite-ttl must be a positive integer (seconds)');
          }
        }

        // --invite is meaningless without TCP, so it implies --bind with defaults.
        const rawBind: string | undefined =
          opts.bind === true
            ? ''
            : typeof opts.bind === 'string'
              ? opts.bind
              : opts.invite !== undefined
                ? ''
                : fileCfg.bind;
        const bind =
          rawBind === undefined
            ? undefined
            : (() => {
                const { host, port } = parseBindAddress(rawBind);
                return `${host}:${port}`;
              })();
        if (tlsCert !== undefined && bind === undefined) {
          errExit(2, 'serve: --tls-cert/--tls-key require TCP — pass --bind (e.g. --bind 0.0.0.0)');
        }
        const cfg = {
          socketPath: opts.socket ?? fileCfg.socketPath ?? defaultSocketPath(),
          dataPath: opts.data ?? fileCfg.dataPath ?? defaultDataPath(),
          ...(bind !== undefined ? { bind } : {}),
          ...(tlsCert !== undefined && tlsKey !== undefined ? { tlsCert, tlsKey } : {}),
        };
        saveServerConfig(cfg, defaultServerConfigPath());
        const server = await startServer({ config: cfg });
        process.stderr.write(`brackish serve: socket=${server.socketPath}\n`);
        if (server.tcpAddress) {
          process.stderr.write(
            `               tcp=${server.tcpScheme}://${server.tcpAddress.host}:${server.tcpAddress.port}\n`,
          );
          if (server.tlsFingerprint) {
            process.stderr.write(`               tls pin=${server.tlsFingerprint}\n`);
          }
          // Bind-context banner. Suppressible via BRACKISH_QUIET_BIND_WARNING=1 for CI/demos.
          // Loopback gets a positive "not externally reachable" line so the user/agent sees
          // the security posture confirmed; non-loopback gets a louder warning naming the
          // exposure. Brackish is local-coordination tooling, NOT production-hardened. TLS, when
          // on, encrypts + pins the channel — note that so a non-loopback bind reads as deliberate.
          if (!process.env.BRACKISH_QUIET_BIND_WARNING) {
            const isLoopback = isLoopbackHost(server.tcpAddress.host);
            if (isLoopback) {
              process.stderr.write(
                `               (loopback only — NOT externally reachable; remote peers won't see this server)\n`,
              );
            } else if (server.tlsFingerprint) {
              process.stderr.write(
                `\nbrackish is binding TLS on ${server.tcpAddress.host}:${server.tcpAddress.port} —\n` +
                  `reachable from any host that can route here, but the channel is encrypted and the\n` +
                  `peer pins the cert above. Peers still need a valid token. Use for cross-machine work.\n\n`,
              );
            } else {
              process.stderr.write(
                `\nWARNING: brackish is binding TCP (no TLS) on ${server.tcpAddress.host}:${server.tcpAddress.port} —\n` +
                  `reachable from any host that can route to this address, and traffic is in the clear.\n` +
                  `Use ONLY if the user indicated your peer is on another machine; prefer --tls-cert/--tls-key.\n` +
                  `Set BRACKISH_QUIET_BIND_WARNING=1 to silence.\n\n`,
              );
            }
          }
        }

        if (opts.invite !== undefined && inviteTtl !== null && server.tcpAddress) {
          let issuerIdentity = 'host';
          try {
            issuerIdentity = loadClientConfig().identity;
          } catch {
            /* no config yet */
          }
          const admin = new BrackishClient({
            socketPath: server.socketPath,
            identity: issuerIdentity,
          });
          try {
            const inv = await admin.createInvite(opts.invite, inviteTtl);
            const inferred = await inferReachableHost(server.tcpAddress.host);
            const url = `${server.tcpScheme}://${inferred.host}:${server.tcpAddress.port}`;
            const pinFlag = server.tlsFingerprint ? ` --tls-pin ${server.tlsFingerprint}` : '';
            const lines = [
              '',
              `invite minted for "${opts.invite}", expires ${inv.expiresAt}`,
              'share with peer:',
              `  brackish connect ${url} --token ${inv.inviteToken} --identity ${opts.invite}${pinFlag}`,
            ];
            if (inferred.hint) lines.push(`   ${inferred.hint}`);
            lines.push('');
            process.stderr.write(`${lines.join('\n')}\n`);
          } finally {
            await admin.close();
          }
        }

        const pidPath = servePidPath();
        writeFileSync(pidPath, String(process.pid));
        const removePid = (): void => {
          try {
            unlinkSync(pidPath);
          } catch {
            /* already gone */
          }
        };
        process.on('exit', removePid);

        process.stderr.write('  (Ctrl-C to stop)\n');

        const shutdown = async (sig: string): Promise<void> => {
          process.stderr.write(`\nbrackish serve: shutting down (${sig})\n`);
          await server.close();
          removePid();
          process.exit(0);
        };
        process.on('SIGINT', () => void shutdown('SIGINT'));
        process.on('SIGTERM', () => void shutdown('SIGTERM'));
      },
    );

  program
    .command('up')
    .description(
      'start the brackish daemon in the background if not already running (idempotent); auto-writes a client config on first run',
    )
    .option(
      '--bind [addr]',
      'enable TCP on the spawned daemon; bare `--bind` defaults to 127.0.0.1:11442 (loopback)',
    )
    .option(
      '--identity <name>',
      'client identity to write into config.toml if no client config exists (default: hostname)',
    )
    .option(
      '--tls-cert <path>',
      'serve TLS on the spawned daemon (requires --bind; pairs with --tls-key)',
    )
    .option('--tls-key <path>', 'PEM private key for --tls-cert')
    .action(
      async (opts: {
        bind?: string | boolean;
        identity?: string;
        tlsCert?: string;
        tlsKey?: string;
      }) => {
        ensureBrackishHome();
        await ensureClientConfig(opts.identity);

        const cfg = loadClientConfig();
        if (cfg.server !== undefined && cfg.token !== undefined) {
          process.stderr.write(
            `brackish: client is configured for remote daemon at ${cfg.server} (no local daemon needed)\n`,
          );
          return;
        }

        if (await isDaemonRunning(defaultSocketPath())) {
          process.stderr.write(
            `brackish: daemon already running (socket=${defaultSocketPath()})\n`,
          );
          return;
        }

        const serveArgs = ['serve'];
        if (opts.bind === true) serveArgs.push('--bind');
        else if (typeof opts.bind === 'string') serveArgs.push('--bind', opts.bind);
        if ((opts.tlsCert === undefined) !== (opts.tlsKey === undefined)) {
          errExit(2, 'up: --tls-cert and --tls-key must be given together');
        }
        if (opts.tlsCert !== undefined && opts.tlsKey !== undefined) {
          serveArgs.push('--tls-cert', opts.tlsCert, '--tls-key', opts.tlsKey);
        }

        const logPath = join(brackishHome(), 'serve.log');
        const logFd = openSync(logPath, 'a');
        const selfBin = fileURLToPath(import.meta.url);
        const child = spawn(process.execPath, [selfBin, ...serveArgs], {
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: process.env,
        });
        child.unref();

        const ready = await waitForDaemon(defaultSocketPath(), 5000);
        if (!ready) {
          errExit(
            2,
            `daemon spawned (pid ${child.pid}) but socket didn't come up within 5s — check ${logPath}`,
          );
        }
        process.stderr.write(
          `brackish: daemon started (pid ${child.pid}); socket=${defaultSocketPath()}; log=${logPath}\n`,
        );
      },
    );

  program
    .command('down')
    .description('stop the running brackish daemon (SIGTERM via PID file)')
    .action(async () => {
      const pidPath = servePidPath();
      if (!existsSync(pidPath)) {
        if (!existsSync(defaultSocketPath())) {
          process.stderr.write('brackish: no daemon running\n');
          return;
        }
        errExit(
          2,
          `socket ${defaultSocketPath()} exists but no PID file at ${pidPath}; kill the daemon manually`,
        );
      }
      const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
      if (!Number.isFinite(pid)) errExit(2, `corrupt PID file at ${pidPath}`);
      try {
        process.kill(pid, 'SIGTERM');
      } catch (e) {
        const code = e instanceof Error && 'code' in e ? e.code : undefined;
        if (code === 'ESRCH') {
          try {
            unlinkSync(pidPath);
          } catch {
            /* */
          }
          try {
            unlinkSync(defaultSocketPath());
          } catch {
            /* */
          }
          process.stderr.write(`brackish: stale PID ${pid} cleaned up\n`);
          return;
        }
        throw e;
      }
      const stopped = await waitForSocketGone(defaultSocketPath(), 3000);
      if (!stopped) {
        process.stderr.write(
          `brackish: SIGTERM sent to pid ${pid} but socket persists; check ${join(brackishHome(), 'serve.log')}\n`,
        );
        process.exit(1);
      }
      process.stderr.write(`brackish: stopped (pid ${pid})\n`);
    });
}

// --- helpers ---

function servePidPath(): string {
  return join(brackishHome(), 'serve.pid');
}

/** Is the host a loopback / link-local-only address? Used to gate the bind-warning banner. */
function isLoopbackHost(host: string): boolean {
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true;
  // Whole 127/8 loopback range counts.
  if (host.startsWith('127.')) return true;
  return false;
}

async function isDaemonRunning(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  return new Promise((resolve) => {
    const sock = createConnection(socketPath);
    const done = (val: boolean): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(val);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 1000).unref();
  });
}

async function waitForDaemon(socketPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDaemonRunning(socketPath)) return true;
    await sleep(100);
  }
  return false;
}

async function waitForSocketGone(socketPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(socketPath)) return true;
    await sleep(100);
  }
  return false;
}

async function ensureClientConfig(explicitIdentity?: string): Promise<void> {
  const path = defaultClientConfigPath();
  if (existsSync(path)) return;
  const raw = explicitIdentity ?? process.env.BRACKISH_IDENTITY ?? sanitizeIdentity(hostname());
  const identity = IdentitySchema.parse(sanitizeIdentity(raw));
  saveClientConfig({ identity, socketPath: defaultSocketPath() });
  process.stderr.write(`brackish: wrote ${path}, identity=${identity}\n`);
}
