// `brackish retract <doc>` — atomically remove accepted artifacts from the doc. The server
// validates that the doc still assembles after removal (no orphaned $ref) and commits
// all-or-nothing. Effective immediately; the peer sees the retract events. This is the escape
// hatch for a wedged doc: retract the whole invalid set in one call, then re-propose clean.

import type { Command } from 'commander';
import {
  HttpMethodSchema,
  PathSchema,
  type RetractRequest,
  SchemaNameSchema,
} from '../lib/models.js';
import { collect, emit, emitJson, errExit, withClient } from './common.js';

export function register(program: Command): void {
  program
    .command('retract <doc>')
    .description(
      'remove accepted artifacts (atomic, all-or-nothing). The doc must still be valid afterward — to escape a wedged doc, retract the whole invalid set together. Effective immediately; the peer sees it.',
    )
    .option(
      '--endpoint <"METHOD /path">',
      'endpoint to remove, e.g. "GET /events" (repeatable)',
      collect,
      [],
    )
    .option('--schema <name>', 'schema to remove (repeatable)', collect, [])
    .option('--convention', 'remove the convention')
    .option('--reason <text>', 'why — rides on the retract events for the peer')
    .option('--json')
    .action(
      async (
        doc: string,
        opts: {
          endpoint: string[];
          schema: string[];
          convention?: boolean;
          reason?: string;
          json?: boolean;
        },
      ) =>
        withClient(async (client) => {
          const body: RetractRequest = {};
          if (opts.endpoint.length > 0) body.endpoints = opts.endpoint.map(parseEndpointToken);
          if (opts.schema.length > 0)
            body.schemas = opts.schema.map((s) => SchemaNameSchema.parse(s));
          if (opts.convention) body.convention = true;
          if (opts.reason !== undefined) body.reason = opts.reason;
          if (
            body.endpoints === undefined &&
            body.schemas === undefined &&
            body.convention === undefined
          ) {
            errExit(2, 'retract: name at least one --endpoint, --schema, or --convention');
          }

          const res = await client.retract(doc, body);
          if (opts.json) {
            emitJson(res);
            return;
          }
          for (const r of res.retracted)
            emit(`retracted ${describeRetracted(r)} (tombstone v${r.version})`);
          emit(
            `removed ${res.retracted.length} artifact(s) — the peer will see the retract events.`,
          );
        }),
    );
}

function parseEndpointToken(tok: string) {
  const m = tok.trim().match(/^(\S+)\s+(\S+)$/);
  if (!m || m[1] === undefined || m[2] === undefined) {
    errExit(2, `--endpoint must be "METHOD /path" (e.g. "GET /events"), got: ${tok}`);
  }
  return { method: HttpMethodSchema.parse(m[1].toLowerCase()), path: PathSchema.parse(m[2]) };
}

function describeRetracted(
  r:
    | { kind: 'convention'; version: number }
    | { kind: 'schema'; name: string; version: number }
    | { kind: 'endpoint'; method: string; path: string; version: number },
): string {
  if (r.kind === 'convention') return 'convention';
  if (r.kind === 'schema') return `schema ${r.name}`;
  return `endpoint ${r.method.toUpperCase()} ${r.path}`;
}
