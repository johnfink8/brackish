// Commander wiring for the brackish CLI.
//
// Output convention:
//   - default = compact text to stdout, human-and-LLM friendly, dense
//   - --json   = a single JSON object/array to stdout, suitable for piping
//   - stderr is for metadata + diagnostics; stdout is for the "thing"
//   - exit 0 = success (including timed-out wait); 1 = operation error; 2 = usage/auth/connection

import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
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
import { seedChatterDemo } from './demo.js';
import {
  defaultSkillDest,
  hookSnippet,
  inspectInstall,
  installHook,
  installSkill,
  uninstallHook,
  uninstallSkill,
} from './install.js';
import {
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

const CLI_VERSION = '0.2.0';

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

  // --- documents ---

  program
    .command('documents')
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
    .description('propose an OpenAPI Operation (request/responses/security/x-brackish-*)')
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
    .option('--idempotent', 'x-brackish-idempotent: true')
    .option('--side-effect <text>', 'x-brackish-side-effect note (repeatable)', collect, [])
    .option('--timing-p50 <duration>', 'x-brackish-timing.p50')
    .option('--timing-p99 <duration>', 'x-brackish-timing.p99')
    .option('--timeout <duration>', 'x-brackish-timing.timeout')
    .option(
      '--file <path>',
      'load full Operation Object from YAML/JSON file (replaces other flags)',
    )
    .option('--json', 'output JSON')
    .action(async (doc: string, methodRaw: string, path: string, opts: EndpointProposeOpts) =>
      withClient(async (client) => {
        const method = HttpMethodSchema.parse(methodRaw.toLowerCase());
        const spec = opts.file
          ? (loadSpecFile(opts.file) as OperationSpec)
          : buildOperationSpec(opts);
        const v = await client.proposeEndpoint(doc, method, path, spec);
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
          const v = await client.getEndpoint(doc, method, path, {
            ...(opts.version !== undefined ? { version: Number.parseInt(opts.version, 10) } : {}),
            ...(opts.proposed ? { proposed: true } : {}),
          });
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
    .command('diff <doc> <method> <path>')
    .description('RFC 6902 JSON Patch between two versions (defaults: prev → latest)')
    .option('--from <n>')
    .option('--to <n>')
    .option('--format <patch|yaml|json>', 'patch=array, yaml/json=wrapped envelope', 'patch')
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
    .option('--json')
    .action(
      async (
        doc: string,
        name: string,
        opts: { field: string[]; description?: string; file?: string; json?: boolean },
      ) =>
        withClient(async (client) => {
          const spec = opts.file ? (loadSpecFile(opts.file) as JSONSchema) : buildSchemaSpec(opts);
          const v = await client.proposeSchema(doc, name, spec);
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
          const v = await client.getSchema(doc, name, {
            ...(opts.version !== undefined ? { version: Number.parseInt(opts.version, 10) } : {}),
            ...(opts.proposed ? { proposed: true } : {}),
          });
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
    .command('diff <doc> <name>')
    .option('--from <n>')
    .option('--to <n>')
    .option('--format <patch|yaml|json>', 'patch=array, yaml/json=wrapped envelope', 'patch')
    .action(
      async (doc: string, name: string, opts: { from?: string; to?: string; format: string }) =>
        withClient(async (client) => {
          const diff = await client.diffSchema(doc, name, {
            ...(opts.from !== undefined ? { from: Number.parseInt(opts.from, 10) } : {}),
            ...(opts.to !== undefined ? { to: Number.parseInt(opts.to, 10) } : {}),
          });
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
    .option('--file <path>', 'load full Convention block from YAML/JSON file')
    .option('--json')
    .action(async (doc: string, opts: ConventionProposeOpts) =>
      withClient(async (client) => {
        const spec = opts.file
          ? (loadSpecFile(opts.file) as ConventionSpec)
          : buildConventionSpec(opts);
        const v = await client.proposeConvention(doc, spec);
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
        const v = opts.proposed
          ? await client.getConventionProposed(doc)
          : await client.getConventionCurrent(doc);
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
    .command('diff <doc>')
    .option('--from <n>')
    .option('--to <n>')
    .option('--format <patch|yaml|json>', 'patch=array, yaml/json=wrapped envelope', 'patch')
    .action(async (doc: string, opts: { from?: string; to?: string; format: string }) =>
      withClient(async (client) => {
        const diff = await client.diffConvention(doc, {
          ...(opts.from !== undefined ? { from: Number.parseInt(opts.from, 10) } : {}),
          ...(opts.to !== undefined ? { to: Number.parseInt(opts.to, 10) } : {}),
        });
        emitDiff(diff, opts.format);
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

  // --- demo (seed a sample negotiated document for the browser UI demo) ---

  program
    .command('demo [doc]')
    .description(
      'seed a sample chat-API negotiation (multi-content-type, with rejections + a WS endpoint) for the /ui browser demo. Uses the socket transport to impersonate two identities, so run after `brackish serve` is up.',
    )
    .option('--alice <name>', 'identity for the proposing side', 'alice')
    .option('--bob <name>', 'identity for the accepting/rejecting side', 'bob')
    .action(async (docArg: string | undefined, opts: { alice: string; bob: string }) => {
      const cfg = loadClientConfig();
      if (cfg.socketPath === undefined) {
        errExit(
          2,
          'demo: the seed needs the socket transport (peer-trust) to impersonate two identities. Configure --socket-path via `brackish init` or set BRACKISH_SOCKET.',
        );
      }
      const docName = docArg ?? 'chatter-api';
      IdentitySchema.parse(opts.alice);
      IdentitySchema.parse(opts.bob);
      try {
        await seedChatterDemo({
          socketPath: cfg.socketPath,
          documentName: docName,
          alice: opts.alice,
          bob: opts.bob,
          onStep: (m) => process.stderr.write(`  ${m}\n`),
        });
      } catch (err) {
        if (err instanceof ClientError && err.code === 'document_exists') {
          errExit(
            1,
            `demo: document "${docName}" already exists. Pick a different name (e.g. \`brackish demo my-chatter\`) or delete the existing one first.`,
          );
        }
        throw err;
      }
      process.stderr.write(
        `\ndone. Look at the result:\n` +
          `  brackish visualize ${docName} --format markdown | less\n` +
          `  open http://127.0.0.1:<port>/ui/${docName}   (if brackish serve --bind is up)\n`,
      );
    });

  // --- install / uninstall / hook-snippet ---

  program
    .command('install')
    .description(
      'install the brackish skill and (with confirmation) the inbox UserPromptSubmit hook',
    )
    .option('--skill-only', 'install just the skill, not the hook')
    .option('--hook-only', 'install just the hook, not the skill')
    .option('--dest <path>', 'override skill destination (default ~/.claude/skills/brackish)')
    .option('--yes', 'non-interactive: assume yes to all confirmations')
    .option('--force', 'overwrite existing skill dir')
    .action(
      async (opts: {
        skillOnly?: boolean;
        hookOnly?: boolean;
        dest?: string;
        yes?: boolean;
        force?: boolean;
      }) => {
        if (opts.skillOnly && opts.hookOnly) {
          errExit(2, 'install: pass at most one of --skill-only or --hook-only');
        }
        const dest = opts.dest ?? defaultSkillDest();
        const plan = inspectInstall({ dest });

        // Print plan to stderr.
        process.stderr.write('brackish install — plan:\n');
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
          const hookNote = plan.hook.alreadyInstalled
            ? 'already installed (no edit needed)'
            : plan.hook.settingsExists
              ? `merge into existing settings.json (other hooks preserved: ${plan.hook.otherHookCount})`
              : `create settings.json`;
          process.stderr.write(`  hook: ${plan.hook.settingsPath}\n    ${hookNote}\n`);
        }

        // Per-artifact confirmation.
        const doSkill = !opts.hookOnly && (opts.yes || (await confirm('Install skill?', true)));
        const doHook =
          !opts.skillOnly &&
          !plan.hook.alreadyInstalled &&
          (opts.yes || (await confirm('Install hook?', true)));

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
          const res = installHook(scriptPath);
          if (res.alreadyInstalled) summary.push('  hook: already installed (skipped)');
          else
            summary.push(
              `  hook: added entry → ${res.settingsPath}${res.backupPath ? ` (backup: ${res.backupPath})` : ''}`,
            );
        } else if (!opts.skillOnly) {
          summary.push(
            plan.hook.alreadyInstalled ? '  hook: already installed (skipped)' : '  hook: skipped',
          );
        }

        process.stderr.write(`\nbrackish install — done:\n${summary.join('\n')}\n`);
        if (doSkill || doHook) {
          process.stderr.write(
            '\nNext: `brackish init --identity <name>` (if not already), then `brackish serve &`.\n',
          );
        }
      },
    );

  program
    .command('uninstall')
    .description('reverse `brackish install`: remove the skill dir + our hook entry')
    .option('--skill-only', 'remove only the skill, leave the hook')
    .option('--hook-only', 'remove only the hook, leave the skill')
    .option('--dest <path>', 'override skill destination (default ~/.claude/skills/brackish)')
    .option('--yes', 'non-interactive: assume yes to all confirmations')
    .action(
      async (opts: { skillOnly?: boolean; hookOnly?: boolean; dest?: string; yes?: boolean }) => {
        if (opts.skillOnly && opts.hookOnly) {
          errExit(2, 'uninstall: pass at most one of --skill-only or --hook-only');
        }
        const dest = opts.dest ?? defaultSkillDest();
        const scriptPath = `${dest}/hooks/inbox-on-prompt.sh`;

        const plan = inspectInstall({ dest });
        process.stderr.write('brackish uninstall — plan:\n');
        if (!opts.hookOnly) {
          process.stderr.write(
            `  skill: ${plan.skill.destPath}\n    ${plan.skill.exists ? 'remove' : 'nothing to remove'}\n`,
          );
        }
        if (!opts.skillOnly) {
          process.stderr.write(
            `  hook:  ${plan.hook.settingsPath}\n    ${plan.hook.alreadyInstalled ? 'remove our entry' : 'nothing to remove'}\n`,
          );
        }

        const doSkill =
          !opts.hookOnly &&
          plan.skill.exists &&
          (opts.yes || (await confirm('Uninstall skill?', true)));
        const doHook =
          !opts.skillOnly &&
          plan.hook.alreadyInstalled &&
          (opts.yes || (await confirm('Uninstall hook?', true)));

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
          const res = uninstallHook(scriptPath);
          summary.push(
            res.removed
              ? `  hook: removed entry from ${res.settingsPath}${res.backupPath ? ` (backup: ${res.backupPath})` : ''}`
              : '  hook: nothing to remove',
          );
        } else if (!opts.skillOnly) {
          summary.push(
            plan.hook.alreadyInstalled ? '  hook: skipped' : '  hook: nothing to remove',
          );
        }

        process.stderr.write(`\nbrackish uninstall — done:\n${summary.join('\n')}\n`);
      },
    );

  program
    .command('hook-snippet')
    .description('print the settings.json JSON fragment for the inbox hook (writes nothing)')
    .option('--dest <path>', 'override skill destination (default ~/.claude/skills/brackish)')
    .action((opts: { dest?: string }) => {
      const dest = opts.dest ?? defaultSkillDest();
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

type EndpointProposeOpts = {
  summary?: string;
  description?: string;
  requestContent: string[];
  response: string[];
  security: string[];
  idempotent?: boolean;
  sideEffect: string[];
  timingP50?: string;
  timingP99?: string;
  timeout?: string;
  file?: string;
  json?: boolean;
};

type ConventionProposeOpts = {
  title?: string;
  apiVersion?: string;
  description?: string;
  server: string[];
  securityScheme: string[];
  file?: string;
  json?: boolean;
};

function loadSpecFile(path: string): unknown {
  const raw = readFileSync(path, 'utf8');
  if (path.endsWith('.json')) return JSON.parse(raw);
  return yamlParse(raw);
}

function buildOperationSpec(opts: EndpointProposeOpts): OperationSpec {
  const spec: Record<string, unknown> = {};
  if (opts.summary !== undefined) spec.summary = opts.summary;
  if (opts.description !== undefined) spec.description = opts.description;

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
  }

  // brackish extensions
  if (opts.idempotent) spec['x-brackish-idempotent'] = true;
  if (opts.sideEffect.length > 0) spec['x-brackish-side-effects'] = opts.sideEffect;
  if (opts.timingP50 || opts.timingP99 || opts.timeout) {
    const timing: Record<string, string> = {};
    if (opts.timingP50) timing.p50 = opts.timingP50;
    if (opts.timingP99) timing.p99 = opts.timingP99;
    if (opts.timeout) timing.timeout = opts.timeout;
    spec['x-brackish-timing'] = timing;
  }

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
  return spec as ConventionSpec;
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
import { fileURLToPath } from 'node:url';

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
