// Schema (JSON Schema component) command group: propose/list/show/accept (variadic)/reject/withdraw/diff/lint.

import type { Command } from 'commander';
import { stringify as yamlStringify } from 'yaml';
import { acceptSchemas } from '../client/batch.js';
import { lintSchemaSpec } from '../lib/lint.js';
import { type JSONSchema, JSONSchemaSchema } from '../lib/models.js';
import { loadSpecFile, parseSpecFile } from '../lib/specfile.js';
import { describeSchema, formatSchemaSummaries } from '../render/output.js';
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

export function register(program: Command): void {
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
          if (opts.file) {
            const ignored: string[] = [];
            if (opts.field.length > 0) ignored.push('--field');
            if (opts.description !== undefined) ignored.push('--description');
            warnFileClobbers(opts.file, ignored);
          }
          const spec = opts.file
            ? loadSpecFile(opts.file, JSONSchemaSchema)
            : buildSchemaSpec(opts);
          const v = await client.proposeSchema(doc, name, spec, parseConcurrencyOpts(opts));
          if (opts.json) emitJson(v);
          else
            emit(
              `proposed ${describeSchema(v)}\n  → peer's inbox will pick it up; \`brackish send ${doc} "<why>"\` if the diff isn't self-explanatory`,
            );
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
            !opts.proposed && opts.version === undefined
              ? () => client.getSchema(doc, name, { proposed: true })
              : undefined,
          );
          if (opts.json) emitJson(v);
          else if (opts.full) emit(`${describeSchema(v)}\n${yamlStringify(v.spec).trimEnd()}`);
          else emit(describeSchema(v));
        }),
    );

  schema
    .command('accept <doc> <name...>')
    .description(
      'accept the latest proposed version of one or more schemas. Stops on first failure; remaining names are left unaccepted.',
    )
    .option('--version <n>', 'pin a specific version (only valid with a single name)')
    .option('--json')
    .action(async (doc: string, names: string[], opts: { version?: string; json?: boolean }) =>
      withClient(async (client) => {
        if (names.length === 0) errExit(2, 'schema accept: at least one name required');
        if (opts.version !== undefined && names.length !== 1) {
          errExit(
            2,
            '--version requires exactly one name (different schemas have different version chains)',
          );
        }
        const versionN = opts.version !== undefined ? Number.parseInt(opts.version, 10) : undefined;

        // Single-name form preserves the existing text/JSON shape.
        if (names.length === 1) {
          const n = names[0];
          if (n === undefined) errExit(2, 'schema accept: empty name');
          const v = await client.acceptSchema(doc, n, versionN);
          if (opts.json) emitJson(v);
          else emit(`accepted ${describeSchema(v)}`);
          return;
        }

        const result = await acceptSchemas(client, doc, names);
        if (opts.json) {
          emitJson(result);
          if (result.failed) process.exit(1);
          return;
        }
        for (const v of result.accepted) emit(`accepted ${describeSchema(v)}`);
        if (result.failed) {
          process.stderr.write(
            `error at "${result.failed.name}": ${result.failed.code ?? 'error'} (${result.failed.message})\n` +
              (result.remaining.length > 0
                ? `remaining (unaccepted): ${result.remaining.join(', ')}\n`
                : ''),
          );
          process.exit(1);
        }
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
          else
            emit(
              `rejected ${describeSchema(v)}\n  → peer sees the reason in their inbox; expect a counter-proposal (or propose your own alternative now with --expected-version ${v.version})`,
            );
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

  schema
    .command('lint <name> <file>')
    .description(
      'check a YAML/JSON Schema file locally before proposing: parse errors with line/col, structural validation, $ref shape',
    )
    .option('--json', 'output JSON')
    .option('--strict', 'treat warnings as errors (exit 1 on warnings)')
    .action(async (name: string, file: string, opts: { json?: boolean; strict?: boolean }) => {
      finalizeLint(parseSpecFile(file), (data) => lintSchemaSpec(name, data), opts);
    });
}

// --- spec builders (private) ---

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
