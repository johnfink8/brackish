// `propose retraction` — open a negotiated removal of a coordinated set of accepted artifacts. The
// peer accepts (the set is tombstoned, validated still-valid) or rejects. Unlike the other nouns'
// `propose` (file-based, single artifact), a retraction's content IS its target set, named by the
// unambiguous --endpoint/--schema/--convention flags. So it's a hand-written VerbRegistrar gated on
// the retraction noun, registering under the same `propose` parent as the file-based verb.

import type { Command } from 'commander';
import { z } from 'zod';
import {
  HttpMethodSchema,
  PathSchema,
  type RetractionTarget,
  type RetractRequest,
  SchemaNameSchema,
} from '../../../lib/models.js';
import { collect, emit, emitJson, errExit, resolveDoc, withClient } from '../../common.js';
import type { VerbRegistrar } from '../make-verb.js';
import { applyOptions, parseStandardOpts } from '../options.js';
import type { NounDescriptor } from '../types.js';

const TargetOptsSchema = z.object({
  endpoint: z.array(z.string()).default([]),
  schema: z.array(z.string()).default([]),
  convention: z.boolean().optional(),
});

function parseEndpointToken(tok: string): {
  method: ReturnType<typeof HttpMethodSchema.parse>;
  path: string;
} {
  const m = tok.trim().match(/^(\S+)\s+(\S+)$/);
  if (!m || m[1] === undefined || m[2] === undefined) {
    errExit(2, `--endpoint must be "METHOD /path" (e.g. "GET /events"), got: ${tok}`);
  }
  return { method: HttpMethodSchema.parse(m[1].toLowerCase()), path: PathSchema.parse(m[2]) };
}

function describeTargets(targets: readonly RetractionTarget[]): string {
  return targets
    .map((t) =>
      t.kind === 'endpoint'
        ? `${t.method.toUpperCase()} ${t.path}`
        : t.kind === 'schema'
          ? `schema ${t.name}`
          : 'convention',
    )
    .join(', ');
}

export const proposeRetractionVerb: VerbRegistrar = <Id, V>(
  program: Command,
  verbCommands: Map<string, Command>,
  d: NounDescriptor<Id, V>,
) => {
  if (d.noun !== 'retraction') return;
  let parent = verbCommands.get('propose');
  if (parent === undefined) {
    parent = program.command('propose').description('propose an artifact');
    verbCommands.set('propose', parent);
  }
  const leaf = parent
    .command('retraction')
    .description('propose removing a coordinated set of accepted artifacts (peer accepts/rejects)');
  leaf.option(
    '--endpoint <"METHOD /path">',
    'endpoint to remove, e.g. "GET /events" (repeatable)',
    collect,
    [],
  );
  leaf.option('--schema <name>', 'schema to remove (repeatable)', collect, []);
  leaf.option('--convention', 'remove the convention');
  applyOptions(leaf, ['rationale', 'doc', 'json']);
  leaf.action(async () => {
    const opts = parseStandardOpts(leaf.opts());
    const targets = TargetOptsSchema.parse(leaf.opts());
    const body: RetractRequest = {};
    if (targets.endpoint.length > 0) body.endpoints = targets.endpoint.map(parseEndpointToken);
    if (targets.schema.length > 0)
      body.schemas = targets.schema.map((s) => SchemaNameSchema.parse(s));
    if (targets.convention === true) body.convention = true;
    if (opts.rationale !== undefined) body.reason = opts.rationale;
    if (
      body.endpoints === undefined &&
      body.schemas === undefined &&
      body.convention === undefined
    ) {
      errExit(2, 'propose retraction: name at least one --endpoint, --schema, or --convention');
    }
    await withClient(async (client) => {
      const doc = await resolveDoc(client, opts.doc);
      const { retraction } = await client.proposeRetraction(doc, body);
      if (opts.json === true) {
        emitJson(retraction);
        return;
      }
      emit(`proposed retraction #${retraction.id} — remove ${describeTargets(retraction.targets)}`);
      emit(
        `  → the peer accepts/rejects it: \`brackish accept retraction ${retraction.id}\` / \`reject retraction ${retraction.id}\``,
      );
    });
  });
};
