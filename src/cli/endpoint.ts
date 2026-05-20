// Endpoint (OpenAPI Operation) command group: propose/list/show/accept/reject/withdraw/diff/lint.

import type { Command } from 'commander';
import { stringify as yamlStringify } from 'yaml';
import { acceptEndpoints, type EndpointTarget } from '../client/batch.js';
import { lintEndpointSpec } from '../lib/lint.js';
import {
  type ConventionArtifact,
  HttpMethodSchema,
  type JSONSchema,
  JSONSchemaSchema,
  type OperationSpec,
  OperationSpecSchema,
} from '../lib/models.js';
import { loadSpecFile, parseSpecFile } from '../lib/specfile.js';
import { describeOperation, formatEndpointSummaries } from '../render/output.js';
import {
  type ConcurrencyOpts,
  collect,
  emit,
  emitDiff,
  emitJson,
  emitRenderedDiff,
  errExit,
  fetchOrFallback,
  finalizeLint,
  parseConcurrencyOpts,
  warnFileClobbers,
  withClient,
} from './common.js';

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

export function register(program: Command): void {
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
      "explicitly opt out of doc-level `security`; emits `security: []` on the operation (the OpenAPI spelling for 'no auth required')",
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
        // Best-effort: a missing convention is fine (no inheritance, no error).
        const convention =
          opts.inheritSecurity === false
            ? null
            : await client.getConventionCurrent(doc).catch(() => null);
        if (opts.file) {
          const ignored: string[] = [];
          if (opts.summary !== undefined) ignored.push('--summary');
          if (opts.description !== undefined) ignored.push('--description');
          if (opts.requestContent.length > 0) ignored.push('--request-content');
          if (opts.response.length > 0) ignored.push('--response');
          if (opts.security.length > 0) ignored.push('--security');
          if (opts.inheritSecurity === false) ignored.push('--no-inherit-security');
          if (opts.idempotent) ignored.push('--idempotent');
          if (opts.sideEffect.length > 0) ignored.push('--side-effect');
          if (opts.timingP50 !== undefined) ignored.push('--timing-p50');
          if (opts.timingP99 !== undefined) ignored.push('--timing-p99');
          if (opts.timeout !== undefined) ignored.push('--timeout');
          warnFileClobbers(opts.file, ignored);
        }
        const spec = opts.file
          ? loadSpecFile(opts.file, OperationSpecSchema)
          : buildOperationSpec(opts, { path, convention });
        const v = await client.proposeEndpoint(doc, method, path, spec, parseConcurrencyOpts(opts));
        if (opts.json) emitJson(v);
        else
          emit(
            `proposed ${describeOperation(v)}\n  → peer's inbox will pick it up; \`brackish send ${doc} "<why>"\` if the diff isn't self-explanatory`,
          );
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
            !opts.proposed && opts.version === undefined
              ? () => client.getEndpoint(doc, method, path, { proposed: true })
              : undefined,
          );
          if (opts.json) emitJson(v);
          else if (opts.full) emit(`${describeOperation(v)}\n${yamlStringify(v.spec).trimEnd()}`);
          else emit(describeOperation(v));
        }),
    );

  endpoint
    .command('accept <doc> [method] [path]')
    .description(
      'accept one endpoint (positional <method> <path>) or many via repeated --target METHOD:PATH. Multi-target form stops on first failure with what-succeeded/remaining summary.',
    )
    .option('--version <n>', 'pin a specific version (only valid with a single target)')
    .option(
      '--target <method:path>',
      'METHOD:PATH endpoint identifier (repeatable for batch accept)',
      collect,
      [],
    )
    .option('--json')
    .action(
      async (
        doc: string,
        methodRaw: string | undefined,
        path: string | undefined,
        opts: { version?: string; target: string[]; json?: boolean },
      ) =>
        withClient(async (client) => {
          const usingTargets = opts.target.length > 0;
          const usingPositional = methodRaw !== undefined || path !== undefined;
          if (usingTargets && usingPositional) {
            errExit(2, 'endpoint accept: pass either <method> <path> OR --target, not both');
          }
          if (!usingTargets && (methodRaw === undefined || path === undefined)) {
            errExit(2, 'endpoint accept: provide <method> <path> or --target METHOD:PATH ...');
          }

          // Single-target form (positional) — preserves the existing text/JSON shape.
          if (usingPositional && methodRaw !== undefined && path !== undefined) {
            const method = HttpMethodSchema.parse(methodRaw.toLowerCase());
            const versionN =
              opts.version !== undefined ? Number.parseInt(opts.version, 10) : undefined;
            const v = await client.acceptEndpoint(doc, method, path, versionN);
            if (opts.json) emitJson(v);
            else emit(`accepted ${describeOperation(v)}`);
            return;
          }

          // Batch form: parse each --target into {method, path}.
          if (opts.version !== undefined) {
            errExit(
              2,
              '--version requires a single positional target (different endpoints have different version chains)',
            );
          }
          const targets: EndpointTarget[] = opts.target.map((raw) => {
            const colon = raw.indexOf(':');
            if (colon < 1) {
              errExit(2, `--target "${raw}": expected METHOD:PATH (e.g. GET:/users/{id})`);
            }
            const method = HttpMethodSchema.parse(raw.slice(0, colon).toLowerCase());
            return { method, path: raw.slice(colon + 1) };
          });

          // Single --target also preserves the old shape.
          if (targets.length === 1) {
            const t = targets[0];
            if (!t) errExit(2, 'endpoint accept: empty --target');
            const v = await client.acceptEndpoint(doc, t.method, t.path);
            if (opts.json) emitJson(v);
            else emit(`accepted ${describeOperation(v)}`);
            return;
          }

          const result = await acceptEndpoints(client, doc, targets);
          if (opts.json) {
            emitJson(result);
            if (result.failed) process.exit(1);
            return;
          }
          for (const v of result.accepted) emit(`accepted ${describeOperation(v)}`);
          if (result.failed) {
            const fmt = (t: EndpointTarget): string => `${t.method.toUpperCase()} ${t.path}`;
            process.stderr.write(
              `error at "${fmt(result.failed.target)}": ${result.failed.code ?? 'error'} (${result.failed.message})\n` +
                (result.remaining.length > 0
                  ? `remaining (unaccepted): ${result.remaining.map(fmt).join(', ')}\n`
                  : ''),
            );
            process.exit(1);
          }
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
          else
            emit(
              `rejected ${describeOperation(v)}\n  → peer sees the reason in their inbox; expect a counter-proposal (or propose your own alternative now with --expected-version ${v.version})`,
            );
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

  endpoint
    .command('lint <method> <path> <file>')
    .description(
      'check a YAML/JSON Operation file locally before proposing: parse errors with line/col, structural validation, path placeholders ↔ parameters consistency, $ref shape',
    )
    .option('--json', 'output JSON')
    .option('--strict', 'treat warnings as errors (exit 1 on warnings)')
    .action(
      async (
        methodRaw: string,
        path: string,
        file: string,
        opts: { json?: boolean; strict?: boolean },
      ) => {
        const method = HttpMethodSchema.parse(methodRaw.toLowerCase());
        finalizeLint(parseSpecFile(file), (data) => lintEndpointSpec(method, path, data), opts);
      },
    );
}

// --- spec builders (private to endpoint module) ---

function buildOperationSpec(
  opts: EndpointProposeOpts,
  ctx: { path: string; convention: ConventionArtifact | null },
): OperationSpec {
  const spec: Record<string, unknown> = {};
  if (opts.summary !== undefined) spec.summary = opts.summary;
  if (opts.description !== undefined) spec.description = opts.description;

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

  if (opts.requestContent.length > 0) {
    const content: Record<string, unknown> = {};
    for (const entry of opts.requestContent) {
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

  const responses: Record<string, unknown> = {};
  if (opts.response.length === 0) {
    responses['200'] = { description: 'OK' };
  } else {
    for (const entry of opts.response) {
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
  } else if (opts.inheritSecurity === false) {
    // Explicit opt-out. OpenAPI's spelling for "no auth required" is `security: []`.
    spec.security = [];
  } else if (ctx.convention) {
    const convSec = readConventionSecurity(ctx.convention);
    if (convSec.length > 0) spec.security = convSec;
  }

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

  return OperationSpecSchema.parse(spec);
}

function parseSchemaRefOrInline(s: string): JSONSchema {
  // Single capitalized token → $ref into components.schemas
  if (/^[A-Z][A-Za-z0-9_]*$/.test(s)) {
    return { $ref: `#/components/schemas/${s}` };
  }
  try {
    const parsed: unknown = JSON.parse(s);
    return JSONSchemaSchema.parse(parsed);
  } catch {
    return { type: s };
  }
}

/** Convention's top-level `security` lives in a passthrough field — extract without an `as`. */
function readConventionSecurity(c: ConventionArtifact): Array<Record<string, string[]>> {
  const spec = c.spec;
  if (typeof spec !== 'object' || spec === null) return [];
  if (!('security' in spec)) return [];
  const sec = spec.security;
  if (!Array.isArray(sec)) return [];
  const out: Array<Record<string, string[]>> = [];
  for (const entry of sec) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const normalized: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(entry)) {
        normalized[k] = Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
      }
      out.push(normalized);
    }
  }
  return out;
}
