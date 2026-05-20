// Convention (document-level info/servers/security) command group:
// propose/show/accept/reject/withdraw/diff/lint.

import type { Command } from 'commander';
import { stringify as yamlStringify } from 'yaml';
import { lintConventionSpec } from '../lib/lint.js';
import { type ConventionSpec, ConventionSpecSchema } from '../lib/models.js';
import { loadSpecFile, parseSpecFile } from '../lib/specfile.js';
import { describeConvention } from '../render/output.js';
import {
  type ConcurrencyOpts,
  collect,
  emit,
  emitDiff,
  emitJson,
  emitRenderedDiff,
  fetchOrFallback,
  finalizeLint,
  parseConcurrencyOpts,
  warnFileClobbers,
  withClient,
} from './common.js';

type ConventionProposeOpts = ConcurrencyOpts & {
  title?: string;
  apiVersion?: string;
  description?: string;
  server: string[];
  serverUrl?: string;
  serverDescription?: string;
  securityScheme: string[];
  globalSecurity: string[];
  naming?: string;
  file?: string;
  json?: boolean;
};

export function register(program: Command): void {
  const convention = program
    .command('convention')
    .description('Document-level Info/Servers/SecuritySchemes');

  convention
    .command('propose <doc>')
    .option('--title <text>')
    .option('--api-version <text>', 'API version (e.g. "1.0.0")')
    .option('--description <text>')
    .option(
      '--server <url:description>',
      'server URL (repeatable). Colon-delimited form; ambiguous when the URL contains a port — prefer --server-url + --server-description.',
      collect,
      [],
    )
    .option(
      '--server-url <url>',
      "server URL (unambiguous; pair with --server-description). Repeatable but doesn't pair across repeats — use --server for multi-server.",
    )
    .option('--server-description <text>', 'description for --server-url (optional)')
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
        if (opts.file) {
          const ignored: string[] = [];
          if (opts.title !== undefined) ignored.push('--title');
          if (opts.apiVersion !== undefined) ignored.push('--api-version');
          if (opts.description !== undefined) ignored.push('--description');
          if (opts.server.length > 0) ignored.push('--server');
          if (opts.serverUrl !== undefined) ignored.push('--server-url');
          if (opts.serverDescription !== undefined) ignored.push('--server-description');
          if (opts.securityScheme.length > 0) ignored.push('--security-scheme');
          if (opts.globalSecurity.length > 0) ignored.push('--global-security');
          if (opts.naming !== undefined) ignored.push('--naming');
          warnFileClobbers(opts.file, ignored);
        }
        const spec = opts.file
          ? loadSpecFile(opts.file, ConventionSpecSchema)
          : buildConventionSpec(opts);
        const v = await client.proposeConvention(doc, spec, parseConcurrencyOpts(opts));
        if (opts.json) emitJson(v);
        else
          emit(
            `proposed ${describeConvention(v)}\n  → convention sets doc-level defaults (security, naming). Schemas + endpoints inherit from it — peer should accept this first before you propose dependents.`,
          );
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
          !opts.proposed ? () => client.getConventionProposed(doc) : undefined,
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
        else
          emit(
            `rejected ${describeConvention(v)}\n  → peer sees the reason in their inbox; a rejected convention blocks dependents — they should re-propose before either side adds more schemas/endpoints`,
          );
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

  convention
    .command('lint <file>')
    .description(
      'check a YAML/JSON Convention file locally before proposing: parse errors with line/col, info required fields, security/securitySchemes consistency, x-brackish.naming enum',
    )
    .option('--json', 'output JSON')
    .option('--strict', 'treat warnings as errors (exit 1 on warnings)')
    .action(async (file: string, opts: { json?: boolean; strict?: boolean }) => {
      await finalizeLint(parseSpecFile(file), lintConventionSpec, opts);
    });
}

/**
 * Parse the colon-delimited `--server "url:description"` form.
 *
 * `ambiguous: true` means the URL contains a port colon AND a description colon — the heuristic
 * picks the first colon after the scheme, but that's likely splitting `:port` from `description`
 * incorrectly. Caller should warn and steer toward --server-url / --server-description.
 */
function parseServerColonForm(s: string): {
  url: string;
  description?: string;
  ambiguous: boolean;
} {
  const proto = s.indexOf('://');
  if (proto < 0) {
    const colon = s.indexOf(':');
    if (colon < 0) return { url: s, ambiguous: false };
    return { url: s.slice(0, colon), description: s.slice(colon + 1), ambiguous: false };
  }
  const afterScheme = s.indexOf(':', proto + 3);
  if (afterScheme < 0) return { url: s, ambiguous: false };
  const nextColon = s.indexOf(':', afterScheme + 1);
  return {
    url: s.slice(0, afterScheme),
    description: s.slice(afterScheme + 1),
    ambiguous: nextColon >= 0,
  };
}

function buildConventionSpec(opts: ConventionProposeOpts): ConventionSpec {
  const info: Record<string, unknown> = {
    title: opts.title ?? 'Untitled',
    version: opts.apiVersion ?? '0.0.0',
  };
  if (opts.description !== undefined) info.description = opts.description;
  const spec: Record<string, unknown> = { info };
  const servers: Array<{ url: string; description?: string }> = [];
  for (const s of opts.server) {
    const parsed = parseServerColonForm(s);
    if (parsed.ambiguous) {
      process.stderr.write(
        `warning: --server "${s}" is ambiguous (URL contains a port colon and a description colon).\n` +
          `         Parsed as url="${parsed.url}", description="${parsed.description ?? ''}". ` +
          `Prefer --server-url "${parsed.url}" --server-description "${parsed.description ?? ''}".\n`,
      );
    }
    servers.push(
      parsed.description !== undefined
        ? { url: parsed.url, description: parsed.description }
        : { url: parsed.url },
    );
  }
  if (opts.serverUrl !== undefined) {
    servers.push(
      opts.serverDescription !== undefined
        ? { url: opts.serverUrl, description: opts.serverDescription }
        : { url: opts.serverUrl },
    );
  } else if (opts.serverDescription !== undefined) {
    throw new Error('--server-description requires --server-url (it describes that URL)');
  }
  if (servers.length > 0) spec.servers = servers;
  if (opts.securityScheme.length > 0) {
    const schemes: Record<string, Record<string, unknown>> = {};
    for (const entry of opts.securityScheme) {
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
    spec.security = opts.globalSecurity.map((s) => ({ [s]: [] }));
  }
  if (opts.naming !== undefined) {
    if (opts.naming !== 'camelCase' && opts.naming !== 'snake_case') {
      throw new Error(`--naming must be "camelCase" or "snake_case" (got "${opts.naming}")`);
    }
    spec['x-brackish'] = { naming: opts.naming };
  }
  return ConventionSpecSchema.parse(spec);
}
