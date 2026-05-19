// Commander wiring for the brackish CLI.
//
// Output convention:
//   - default = compact text to stdout, human-and-LLM friendly, dense
//   - --json   = a single JSON object/array to stdout, suitable for piping
//   - stderr is for metadata + diagnostics; stdout is for the "thing"
//   - exit 0 = success (including timed-out wait); 1 = operation error; 2 = usage/auth/connection

import { spawn } from 'node:child_process';
import { createSocket as createDgramSocket } from 'node:dgram';
import {
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import {
  BrackishClient,
  ClientError,
  clientOptionsFromConfig,
  type ProposeOptionsWire,
  redeemInvite,
} from './client.js';
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
} from './config.js';
import { seedChatterDemo } from './demo.js';
import {
  BRACKISH_PERMISSION_PATTERN,
  claudeHome,
  defaultSkillDest,
  hookSnippet,
  inspectInstall,
  installHook,
  installPermission,
  installSkill,
  projectClaudeHome,
  type Scope,
  uninstallHook,
  uninstallPermission,
  uninstallSkill,
  userClaudeHome,
} from './install.js';
import {
  type ConventionArtifact,
  type ConventionSpec,
  HttpMethodSchema,
  IdentitySchema,
  type JSONSchema,
  type OperationSpec,
  TokenSchema,
} from './models.js';
import { assembleDocument, type OpenAPIDocument } from './openapi.js';
import {
  describeConvention,
  describeOperation,
  describeSchema,
  formatDocuments,
  formatEndpointSummaries,
  formatEvents,
  formatEventsStream,
  formatInbox,
  formatParties,
  formatSchemaSummaries,
} from './output.js';
import { renderHtml, renderJson, renderMarkdown, renderOpenAPIYaml, renderText } from './render.js';
import { startServer } from './server.js';
import type { RationaleEntry } from './store/index.js';

const CLI_VERSION = '0.3.0';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('brackish')
    .description(
      'Claude-to-Claude contract negotiation: document-scoped messages + propose/accept artifacts',
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
    .option(
      '--bind [addr]',
      'enable TCP. Bare `--bind` → 0.0.0.0:11442; `--bind 0.0.0.0` → default port; `--bind 0.0.0.0:8080` → exact',
    )
    .option('--socket <path>', 'override socket path')
    .option('--data <path>', 'override sqlite db path')
    .option('--config <path>', 'load server config from FILE instead of default')
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
        invite?: string;
        inviteTtl: string;
      }) => {
        ensureBrackishHome();
        const fileCfg = loadServerConfig({ explicitPath: opts.config });

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
        const cfg = {
          socketPath: opts.socket ?? fileCfg.socketPath ?? defaultSocketPath(),
          dataPath: opts.data ?? fileCfg.dataPath ?? defaultDataPath(),
          ...(bind !== undefined ? { bind } : {}),
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

        // Self-mint via the socket. Peer-trust accepts any issuer identity; use the
        // configured one if there is one.
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
            const url = `http://${inferred.host}:${server.tcpAddress.port}`;
            const lines = [
              '',
              `invite minted for "${opts.invite}", expires ${inv.expiresAt}`,
              'share with peer:',
              `  brackish connect ${url} --token ${inv.inviteToken} --identity ${opts.invite}`,
            ];
            if (inferred.hint) lines.push(`   ${inferred.hint}`);
            lines.push('');
            process.stderr.write(`${lines.join('\n')}\n`);
          } finally {
            await admin.close();
          }
        }

        // PID file lets `brackish down` find this daemon. Cleaned up on graceful shutdown.
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
      'enable TCP on the spawned daemon; bare `--bind` defaults to 0.0.0.0:11442',
    )
    .option(
      '--identity <name>',
      'client identity to write into config.toml if no client config exists (default: hostname)',
    )
    .action(async (opts: { bind?: string | boolean; identity?: string }) => {
      ensureBrackishHome();
      await ensureClientConfig(opts.identity);

      // TCP-mode client: there's a remote daemon; spawning a local one would just sit idle.
      const cfg = loadClientConfig();
      if (cfg.server !== undefined && cfg.token !== undefined) {
        process.stderr.write(
          `brackish: client is configured for remote daemon at ${cfg.server} (no local daemon needed)\n`,
        );
        return;
      }

      if (await isDaemonRunning(defaultSocketPath())) {
        process.stderr.write(`brackish: daemon already running (socket=${defaultSocketPath()})\n`);
        return;
      }

      const serveArgs = ['serve'];
      if (opts.bind === true) serveArgs.push('--bind');
      else if (typeof opts.bind === 'string') serveArgs.push('--bind', opts.bind);

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
    });

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
        const code = (e as NodeJS.ErrnoException).code;
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
            ...(cfg.hint ? { hint: cfg.hint } : {}),
          });
        } else {
          const hintLine = cfg.hint ? `\n  ${cfg.hint}` : '';
          emit(
            `invite issued: identity=${identity}, expires=${inv.expiresAt}\n` +
              `share with peer:\n  brackish connect ${url} --token ${inv.inviteToken} --identity ${identity}${hintLine}`,
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

  // --- documents ---

  program
    .command('documents')
    .aliases(['docs'])
    .description('list documents')
    .option('--json', 'output JSON')
    .action(async (opts: { json?: boolean }) =>
      withClient(async (client) => {
        const documents = await client.listDocuments();
        if (opts.json) emitJson({ documents });
        else emit(formatDocuments(documents));
      }),
    );

  const document = program.command('doc').description('document management');
  document
    .command('new <name>')
    .description('create a new document')
    .option('--json', 'output JSON')
    .action(async (name: string, opts: { json?: boolean }) =>
      withClient(async (client) => {
        const t = await client.createDocument(name);
        if (opts.json) emitJson(t);
        else emit(`created document "${t.name}" by ${t.createdBy}`);
      }),
    );

  // --- messages, events, wait, inbox ---

  program
    .command('send <doc> [text]')
    .description('post a message to <doc>. Use "-" to read body from stdin.')
    .action(async (document: string, text: string | undefined) =>
      withClient(async (client) => {
        const body = text === '-' ? await readStdin() : text;
        if (!body) errExit(2, 'send: provide message text or pass "-" to read stdin');
        const event = await client.sendMessage(document, body);
        emit(`sent event #${event.id} to ${document}`);
      }),
    );

  program
    .command('read <doc>')
    .description("list events in <doc> since the caller's cursor (advances the cursor)")
    .option('--since <n>', 'override cursor (exclusive lower bound)')
    .option('--limit <n>', 'max events to return', '200')
    .option('--json', 'output JSON')
    .action(async (document: string, opts: { since?: string; limit: string; json?: boolean }) =>
      withClient(async (client) => {
        const sinceN = opts.since !== undefined ? Number.parseInt(opts.since, 10) : undefined;
        const limitN = Number.parseInt(opts.limit, 10);
        const res = await client.listEvents(document, {
          ...(sinceN !== undefined ? { since: sinceN } : {}),
          limit: limitN,
        });
        if (opts.json) emitJson(res);
        else emit(formatEvents(res.events, res.cursor));
      }),
    );

  program
    .command('wait <doc>')
    .description('long-poll <doc>: block until new events arrive or --timeout elapses')
    .option('--timeout <seconds>', 'max seconds to block (1..300)', '30')
    .option('--since <n>', 'override cursor (exclusive lower bound)')
    .option('--json', 'output JSON')
    .action(async (document: string, opts: { timeout: string; since?: string; json?: boolean }) =>
      withClient(async (client) => {
        const timeoutSeconds = Number.parseFloat(opts.timeout);
        const sinceN = opts.since !== undefined ? Number.parseInt(opts.since, 10) : undefined;
        const res = await client.wait(document, {
          timeoutSeconds,
          ...(sinceN !== undefined ? { since: sinceN } : {}),
        });
        if (opts.json) emitJson(res);
        else emit(formatEvents(res.events, res.cursor));
      }),
    );

  program
    .command('inbox')
    .description('summary of all documents with new events for the current identity')
    .option('--json', 'output JSON')
    .option('--quiet-if-empty', 'print nothing (and exit 0) if there are no new events anywhere')
    .action(async (opts: { json?: boolean; quietIfEmpty?: boolean }) =>
      withClient(async (client) => {
        const res = await client.inbox();
        if (opts.quietIfEmpty && res.documents.length === 0) return;
        if (opts.json) emitJson(res);
        else emit(formatInbox(res.identity, res.documents));
      }),
    );

  program
    .command('watch [document]')
    .description('foreground live tail of events; ^C to stop. Omit <doc> to use --all.')
    .option('--all', 'tail every document (uses inbox + iterative wait)')
    .option('--timeout <seconds>', 'inner long-poll timeout per iteration', '60')
    .action(async (document: string | undefined, opts: { all?: boolean; timeout: string }) =>
      withClient(async (client) => {
        const timeoutSeconds = Number.parseFloat(opts.timeout);
        if (document && !opts.all) {
          // single-document tail
          for (;;) {
            const res = await client.wait(document, { timeoutSeconds });
            if (res.events.length > 0) process.stdout.write(`${formatEventsStream(res.events)}\n`);
          }
        } else if (opts.all) {
          // all-documents: poll inbox; for each document with new events, drain via listEvents
          for (;;) {
            const ib = await client.inbox();
            for (const entry of ib.documents) {
              const ev = await client.listEvents(entry.documentName);
              if (ev.events.length > 0) {
                process.stdout.write(`[${entry.documentName}]\n${formatEventsStream(ev.events)}\n`);
              }
            }
            await sleep(timeoutSeconds * 1000);
          }
        } else {
          errExit(2, 'watch: pass a <doc> or --all');
        }
      }),
    );

  // --- endpoints ---

  const endpoint = program.command('endpoint').description('OpenAPI Operation lifecycle');

  endpoint
    .command('propose <doc> <method> <path>')
    .description('propose an OpenAPI Operation (request/responses/security/x-brackish)')
    .option('--summary <text>')
    .option('--description <text>')
    .option('--request-content <ct=schema>', 'media type=schemaName (repeatable)', collect, [])
    .option(
      '--response <status:ct:schema:desc>',
      'status:contentType:schema:description (repeatable)',
      collect,
      [],
    )
    .option('--security <scheme>', 'security scheme name (repeatable)', collect, [])
    .option(
      '--no-inherit-security',
      "don't inherit doc-level `security` from the accepted convention (use for explicitly public endpoints)",
    )
    .option('--idempotent', 'x-brackish.idempotent: true')
    .option('--side-effect <text>', 'x-brackish.sideEffects entry (repeatable)', collect, [])
    .option('--timing-p50 <duration>', 'x-brackish.timing.p50')
    .option('--timing-p99 <duration>', 'x-brackish.timing.p99')
    .option('--timeout <duration>', 'x-brackish.timing.timeout')
    .option(
      '--file <path>',
      'load full Operation Object from YAML/JSON file (replaces other flags)',
    )
    .option('--expected-new', 'require no prior version (refuse if anything exists)')
    .option('--expected-version <n>', 'require latest version to be exactly N (any status)')
    .option('--force', 'allow proposing on top of an unresolved (proposed) version')
    .option('--json', 'output JSON')
    .action(async (doc: string, methodRaw: string, path: string, opts: EndpointProposeOpts) =>
      withClient(async (client) => {
        const method = HttpMethodSchema.parse(methodRaw.toLowerCase());
        // Fetch the accepted convention so we can inherit doc-level security as a default.
        // Best-effort: a missing convention is fine (no inheritance, no error).
        const convention =
          opts.inheritSecurity === false
            ? null
            : await client.getConventionCurrent(doc).catch(() => null);
        const spec = opts.file
          ? (loadSpecFile(opts.file) as OperationSpec)
          : buildOperationSpec(opts, { path, convention });
        const v = await client.proposeEndpoint(doc, method, path, spec, parseConcurrencyOpts(opts));
        if (opts.json) emitJson(v);
        else emit(`proposed ${describeOperation(v)}`);
      }),
    );

  endpoint
    .command('list <doc>')
    .description('list endpoints with current + latest-proposed versions')
    .option('--json', 'output JSON')
    .action(async (doc: string, opts: { json?: boolean }) =>
      withClient(async (client) => {
        const endpoints = await client.listEndpoints(doc);
        if (opts.json) emitJson({ endpoints });
        else emit(formatEndpointSummaries(endpoints));
      }),
    );

  endpoint
    .command('show <doc> <method> <path>')
    .description('show an endpoint (compact by default; --full for the Operation body)')
    .option('--version <n>')
    .option('--proposed')
    .option('--full', 'include the Operation body')
    .option('--json')
    .action(
      async (
        doc: string,
        methodRaw: string,
        path: string,
        opts: { version?: string; proposed?: boolean; full?: boolean; json?: boolean },
      ) =>
        withClient(async (client) => {
          const method = HttpMethodSchema.parse(methodRaw.toLowerCase());
          const v = await fetchOrFallback(
            () =>
              client.getEndpoint(doc, method, path, {
                ...(opts.version !== undefined
                  ? { version: Number.parseInt(opts.version, 10) }
                  : {}),
                ...(opts.proposed ? { proposed: true } : {}),
              }),
            opts.proposed ? () => client.getEndpoint(doc, method, path) : null,
          );
          if (opts.json) emitJson(v);
          else if (opts.full) emit(`${describeOperation(v)}\n${yamlStringify(v.spec).trimEnd()}`);
          else emit(describeOperation(v));
        }),
    );

  endpoint
    .command('accept <doc> <method> <path>')
    .description('accept the latest proposed version (or --version N)')
    .option('--version <n>')
    .option('--json')
    .action(
      async (
        doc: string,
        methodRaw: string,
        path: string,
        opts: { version?: string; json?: boolean },
      ) =>
        withClient(async (client) => {
          const method = HttpMethodSchema.parse(methodRaw.toLowerCase());
          const versionN =
            opts.version !== undefined ? Number.parseInt(opts.version, 10) : undefined;
          const v = await client.acceptEndpoint(doc, method, path, versionN);
          if (opts.json) emitJson(v);
          else emit(`accepted ${describeOperation(v)}`);
        }),
    );

  endpoint
    .command('reject <doc> <method> <path> <reason>')
    .description('reject the latest proposed version with a reason')
    .option('--version <n>')
    .option('--json')
    .action(
      async (
        doc: string,
        methodRaw: string,
        path: string,
        reason: string,
        opts: { version?: string; json?: boolean },
      ) =>
        withClient(async (client) => {
          const method = HttpMethodSchema.parse(methodRaw.toLowerCase());
          const versionN =
            opts.version !== undefined ? Number.parseInt(opts.version, 10) : undefined;
          const v = await client.rejectEndpoint(doc, method, path, reason, versionN);
          if (opts.json) emitJson(v);
          else emit(`rejected ${describeOperation(v)}`);
        }),
    );

  endpoint
    .command('withdraw <doc> <method> <path>')
    .description('take back your own still-proposed version (only the proposer can withdraw)')
    .option('--version <n>')
    .option('--json')
    .action(
      async (
        doc: string,
        methodRaw: string,
        path: string,
        opts: { version?: string; json?: boolean },
      ) =>
        withClient(async (client) => {
          const method = HttpMethodSchema.parse(methodRaw.toLowerCase());
          const versionN =
            opts.version !== undefined ? Number.parseInt(opts.version, 10) : undefined;
          const v = await client.withdrawEndpoint(doc, method, path, versionN);
          if (opts.json) emitJson(v);
          else emit(`withdrew ${describeOperation(v)}`);
        }),
    );

  endpoint
    .command('diff <doc> <method> <path>')
    .description('JSON Patch between two versions (defaults: prev → latest); see --format')
    .option('--from <n>')
    .option('--to <n>')
    .option(
      '--format <patch|yaml|json|rendered>',
      'patch=RFC 6902 array; yaml/json=wrapped envelope; rendered=side-by-side YAML',
      'patch',
    )
    .action(
      async (
        doc: string,
        methodRaw: string,
        path: string,
        opts: { from?: string; to?: string; format: string },
      ) =>
        withClient(async (client) => {
          const method = HttpMethodSchema.parse(methodRaw.toLowerCase());
          const diff = await client.diffEndpoint(doc, method, path, {
            ...(opts.from !== undefined ? { from: Number.parseInt(opts.from, 10) } : {}),
            ...(opts.to !== undefined ? { to: Number.parseInt(opts.to, 10) } : {}),
          });
          if (opts.format === 'rendered') {
            const [from, to] = await Promise.all([
              client.getEndpoint(doc, method, path, { version: diff.fromVersion }),
              client.getEndpoint(doc, method, path, { version: diff.toVersion }),
            ]);
            emitRenderedDiff(from.spec, to.spec, diff.fromVersion, diff.toVersion);
            return;
          }
          emitDiff(diff, opts.format);
        }),
    );

  // --- schemas ---

  const schema = program.command('schema').description('JSON Schema component lifecycle');

  schema
    .command('propose <doc> <name>')
    .description('propose a JSON Schema for components.schemas[name]')
    .option('--field <spec>', "field: 'name:type[?][:description]' (repeatable)", collect, [])
    .option('--description <text>')
    .option('--file <path>', 'load full JSON Schema from YAML/JSON file (replaces --field)')
    .option('--expected-new', 'require no prior version (refuse if anything exists)')
    .option('--expected-version <n>', 'require latest version to be exactly N (any status)')
    .option('--force', 'allow proposing on top of an unresolved (proposed) version')
    .option('--json')
    .action(
      async (
        doc: string,
        name: string,
        opts: ConcurrencyOpts & {
          field: string[];
          description?: string;
          file?: string;
          json?: boolean;
        },
      ) =>
        withClient(async (client) => {
          const spec = opts.file ? (loadSpecFile(opts.file) as JSONSchema) : buildSchemaSpec(opts);
          const v = await client.proposeSchema(doc, name, spec, parseConcurrencyOpts(opts));
          if (opts.json) emitJson(v);
          else emit(`proposed ${describeSchema(v)}`);
        }),
    );

  schema
    .command('list <doc>')
    .option('--json')
    .action(async (doc: string, opts: { json?: boolean }) =>
      withClient(async (client) => {
        const schemas = await client.listSchemas(doc);
        if (opts.json) emitJson({ schemas });
        else emit(formatSchemaSummaries(schemas));
      }),
    );

  schema
    .command('show <doc> <name>')
    .option('--version <n>')
    .option('--proposed')
    .option('--full')
    .option('--json')
    .action(
      async (
        doc: string,
        name: string,
        opts: { version?: string; proposed?: boolean; full?: boolean; json?: boolean },
      ) =>
        withClient(async (client) => {
          const v = await fetchOrFallback(
            () =>
              client.getSchema(doc, name, {
                ...(opts.version !== undefined
                  ? { version: Number.parseInt(opts.version, 10) }
                  : {}),
                ...(opts.proposed ? { proposed: true } : {}),
              }),
            opts.proposed ? () => client.getSchema(doc, name) : null,
          );
          if (opts.json) emitJson(v);
          else if (opts.full) emit(`${describeSchema(v)}\n${yamlStringify(v.spec).trimEnd()}`);
          else emit(describeSchema(v));
        }),
    );

  schema
    .command('accept <doc> <name>')
    .option('--version <n>')
    .option('--json')
    .action(async (doc: string, name: string, opts: { version?: string; json?: boolean }) =>
      withClient(async (client) => {
        const versionN = opts.version !== undefined ? Number.parseInt(opts.version, 10) : undefined;
        const v = await client.acceptSchema(doc, name, versionN);
        if (opts.json) emitJson(v);
        else emit(`accepted ${describeSchema(v)}`);
      }),
    );

  schema
    .command('reject <doc> <name> <reason>')
    .option('--version <n>')
    .option('--json')
    .action(
      async (
        doc: string,
        name: string,
        reason: string,
        opts: { version?: string; json?: boolean },
      ) =>
        withClient(async (client) => {
          const versionN =
            opts.version !== undefined ? Number.parseInt(opts.version, 10) : undefined;
          const v = await client.rejectSchema(doc, name, reason, versionN);
          if (opts.json) emitJson(v);
          else emit(`rejected ${describeSchema(v)}`);
        }),
    );

  schema
    .command('withdraw <doc> <name>')
    .description('take back your own still-proposed version (only the proposer can withdraw)')
    .option('--version <n>')
    .option('--json')
    .action(async (doc: string, name: string, opts: { version?: string; json?: boolean }) =>
      withClient(async (client) => {
        const versionN = opts.version !== undefined ? Number.parseInt(opts.version, 10) : undefined;
        const v = await client.withdrawSchema(doc, name, versionN);
        if (opts.json) emitJson(v);
        else emit(`withdrew ${describeSchema(v)}`);
      }),
    );

  schema
    .command('diff <doc> <name>')
    .option('--from <n>')
    .option('--to <n>')
    .option(
      '--format <patch|yaml|json|rendered>',
      'patch=RFC 6902; yaml/json=wrapped envelope; rendered=side-by-side YAML',
      'patch',
    )
    .action(
      async (doc: string, name: string, opts: { from?: string; to?: string; format: string }) =>
        withClient(async (client) => {
          const diff = await client.diffSchema(doc, name, {
            ...(opts.from !== undefined ? { from: Number.parseInt(opts.from, 10) } : {}),
            ...(opts.to !== undefined ? { to: Number.parseInt(opts.to, 10) } : {}),
          });
          if (opts.format === 'rendered') {
            const [from, to] = await Promise.all([
              client.getSchema(doc, name, { version: diff.fromVersion }),
              client.getSchema(doc, name, { version: diff.toVersion }),
            ]);
            emitRenderedDiff(from.spec, to.spec, diff.fromVersion, diff.toVersion);
            return;
          }
          emitDiff(diff, opts.format);
        }),
    );

  // --- convention ---

  const convention = program
    .command('convention')
    .description('Document-level Info/Servers/SecuritySchemes');

  convention
    .command('propose <doc>')
    .option('--title <text>')
    .option('--api-version <text>', 'API version (e.g. "1.0.0")')
    .option('--description <text>')
    .option('--server <url:description>', 'server URL (repeatable)', collect, [])
    .option(
      '--security-scheme <name:type:config>',
      '"bearer:http:bearerFormat=JWT" (repeatable)',
      collect,
      [],
    )
    .option(
      '--global-security <scheme>',
      'apply this security scheme to every endpoint by default (repeatable; emitted as top-level OpenAPI `security`)',
      collect,
      [],
    )
    .option(
      '--naming <case>',
      'JSON-key naming policy: camelCase or snake_case (sets x-brackish.naming)',
    )
    .option('--file <path>', 'load full Convention block from YAML/JSON file')
    .option('--expected-new', 'require no prior version (refuse if anything exists)')
    .option('--expected-version <n>', 'require latest version to be exactly N (any status)')
    .option('--force', 'allow proposing on top of an unresolved (proposed) version')
    .option('--json')
    .action(async (doc: string, opts: ConventionProposeOpts) =>
      withClient(async (client) => {
        const spec = opts.file
          ? (loadSpecFile(opts.file) as ConventionSpec)
          : buildConventionSpec(opts);
        const v = await client.proposeConvention(doc, spec, parseConcurrencyOpts(opts));
        if (opts.json) emitJson(v);
        else emit(`proposed ${describeConvention(v)}`);
      }),
    );

  convention
    .command('show <doc>')
    .option('--proposed')
    .option('--full')
    .option('--json')
    .action(async (doc: string, opts: { proposed?: boolean; full?: boolean; json?: boolean }) =>
      withClient(async (client) => {
        const v = await fetchOrFallback(
          () =>
            opts.proposed ? client.getConventionProposed(doc) : client.getConventionCurrent(doc),
          opts.proposed ? () => client.getConventionCurrent(doc) : null,
        );
        if (opts.json) emitJson(v);
        else if (opts.full) emit(`${describeConvention(v)}\n${yamlStringify(v.spec).trimEnd()}`);
        else emit(describeConvention(v));
      }),
    );

  convention
    .command('accept <doc>')
    .option('--version <n>')
    .option('--json')
    .action(async (doc: string, opts: { version?: string; json?: boolean }) =>
      withClient(async (client) => {
        const versionN = opts.version !== undefined ? Number.parseInt(opts.version, 10) : undefined;
        const v = await client.acceptConvention(doc, versionN);
        if (opts.json) emitJson(v);
        else emit(`accepted ${describeConvention(v)}`);
      }),
    );

  convention
    .command('reject <doc> <reason>')
    .option('--version <n>')
    .option('--json')
    .action(async (doc: string, reason: string, opts: { version?: string; json?: boolean }) =>
      withClient(async (client) => {
        const versionN = opts.version !== undefined ? Number.parseInt(opts.version, 10) : undefined;
        const v = await client.rejectConvention(doc, reason, versionN);
        if (opts.json) emitJson(v);
        else emit(`rejected ${describeConvention(v)}`);
      }),
    );

  convention
    .command('withdraw <doc>')
    .description('take back your own still-proposed version (only the proposer can withdraw)')
    .option('--version <n>')
    .option('--json')
    .action(async (doc: string, opts: { version?: string; json?: boolean }) =>
      withClient(async (client) => {
        const versionN = opts.version !== undefined ? Number.parseInt(opts.version, 10) : undefined;
        const v = await client.withdrawConvention(doc, versionN);
        if (opts.json) emitJson(v);
        else emit(`withdrew ${describeConvention(v)}`);
      }),
    );

  convention
    .command('diff <doc>')
    .option('--from <n>')
    .option('--to <n>')
    .option(
      '--format <patch|yaml|json|rendered>',
      'patch=RFC 6902; yaml/json=wrapped envelope; rendered=side-by-side YAML',
      'patch',
    )
    .action(async (doc: string, opts: { from?: string; to?: string; format: string }) =>
      withClient(async (client) => {
        const diff = await client.diffConvention(doc, {
          ...(opts.from !== undefined ? { from: Number.parseInt(opts.from, 10) } : {}),
          ...(opts.to !== undefined ? { to: Number.parseInt(opts.to, 10) } : {}),
        });
        if (opts.format === 'rendered') {
          const [from, to] = await Promise.all([
            client.getConventionByVersion(doc, diff.fromVersion),
            client.getConventionByVersion(doc, diff.toVersion),
          ]);
          emitRenderedDiff(from.spec, to.spec, diff.fromVersion, diff.toVersion);
          return;
        }
        emitDiff(diff, opts.format);
      }),
    );

  // --- status (agent-facing "what am I blocked on") ---

  program
    .command('status <doc>')
    .description('summarize the document by ownership: awaiting peer, awaiting me, accepted')
    .option('--verbose', 'also list withdrawn/rejected items')
    .option('--json', 'output JSON (structured buckets)')
    .action(async (doc: string, opts: { verbose?: boolean; json?: boolean }) =>
      withClient(async (client, cfg) => {
        const me = cfg.identity;
        const [endpoints, schemas, conventionCurrent, conventionProposed] = await Promise.all([
          client.listEndpoints(doc),
          client.listSchemas(doc),
          client.getConventionCurrent(doc).catch(() => null),
          client.getConventionProposed(doc).catch(() => null),
        ]);

        type StatusRow = {
          kind: 'endpoint' | 'schema' | 'convention';
          label: string;
          version: number | null;
          proposedVersion: number | null;
          proposedBy: string | null;
          delta: string | null;
        };

        const awaitingPeer: StatusRow[] = [];
        const awaitingMe: StatusRow[] = [];
        const accepted: StatusRow[] = [];

        const classify = (
          kind: StatusRow['kind'],
          label: string,
          currentVersion: number | null,
          latestProposedVersion: number | null,
          latestProposedBy: string | null,
          latestDelta: string | null,
        ): void => {
          const row: StatusRow = {
            kind,
            label,
            version: currentVersion,
            proposedVersion: latestProposedVersion,
            proposedBy: latestProposedBy,
            delta: latestDelta,
          };
          const hasInFlight =
            latestProposedVersion !== null && latestProposedVersion > (currentVersion ?? 0);
          if (hasInFlight) {
            if (latestProposedBy === me) awaitingPeer.push(row);
            else awaitingMe.push(row);
          } else if (currentVersion !== null) {
            accepted.push(row);
          }
        };

        for (const e of endpoints) {
          classify(
            'endpoint',
            `${e.method.toUpperCase()} ${e.path}`,
            e.currentVersion,
            e.latestProposedVersion,
            e.latestProposedBy,
            e.latestDelta,
          );
        }
        for (const s of schemas) {
          classify(
            'schema',
            s.name,
            s.currentVersion,
            s.latestProposedVersion,
            s.latestProposedBy,
            s.latestDelta,
          );
        }
        // Convention: derive a synthetic summary row from current+proposed.
        if (conventionCurrent || conventionProposed) {
          const cur = conventionCurrent?.version ?? null;
          const prop = conventionProposed?.version ?? null;
          const propBy =
            conventionProposed?.status === 'proposed' ? conventionProposed.proposedBy : null;
          classify('convention', 'convention', cur, prop, propBy, null);
        }

        if (opts.json) {
          emitJson({ identity: me, awaitingPeer, awaitingMe, accepted });
          return;
        }

        const lines: string[] = [`${doc} — your identity = ${me}`];
        const bucket = (header: string, rows: StatusRow[]): void => {
          if (rows.length === 0) return;
          lines.push('');
          lines.push(header);
          for (const r of rows) {
            const v = r.proposedVersion ?? r.version ?? 0;
            const delta = r.delta ? `  ${r.delta}` : r.proposedVersion === 1 ? '  (new)' : '';
            const by = r.proposedBy && r.proposedBy !== me ? ` by ${r.proposedBy}` : '';
            lines.push(`  ${r.kind.padEnd(10)} ${r.label.padEnd(36)} v${v}${by}${delta}`);
          }
        };
        bucket('awaiting peer review (you proposed):', awaitingPeer);
        bucket('awaiting your review (peer proposed):', awaitingMe);
        bucket(`accepted (${accepted.length}):`, accepted);
        if (awaitingPeer.length + awaitingMe.length + accepted.length === 0) {
          lines.push('', '(nothing yet)');
        }
        emit(lines.join('\n'));
      }),
    );

  // --- visualize ---

  program
    .command('visualize <doc>')
    .description('render the current OpenAPI document in text/openapi/markdown/json/html')
    .option('--format <fmt>', 'text|openapi|markdown|json|html', 'text')
    .option('--full', 'text: include operation/schema bodies (default: ToC only)')
    .option('--out <path>', 'write to file instead of stdout')
    .action(async (doc: string, opts: { format: string; full?: boolean; out?: string }) =>
      withClient(async (client) => {
        let output: string;
        switch (opts.format) {
          case 'openapi':
            output = await client.getOpenApiYaml(doc);
            break;
          case 'json':
            output = `${JSON.stringify(await client.getOpenApiJson(doc), null, 2)}\n`;
            break;
          case 'text':
          case 'markdown':
          case 'html': {
            const document = (await client.getOpenApiJson(doc)) as OpenAPIDocument;
            const rationaleJson = (await client.getRationaleJson(doc)) as {
              endpoints: Record<string, RationaleEntry[]>;
              schemas: Record<string, RationaleEntry[]>;
              convention: RationaleEntry[];
            };
            const rationale = {
              endpoints: new Map(Object.entries(rationaleJson.endpoints)),
              schemas: new Map(Object.entries(rationaleJson.schemas)),
              convention: rationaleJson.convention,
            };
            if (opts.format === 'text') {
              output = renderText({ document, rationale }, opts.full ? { full: true } : {});
            } else if (opts.format === 'markdown') {
              const ev = await client.listEvents(doc, { limit: 1000 });
              output = renderMarkdown({ document, rationale, events: ev.events });
            } else {
              output = renderHtml({ document, rationale }, { documentName: doc });
            }
            break;
          }
          default:
            errExit(2, `visualize: unknown --format "${opts.format}"`);
        }
        if (opts.out) {
          writeFileSync(opts.out, output);
          process.stderr.write(`wrote ${opts.out}\n`);
        } else {
          process.stdout.write(output);
          if (!output.endsWith('\n')) process.stdout.write('\n');
        }
        // Silence the never-typed `output` warning in the default branch above.
        void renderJson;
        void renderOpenAPIYaml;
        void assembleDocument;
      }),
    );

  // --- demo (one-shot: ephemeral daemon + sample negotiation + browser URL) ---

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

        // Sandbox: a fresh BRACKISH_HOME so the demo can never collide with the user's real one.
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

        // Shutdown on signal: close the server (fire-and-forget — keep-alive connections shouldn't
        // block ^C) + (unless --keep) wipe the sandbox + exit.
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

        // Seed the doc.
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

        // Mint a browser-friendly token: invite a `viewer` identity over the socket (peer-trust),
        // redeem it over TCP, append it as a query param to the /ui URL.
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

  // --- install / uninstall / hook-snippet ---

  program
    .command('install')
    .description(
      'install the brackish skill and (with confirmation) the inbox UserPromptSubmit hook',
    )
    .option('--skill-only', 'install just the skill, not the hook')
    .option('--hook-only', 'install just the hook, not the skill')
    .option(
      '--scope <user|project>',
      'user → ~/.claude (global); project → ./.claude (commit-able). Interactive if omitted.',
    )
    .option('--global', 'shortcut for --scope user')
    .option('--local', 'shortcut for --scope project')
    .option(
      '--dest <path>',
      'override skill dest (defaults to <home>/skills/brackish for the chosen scope)',
    )
    .option(
      '--permission',
      `add an allow-rule for ${BRACKISH_PERMISSION_PATTERN} to settings.json (so Claude won't prompt before running brackish commands); default off`,
    )
    .option('--yes', 'non-interactive: assume yes to all confirmations (defaults scope to user)')
    .option('--force', 'overwrite existing skill dir')
    .action(
      async (opts: {
        skillOnly?: boolean;
        hookOnly?: boolean;
        scope?: string;
        global?: boolean;
        local?: boolean;
        dest?: string;
        permission?: boolean;
        yes?: boolean;
        force?: boolean;
      }) => {
        if (opts.skillOnly && opts.hookOnly) {
          errExit(2, 'install: pass at most one of --skill-only or --hook-only');
        }
        const scope = await resolveScope(opts);
        const home = claudeHome(scope);
        const dest = opts.dest ?? defaultSkillDest(home);
        const plan = inspectInstall({ home, dest });

        // Print plan to stderr.
        process.stderr.write(`brackish install — plan (scope=${scope}, home=${home}):\n`);
        if (!opts.hookOnly) {
          const skillNote = plan.skill.exists
            ? opts.force
              ? 'OVERWRITE (force)'
              : 'exists — needs --force to overwrite'
            : 'create';
          process.stderr.write(`  skill: ${plan.skill.destPath}\n    ${skillNote}\n`);
        }
        if (!opts.skillOnly) {
          if (plan.hook.settingsParseError) {
            errExit(
              2,
              `install: settings.json at ${plan.hook.settingsPath} is malformed:\n  ${plan.hook.settingsParseError}\nFix it (or move it aside) and re-run.`,
            );
          }
          const hookNote = plan.hook.needsMigration
            ? `migrate legacy hook entry into the matcher+hooks wrapper Claude Code requires (other hooks preserved: ${plan.hook.otherHookCount})`
            : plan.hook.alreadyInstalled
              ? 'already installed (no edit needed)'
              : plan.hook.settingsExists
                ? `merge into existing settings.json (other hooks preserved: ${plan.hook.otherHookCount})`
                : `create settings.json`;
          process.stderr.write(`  hook: ${plan.hook.settingsPath}\n    ${hookNote}\n`);
        }
        const permissionNote = plan.permission.alreadyInstalled
          ? 'already present (no edit needed)'
          : `add allow-rule ${plan.permission.pattern} (other allow entries preserved: ${plan.permission.otherAllowCount})`;
        process.stderr.write(`  perm: ${plan.permission.settingsPath}\n    ${permissionNote}\n`);

        // Per-artifact confirmation. Skip the hook step only when there's truly nothing to do
        // (correctly installed AND no legacy entry to clean up).
        const doSkill = !opts.hookOnly && (opts.yes || (await confirm('Install skill?', true)));
        const hookSettled = plan.hook.alreadyInstalled && !plan.hook.needsMigration;
        const doHook =
          !opts.skillOnly && !hookSettled && (opts.yes || (await confirm('Install hook?', true)));
        // --permission defaults OFF: explicit opt-in via flag, or default-no in the prompt.
        const doPermission = plan.permission.alreadyInstalled
          ? false
          : opts.permission === true
            ? true
            : opts.yes
              ? false
              : await confirm(`Add ${plan.permission.pattern} to settings.json?`, false);

        const summary: string[] = [];
        if (doSkill) {
          const res = installSkill(dest, opts.force ? { force: true } : {});
          summary.push(`  skill: wrote ${res.wroteFiles} files to ${res.destPath}`);
        } else if (!opts.hookOnly) {
          summary.push('  skill: skipped');
        }
        if (doHook) {
          // After the skill is copied, the hook script is at dest/hooks/inbox-on-prompt.sh.
          const scriptPath = `${dest}/hooks/inbox-on-prompt.sh`;
          const res = installHook(scriptPath, home);
          if (res.alreadyInstalled) summary.push('  hook: already installed (skipped)');
          else
            summary.push(
              `  hook: added entry → ${res.settingsPath}${res.backupPath ? ` (backup: ${res.backupPath})` : ''}`,
            );
        } else if (!opts.skillOnly) {
          summary.push(hookSettled ? '  hook: already installed (skipped)' : '  hook: skipped');
        }
        if (doPermission) {
          const res = installPermission(plan.permission.pattern, home);
          if (res.alreadyInstalled) summary.push('  perm: already present (skipped)');
          else
            summary.push(
              `  perm: added ${plan.permission.pattern} → ${res.settingsPath}${res.backupPath ? ` (backup: ${res.backupPath})` : ''}`,
            );
        } else {
          summary.push(
            plan.permission.alreadyInstalled
              ? '  perm: already present (skipped)'
              : '  perm: skipped',
          );
        }

        process.stderr.write(`\nbrackish install — done:\n${summary.join('\n')}\n`);
        if (doSkill || doHook || doPermission) {
          const yourHostname = sanitizeIdentity(hostname());
          process.stderr.write(
            [
              '',
              'Next steps:',
              '  1. `brackish up`                              — start the daemon (writes a default client config if needed)',
              '  2. In Claude Code, type a `/brackish` slash command:',
              `       /brackish invite <peer-name>             — bootstrap a cross-machine pair (server side)`,
              `       /brackish connect <line from peer>       — redeem an invite (client side)`,
              `     Or just say "let's negotiate the X API" and Claude picks it up from the skill.`,
              '',
              `  Your identity will default to "${yourHostname}" — pass --identity to override.`,
              '',
            ].join('\n'),
          );
        }
      },
    );

  program
    .command('uninstall')
    .description('reverse `brackish install`: remove the skill dir + our hook entry')
    .option('--skill-only', 'remove only the skill, leave the hook')
    .option('--hook-only', 'remove only the hook, leave the skill')
    .option(
      '--scope <user|project>',
      'user → ~/.claude (global); project → ./.claude. Interactive if omitted.',
    )
    .option('--global', 'shortcut for --scope user')
    .option('--local', 'shortcut for --scope project')
    .option(
      '--dest <path>',
      'override skill dest (defaults to <home>/skills/brackish for the chosen scope)',
    )
    .option('--yes', 'non-interactive: assume yes to all confirmations (defaults scope to user)')
    .action(
      async (opts: {
        skillOnly?: boolean;
        hookOnly?: boolean;
        scope?: string;
        global?: boolean;
        local?: boolean;
        dest?: string;
        yes?: boolean;
      }) => {
        if (opts.skillOnly && opts.hookOnly) {
          errExit(2, 'uninstall: pass at most one of --skill-only or --hook-only');
        }
        const scope = await resolveScope(opts);
        const home = claudeHome(scope);
        const dest = opts.dest ?? defaultSkillDest(home);
        const scriptPath = `${dest}/hooks/inbox-on-prompt.sh`;

        const plan = inspectInstall({ home, dest });
        process.stderr.write(`brackish uninstall — plan (scope=${scope}, home=${home}):\n`);
        if (!opts.hookOnly) {
          process.stderr.write(
            `  skill: ${plan.skill.destPath}\n    ${plan.skill.exists ? 'remove' : 'nothing to remove'}\n`,
          );
        }
        const hasHookEntry = plan.hook.alreadyInstalled || plan.hook.needsMigration;
        if (!opts.skillOnly) {
          process.stderr.write(
            `  hook:  ${plan.hook.settingsPath}\n    ${hasHookEntry ? 'remove our entry' : 'nothing to remove'}\n`,
          );
          process.stderr.write(
            `  perm:  ${plan.permission.settingsPath}\n    ${plan.permission.alreadyInstalled ? `remove allow-rule ${plan.permission.pattern}` : 'nothing to remove'}\n`,
          );
        }

        const doSkill =
          !opts.hookOnly &&
          plan.skill.exists &&
          (opts.yes || (await confirm('Uninstall skill?', true)));
        const doHook =
          !opts.skillOnly && hasHookEntry && (opts.yes || (await confirm('Uninstall hook?', true)));
        const doPermission =
          !opts.skillOnly &&
          plan.permission.alreadyInstalled &&
          (opts.yes || (await confirm(`Remove ${plan.permission.pattern}?`, true)));

        const summary: string[] = [];
        if (doSkill) {
          const removed = uninstallSkill(dest);
          summary.push(removed ? `  skill: removed ${dest}` : '  skill: nothing to remove');
        } else if (!opts.hookOnly && plan.skill.exists) {
          summary.push('  skill: skipped');
        } else if (!opts.hookOnly) {
          summary.push('  skill: nothing to remove');
        }
        if (doHook) {
          const res = uninstallHook(scriptPath, home);
          summary.push(
            res.removed
              ? `  hook: removed entry from ${res.settingsPath}${res.backupPath ? ` (backup: ${res.backupPath})` : ''}`
              : '  hook: nothing to remove',
          );
        } else if (!opts.skillOnly) {
          summary.push(hasHookEntry ? '  hook: skipped' : '  hook: nothing to remove');
        }
        if (doPermission) {
          const res = uninstallPermission(plan.permission.pattern, home);
          summary.push(
            res.removed
              ? `  perm: removed ${plan.permission.pattern} from ${res.settingsPath}${res.backupPath ? ` (backup: ${res.backupPath})` : ''}`
              : '  perm: nothing to remove',
          );
        } else if (!opts.skillOnly) {
          summary.push(
            plan.permission.alreadyInstalled ? '  perm: skipped' : '  perm: nothing to remove',
          );
        }

        process.stderr.write(`\nbrackish uninstall — done:\n${summary.join('\n')}\n`);
      },
    );

  program
    .command('hook-snippet')
    .description('print the settings.json JSON fragment for the inbox hook (writes nothing)')
    .option('--scope <user|project>', 'pick the home that resolves the skill dest (default user)')
    .option('--global', 'shortcut for --scope user')
    .option('--local', 'shortcut for --scope project')
    .option('--dest <path>', 'override skill destination')
    .action((opts: { scope?: string; global?: boolean; local?: boolean; dest?: string }) => {
      const scope: Scope = opts.local ? 'project' : opts.scope === 'project' ? 'project' : 'user';
      const home = claudeHome(scope);
      const dest = opts.dest ?? defaultSkillDest(home);
      const scriptPath = `${dest}/hooks/inbox-on-prompt.sh`;
      process.stdout.write(`${hookSnippet(scriptPath)}\n`);
    });

  return program;
}

// --- helpers ---

// Commander accumulator for repeatable options
function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

type ConcurrencyOpts = {
  expectedNew?: boolean;
  expectedVersion?: string;
  force?: boolean;
};

type EndpointProposeOpts = ConcurrencyOpts & {
  summary?: string;
  description?: string;
  requestContent: string[];
  response: string[];
  security: string[];
  inheritSecurity?: boolean;
  idempotent?: boolean;
  sideEffect: string[];
  timingP50?: string;
  timingP99?: string;
  timeout?: string;
  file?: string;
  json?: boolean;
};

/** Validate + normalize the three concurrency flags into the wire shape. */
function parseConcurrencyOpts(opts: ConcurrencyOpts): ProposeOptionsWire {
  if (opts.expectedNew && opts.expectedVersion !== undefined) {
    errExit(2, 'pass at most one of --expected-new or --expected-version');
  }
  const out: ProposeOptionsWire = {};
  if (opts.expectedNew) out.expectedVersion = 'new';
  else if (opts.expectedVersion !== undefined) {
    const n = Number.parseInt(opts.expectedVersion, 10);
    if (!Number.isFinite(n) || n < 1) {
      errExit(2, `--expected-version must be a positive integer (got "${opts.expectedVersion}")`);
    }
    out.expectedVersion = n;
  }
  if (opts.force) {
    if (out.expectedVersion !== undefined) {
      errExit(
        2,
        '--force is meaningless with --expected-* (the version assertion already governs racing)',
      );
    }
    out.force = true;
  }
  return out;
}

type ConventionProposeOpts = ConcurrencyOpts & {
  title?: string;
  apiVersion?: string;
  description?: string;
  server: string[];
  securityScheme: string[];
  globalSecurity: string[];
  naming?: string;
  file?: string;
  json?: boolean;
};

function loadSpecFile(path: string): unknown {
  const raw = readFileSync(path, 'utf8');
  if (path.endsWith('.json')) return JSON.parse(raw);
  return yamlParse(raw);
}

function buildOperationSpec(
  opts: EndpointProposeOpts,
  ctx: { path: string; convention: ConventionArtifact | null },
): OperationSpec {
  const spec: Record<string, unknown> = {};
  if (opts.summary !== undefined) spec.summary = opts.summary;
  if (opts.description !== undefined) spec.description = opts.description;

  // Auto-derive parameters from `{var}` placeholders in the path.
  const pathParams = [...ctx.path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
  if (pathParams.length > 0) {
    spec.parameters = pathParams.map((name) => ({
      name,
      in: 'path',
      required: true,
      description: `${name} path parameter`,
      schema: { type: 'string' },
    }));
  }

  // requestBody
  if (opts.requestContent.length > 0) {
    const content: Record<string, unknown> = {};
    for (const entry of opts.requestContent) {
      // form: 'application/json=SchemaName' or 'application/json=inline'
      const eq = entry.indexOf('=');
      if (eq < 0) {
        throw new Error(`--request-content requires "ct=schema" form (got: ${entry})`);
      }
      const ct = entry.slice(0, eq);
      const sch = entry.slice(eq + 1);
      content[ct] = { schema: parseSchemaRefOrInline(sch) };
    }
    spec.requestBody = { content };
  }

  // responses (required by OpenAPI)
  const responses: Record<string, unknown> = {};
  if (opts.response.length === 0) {
    responses['200'] = { description: 'OK' };
  } else {
    for (const entry of opts.response) {
      // status:ct:schema:description (last 3 segments optional after status)
      const parts = entry.split(':');
      const status = parts[0] ?? '200';
      const ct = parts[1];
      const sch = parts[2];
      const desc = parts.slice(3).join(':') || (ct === undefined ? status : '');
      const r: Record<string, unknown> = { description: desc || 'response' };
      if (ct !== undefined && sch !== undefined && sch !== '') {
        r.content = { [ct]: { schema: parseSchemaRefOrInline(sch) } };
      }
      responses[status] = r;
    }
  }
  spec.responses = responses;

  if (opts.security.length > 0) {
    spec.security = opts.security.map((s) => ({ [s]: [] }));
  } else if (opts.inheritSecurity !== false && ctx.convention) {
    // Inherit the convention's top-level `security` if it has one. Skipped on --no-inherit-security.
    const convSec = (ctx.convention.spec as Record<string, unknown>).security;
    if (Array.isArray(convSec) && convSec.length > 0) spec.security = convSec;
  }

  // brackish extensions — all consolidated under `x-brackish` per the skill.
  const brackishExt: Record<string, unknown> = {};
  if (opts.idempotent) brackishExt.idempotent = true;
  if (opts.sideEffect.length > 0) brackishExt.sideEffects = opts.sideEffect;
  if (opts.timingP50 || opts.timingP99 || opts.timeout) {
    const timing: Record<string, string> = {};
    if (opts.timingP50) timing.p50 = opts.timingP50;
    if (opts.timingP99) timing.p99 = opts.timingP99;
    if (opts.timeout) timing.timeout = opts.timeout;
    brackishExt.timing = timing;
  }
  if (Object.keys(brackishExt).length > 0) spec['x-brackish'] = brackishExt;

  return spec as OperationSpec;
}

function parseSchemaRefOrInline(s: string): JSONSchema {
  // If it starts with a capital letter and is a single token, treat as a $ref.
  if (/^[A-Z][A-Za-z0-9_]*$/.test(s)) {
    return { $ref: `#/components/schemas/${s}` };
  }
  // Otherwise try JSON parse (for inline schemas).
  try {
    return JSON.parse(s) as JSONSchema;
  } catch {
    return { type: s };
  }
}

function buildSchemaSpec(opts: { field: string[]; description?: string }): JSONSchema {
  if (opts.field.length === 0) {
    return opts.description !== undefined
      ? { type: 'object', description: opts.description }
      : { type: 'object' };
  }
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];
  for (const f of opts.field) {
    const firstColon = f.indexOf(':');
    if (firstColon < 0)
      throw new Error(`invalid --field "${f}" (expected name:type[?][:description])`);
    const name = f.slice(0, firstColon);
    const rest = f.slice(firstColon + 1);
    let isOptional = false;
    let description: string | undefined;
    const descColon = rest.indexOf(':');
    let typeStr = rest;
    if (descColon >= 0) {
      typeStr = rest.slice(0, descColon);
      description = rest.slice(descColon + 1);
    }
    if (typeStr.endsWith('?')) {
      isOptional = true;
      typeStr = typeStr.slice(0, -1);
    }
    properties[name] = fieldTypeToSchema(typeStr, description);
    if (!isOptional) required.push(name);
  }
  const out: JSONSchema = { type: 'object', properties };
  if (required.length > 0) out.required = required;
  if (opts.description !== undefined) out.description = opts.description;
  return out;
}

function fieldTypeToSchema(typeStr: string, description?: string): JSONSchema {
  const base: JSONSchema = description !== undefined ? { description } : {};
  if (typeStr.endsWith('[]')) {
    return { ...base, type: 'array', items: fieldTypeToSchema(typeStr.slice(0, -2)) };
  }
  if (['string', 'integer', 'number', 'boolean', 'null'].includes(typeStr)) {
    return { ...base, type: typeStr };
  }
  if (/^[A-Z][A-Za-z0-9_]*$/.test(typeStr)) {
    return { ...base, $ref: `#/components/schemas/${typeStr}` };
  }
  return { ...base, type: typeStr };
}

function buildConventionSpec(opts: ConventionProposeOpts): ConventionSpec {
  const info: Record<string, unknown> = {
    title: opts.title ?? 'Untitled',
    version: opts.apiVersion ?? '0.0.0',
  };
  if (opts.description !== undefined) info.description = opts.description;
  const spec: Record<string, unknown> = { info };
  if (opts.server.length > 0) {
    spec.servers = opts.server.map((s) => {
      const colon = s.indexOf(':');
      // URLs have colons; only treat the LAST colon-separated chunk as description if it doesn't
      // look like a URL scheme. Simpler heuristic: split into url + ":" + description after the
      // ://. If no '://' found, treat whole thing as the URL.
      const proto = s.indexOf('://');
      if (proto < 0 && colon >= 0)
        return { url: s.slice(0, colon), description: s.slice(colon + 1) };
      // Find the colon AFTER the scheme.
      const afterScheme = s.indexOf(':', proto + 3);
      if (afterScheme < 0) return { url: s };
      return { url: s.slice(0, afterScheme), description: s.slice(afterScheme + 1) };
    });
  }
  if (opts.securityScheme.length > 0) {
    const schemes: Record<string, Record<string, unknown>> = {};
    for (const entry of opts.securityScheme) {
      // form: 'name:type:k=v[,k=v...]'
      const parts = entry.split(':');
      const name = parts[0];
      const type = parts[1];
      if (!name || !type) {
        throw new Error(`invalid --security-scheme "${entry}" (expected name:type:config)`);
      }
      const cfg: Record<string, unknown> = { type };
      if (parts[2]) {
        for (const kv of parts[2].split(',')) {
          const [k, v] = kv.split('=');
          if (k && v !== undefined) cfg[k] = v;
        }
      }
      schemes[name] = cfg;
    }
    spec.securitySchemes = schemes;
  }
  if (opts.globalSecurity.length > 0) {
    // Top-level OpenAPI `security` is `[{ schemeName: [scopes] }, …]`. We don't model
    // scopes here; each --global-security <scheme> becomes `{ <scheme>: [] }`.
    spec.security = opts.globalSecurity.map((s) => ({ [s]: [] }));
  }
  if (opts.naming !== undefined) {
    if (opts.naming !== 'camelCase' && opts.naming !== 'snake_case') {
      throw new Error(`--naming must be "camelCase" or "snake_case" (got "${opts.naming}")`);
    }
    spec['x-brackish'] = { ...(spec['x-brackish'] as object | undefined), naming: opts.naming };
  }
  return spec as ConventionSpec;
}

/**
 * Try `primary`; if it fails with `artifact_not_found` AND a `fallback` is provided, retry the
 * fallback and emit a stderr hint. Lets `show --proposed` degrade to "showing latest accepted"
 * instead of looking like the artifact was deleted.
 */
async function fetchOrFallback<T>(
  primary: () => Promise<T>,
  fallback: (() => Promise<T>) | null,
): Promise<T> {
  try {
    return await primary();
  } catch (e) {
    if (fallback && e instanceof ClientError && e.code === 'artifact_not_found') {
      process.stderr.write('note: no proposed version; showing latest accepted\n');
      return fallback();
    }
    throw e;
  }
}

function emitDiff(
  diff: { fromVersion: number; toVersion: number; patch: unknown[] },
  format: string,
): void {
  if (format === 'yaml') {
    process.stdout.write(yamlStringify(diff));
    return;
  }
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
    return;
  }
  // 'patch' (default): emit just the patch array as JSON, plus a header line on stderr
  process.stderr.write(`diff ${diff.fromVersion} → ${diff.toVersion}:\n`);
  process.stdout.write(`${JSON.stringify(diff.patch, null, 2)}\n`);
}

/** Unified-style line diff between the YAML rendering of two specs. Output uses `- ` / `+ ` / `  ` prefixes. */
function emitRenderedDiff(from: unknown, to: unknown, fromV: number, toV: number): void {
  const a = yamlStringify(from).split('\n');
  const b = yamlStringify(to).split('\n');
  if (a[a.length - 1] === '') a.pop();
  if (b[b.length - 1] === '') b.pop();
  const m = a.length;
  const n = b.length;
  // LCS DP over a flat row-major array; index (i,j) → i*(n+1)+j.
  const dp = new Array<number>((m + 1) * (n + 1)).fill(0);
  const at = (i: number, j: number): number => dp[i * (n + 1) + j] ?? 0;
  const set = (i: number, j: number, v: number): void => {
    dp[i * (n + 1) + j] = v;
  };
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      set(i, j, a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1)));
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      lines.push(`- ${a[i++]}`);
    } else {
      lines.push(`+ ${b[j++]}`);
    }
  }
  while (i < m) lines.push(`- ${a[i++]}`);
  while (j < n) lines.push(`+ ${b[j++]}`);
  process.stderr.write(`diff v${fromV} → v${toV} (rendered):\n`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

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

async function loadClientConfigForServeAddr(): Promise<{ tcpUrl: string; hint?: string }> {
  const fileCfg = loadServerConfig();
  if (fileCfg.bind === undefined) {
    errExit(
      2,
      'invite: this server has no TCP bind set; invites only make sense for cross-machine use.',
    );
  }
  const { host, port } = parseBindAddress(fileCfg.bind);
  const inferred = await inferReachableHost(host);
  return {
    tcpUrl: `http://${inferred.host}:${port}`,
    ...(inferred.hint ? { hint: inferred.hint } : {}),
  };
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

function servePidPath(): string {
  return join(brackishHome(), 'serve.pid');
}

/** True iff something is listening on the unix socket right now. */
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

/** Coerce an arbitrary string into a valid IdentitySchema-shaped name. */
function sanitizeIdentity(raw: string): string {
  const lowered = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const trimmed = lowered.replace(/^[^a-z]+/, '').slice(0, 64);
  return trimmed || 'host';
}

/** Write a default client config (socket transport, default identity) if none exists. */
async function ensureClientConfig(explicitIdentity?: string): Promise<void> {
  const path = defaultClientConfigPath();
  if (existsSync(path)) return;
  const raw = explicitIdentity ?? process.env.BRACKISH_IDENTITY ?? sanitizeIdentity(hostname());
  const identity = IdentitySchema.parse(sanitizeIdentity(raw));
  saveClientConfig({ identity, socketPath: defaultSocketPath() });
  process.stderr.write(`brackish: wrote ${path}, identity=${identity}\n`);
}

/**
 * Discover the local IPv4 the kernel would source from for outbound traffic.
 *
 * UDP `connect()` stores a peer address and triggers a route-table lookup that binds
 * the socket to a local address — no packet is sent. The destination is 192.0.2.1
 * (TEST-NET-1, RFC 5737), IETF-reserved as unroutable.
 */
async function discoverOutboundIPv4(): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = createDgramSocket('udp4');
    let done = false;
    const finish = (val: string | null): void => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(val);
    };
    sock.once('error', () => finish(null));
    sock.connect(1, '192.0.2.1', () => {
      try {
        const addr = sock.address();
        finish(addr.address && addr.address !== '0.0.0.0' ? addr.address : null);
      } catch {
        finish(null);
      }
    });
  });
}

async function inferReachableHost(boundHost: string): Promise<{ host: string; hint?: string }> {
  if (boundHost !== '0.0.0.0' && boundHost !== '::') return { host: boundHost };
  const outbound = await discoverOutboundIPv4();
  if (outbound !== null) return { host: outbound };
  return {
    host: boundHost,
    hint: "couldn't infer a reachable host; replace 0.0.0.0 with this machine's address",
  };
}

/** Determine the install scope from flags or prompt. Defaults to `user` when non-interactive. */
async function resolveScope(opts: {
  scope?: string;
  global?: boolean;
  local?: boolean;
  yes?: boolean;
}): Promise<Scope> {
  if (opts.global && opts.local) {
    errExit(2, 'install: pass at most one of --global and --local');
  }
  if (opts.scope !== undefined && opts.scope !== 'user' && opts.scope !== 'project') {
    errExit(2, `install: invalid --scope ${opts.scope} (expected: user, project)`);
  }
  const flagged: Scope | null = opts.global
    ? 'user'
    : opts.local
      ? 'project'
      : opts.scope === 'user' || opts.scope === 'project'
        ? opts.scope
        : null;
  if (flagged) return flagged;
  if (opts.yes || !process.stdin.isTTY) return 'user';

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(
      [
        'Install scope?',
        `  1) user    — ${userClaudeHome()}      (global; applies to every Claude session)`,
        `  2) project — ${projectClaudeHome()}   (commit-able; applies when Claude is launched from this dir or any descendant)`,
        '',
      ].join('\n'),
    );
    while (true) {
      const ans = (await rl.question('Choose [1/2] (default 1): ')).trim().toLowerCase();
      if (ans === '' || ans === '1' || ans === 'user' || ans === 'u') return 'user';
      if (ans === '2' || ans === 'project' || ans === 'p') return 'project';
      process.stderr.write('  please answer 1 (user) or 2 (project)\n');
    }
  } finally {
    rl.close();
  }
}

async function confirm(prompt: string, defaultYes: boolean): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const ans = (await rl.question(`${prompt} ${suffix} `)).trim().toLowerCase();
    if (ans === '') return defaultYes;
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

// --- main ---

import { realpathSync } from 'node:fs';

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const thisFile = fileURLToPath(import.meta.url);
  if (entry === thisFile) return true;
  // npm installs as a symlink in <prefix>/bin/<bin>; resolve to the real path.
  try {
    return realpathSync(entry) === thisFile;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err) => {
      errExit(2, err instanceof Error ? err.message : String(err));
    });
}
