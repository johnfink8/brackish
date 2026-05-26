// `propose` — propose an artifact. Two shapes, both verb-first and doc-scoped (`--doc`, default sole):
//   • `propose <noun> --file f`  — one artifact, file-only (the noun parses its own spec schema).
//   • `propose --manifest m`     — a coordinated SET, atomically (configureParent, below). The server
//     assembles + validates the whole set and commits all-or-nothing, so mutual/forward refs resolve.
// The concurrency guard (`--expected-rev`/`--expected-new`/`--force`) rides the single form.

import {
  type BatchProposeResult,
  type BatchProposeSuccess,
  describeArtifactKey,
  proposeBatchFromManifest,
} from '../../../client/batch.js';
import { emit, emitJson, errExit, resolveDoc, withClient } from '../../common.js';
import { requireFile, requireSingle } from '../guards.js';
import { makeVerb } from '../make-verb.js';
import { concurrencyFromOpts } from '../options.js';
import type { Capability, VerbContext } from '../types.js';

export const proposeVerb = makeVerb({
  verb: 'propose',
  arity: 'one',
  summary: 'propose an artifact from a YAML/JSON spec file (--file)',
  options: ['file', 'expectedRev', 'expectedNew', 'force', 'json'],
  configureParent(parent) {
    // `propose` with no noun = manifest mode: propose a coordinated set atomically.
    parent
      .option(
        '--manifest <file>',
        'propose every artifact in a YAML/JSON manifest as one atomic set (convention → schemas → endpoints)',
      )
      .option('--lint-only', "parse + lint every artifact locally, but don't send any proposes")
      .option('--dry-run', 'synonym for --lint-only')
      .option('--json')
      .option(
        '--doc <name>',
        'document name (defaults to the only one; required when several exist)',
      )
      .action(
        async (opts: {
          manifest?: string;
          lintOnly?: boolean;
          dryRun?: boolean;
          json?: boolean;
          doc?: string;
        }) => {
          const manifest = opts.manifest;
          if (manifest === undefined) {
            errExit(
              2,
              'propose <noun> --file <f> for one artifact, or propose --manifest <f> for a coordinated set',
            );
          }
          const lintOnly = opts.lintOnly === true || opts.dryRun === true;
          await withClient(async (client) => {
            const doc = await resolveDoc(client, opts.doc);
            const result = await proposeBatchFromManifest(
              client,
              doc,
              manifest,
              lintOnly ? { lintOnly: true } : {},
            );
            if (opts.json === true) {
              emitJson(result);
              if (result.failed) errExit(1, '');
              return;
            }
            for (const s of result.succeeded) {
              const where = describeArtifactKey(s.key);
              const vTag = lintOnly ? '(lint-only)' : `v${s.version}`;
              emit(`${lintOnly ? 'linted  ' : 'proposed'} ${where.padEnd(40)} ${vTag}`);
            }
            if (result.failed) {
              emitProposeBatchFailure(result);
              errExit(1, '');
            } else {
              const counts = countSucceededByKind(result.succeeded);
              const verb = lintOnly ? 'linted' : 'proposed';
              emit(
                `${verb}: ${counts.convention} convention, ${counts.schemas} schemas, ${counts.endpoints} endpoints`,
              );
            }
          });
        },
      );
  },
  async handle<Id, V>(
    ctx: VerbContext<Id, V>,
    propose: Capability<'propose', Id, V>,
  ): Promise<void> {
    const { client, doc, descriptor, target, opts } = ctx;
    const id = requireSingle(target);
    const file = requireFile(opts.file);
    const v = await propose(client, doc, id, file, concurrencyFromOpts(opts));
    if (opts.json === true) emitJson(v);
    else
      emit(
        `proposed ${descriptor.render(v)}\n  → \`brackish send ${doc} "<why>"\` if the diff isn't self-explanatory`,
      );
  },
});

function countSucceededByKind(succeeded: BatchProposeSuccess[]): {
  convention: number;
  schemas: number;
  endpoints: number;
} {
  let convention = 0;
  let schemas = 0;
  let endpoints = 0;
  for (const s of succeeded) {
    if (s.key.kind === 'convention') convention++;
    else if (s.key.kind === 'schema') schemas++;
    else endpoints++;
  }
  return { convention, schemas, endpoints };
}

function emitProposeBatchFailure(result: BatchProposeResult): void {
  if (!result.failed) return;
  const f = result.failed;
  const lines: string[] = [];
  if (f.stage === 'manifest') {
    lines.push(`manifest error: ${f.message}`);
  } else if (f.stage === 'parse') {
    lines.push(`parse error in ${describeArtifactKey(f.key)} (${f.file}): ${f.message}`);
  } else if (f.stage === 'lint') {
    lines.push(`lint failed for ${describeArtifactKey(f.key)} (${f.file}):`);
    for (const issue of f.issues) {
      lines.push(
        `  ${issue.severity === 'error' ? 'error' : 'warn '}  ${issue.field}: ${issue.message}`,
      );
    }
  } else {
    // Atomic rejection: the whole batch was validated as one assembled doc and nothing was
    // written. Say so plainly so it's clear there's no partial state to clean up.
    lines.push(`batch rejected — nothing was written (${f.code ?? 'error'}): ${f.message}`);
    for (const issue of f.issues) {
      lines.push(
        `  ${issue.severity === 'error' ? 'error' : 'warn '}  ${issue.field}: ${issue.message}`,
      );
    }
    lines.push(
      'fix the spec(s) and re-run `brackish propose --manifest` — it commits all-or-nothing.',
    );
  }
  // `remaining` is meaningful only for the sequential local pre-flight (parse/lint); an atomic
  // batch rejection leaves nothing pending, so it carries an empty list.
  if (result.remaining.length > 0) {
    lines.push(
      `remaining (not attempted): ${result.remaining.map(describeArtifactKey).join(', ')}`,
    );
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}
