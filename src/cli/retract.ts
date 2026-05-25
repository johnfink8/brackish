// `brackish retract …` — NEGOTIATED removal of accepted artifacts. `retract propose` opens a
// grouped retraction (a coordinated set of removals); the PEER accepts it (the set is tombstoned,
// validated fully-valid-after) or rejects it. Symmetric with propose/accept — nothing leaves the
// shared contract unilaterally. The artifacts stay live until the retraction is accepted.

import type { Command } from 'commander';
import {
  HttpMethodSchema,
  PathSchema,
  type Retraction,
  type RetractionTarget,
  type RetractRequest,
  SchemaNameSchema,
} from '../lib/models.js';
import { collect, emit, emitJson, errExit, resolveRejectReason, withClient } from './common.js';

export function register(program: Command): void {
  const retract = program
    .command('retract')
    .description('negotiated removal of accepted artifacts (propose → peer accepts/rejects)');

  retract
    .command('propose <doc>')
    .description(
      'propose removing a coordinated set of accepted artifacts. The peer accepts (set is removed) or rejects. To escape a wedged doc, name the whole invalid set so the post-removal doc is valid.',
    )
    .option(
      '--endpoint <"METHOD /path">',
      'endpoint to remove, e.g. "GET /events" (repeatable)',
      collect,
      [],
    )
    .option('--schema <name>', 'schema to remove (repeatable)', collect, [])
    .option('--convention', 'remove the convention')
    .option('--reason <text>', 'why — rides on the retraction for the peer')
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
            errExit(2, 'retract propose: name at least one --endpoint, --schema, or --convention');
          }
          const { retraction } = await client.proposeRetraction(doc, body);
          if (opts.json) return emitJson(retraction);
          emit(
            `proposed retraction #${retraction.id} — remove ${retraction.targets.map(describeTarget).join(', ')}`,
          );
          emit(
            `  → the peer accepts/rejects it: \`brackish retract accept ${doc} ${retraction.id}\` / \`reject\``,
          );
        }),
    );

  retract
    .command('list <doc>')
    .description('list retractions (default: only those awaiting action)')
    .option('--all', 'include accepted/rejected/withdrawn, not just proposed')
    .option('--json')
    .action(async (doc: string, opts: { all?: boolean; json?: boolean }) =>
      withClient(async (client) => {
        const res = await client.listRetractions(doc, opts.all ? {} : { status: 'proposed' });
        if (opts.json) return emitJson(res);
        if (res.retractions.length === 0) {
          emit(opts.all ? '(no retractions)' : '(no pending retractions)');
          return;
        }
        for (const r of res.retractions) emit(formatRetraction(r));
      }),
    );

  retract
    .command('accept <doc> <id>')
    .description(
      'accept a proposed retraction — removes the set (peer-only; validated fully-valid-after)',
    )
    .option('--json')
    .action(async (doc: string, idRaw: string, opts: { json?: boolean }) =>
      withClient(async (client) => {
        const { retraction } = await client.acceptRetraction(doc, parseId(idRaw));
        if (opts.json) return emitJson(retraction);
        emit(
          `accepted retraction #${retraction.id} — removed ${retraction.targets.map(describeTarget).join(', ')}`,
        );
      }),
    );

  retract
    .command('reject <doc> <id> [reason]')
    .description('reject a proposed retraction — the artifacts stay (peer-only)')
    .option('--rationale <text>', 'reason (alias for the positional)')
    .option('--json')
    .action(
      async (
        doc: string,
        idRaw: string,
        reasonArg: string | undefined,
        opts: { rationale?: string; json?: boolean },
      ) =>
        withClient(async (client) => {
          const reason = resolveRejectReason(reasonArg, opts.rationale);
          const { retraction } = await client.rejectRetraction(doc, parseId(idRaw), reason);
          if (opts.json) return emitJson(retraction);
          emit(`rejected retraction #${retraction.id} — artifacts kept`);
        }),
    );

  retract
    .command('withdraw <doc> <id>')
    .description('withdraw your own proposed retraction')
    .option('--json')
    .action(async (doc: string, idRaw: string, opts: { json?: boolean }) =>
      withClient(async (client) => {
        const { retraction } = await client.withdrawRetraction(doc, parseId(idRaw));
        if (opts.json) return emitJson(retraction);
        emit(`withdrew retraction #${retraction.id}`);
      }),
    );
}

function parseId(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) errExit(2, `invalid retraction id: ${raw}`);
  return n;
}

function parseEndpointToken(tok: string) {
  const m = tok.trim().match(/^(\S+)\s+(\S+)$/);
  if (!m || m[1] === undefined || m[2] === undefined) {
    errExit(2, `--endpoint must be "METHOD /path" (e.g. "GET /events"), got: ${tok}`);
  }
  return { method: HttpMethodSchema.parse(m[1].toLowerCase()), path: PathSchema.parse(m[2]) };
}

function describeTarget(t: RetractionTarget): string {
  if (t.kind === 'endpoint') return `${t.method.toUpperCase()} ${t.path}`;
  if (t.kind === 'schema') return `schema ${t.name}`;
  return 'convention';
}

function formatRetraction(r: Retraction): string {
  const what = r.targets.map(describeTarget).join(', ');
  const reason = r.reason ? ` — "${r.reason}"` : '';
  return `#${r.id}  [${r.status}]  by ${r.proposedBy}  remove ${what}${reason}`;
}
