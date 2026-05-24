// `brackish validate <doc>` — a read-only dry run. Asks the server to assemble the doc (with an
// optional manifest overlaid) and meta-schema-validate it, writing nothing. Exists so a caller
// can answer "is this valid / would this batch land?" without proposing things to find out.

import type { Command } from 'commander';
import { type BatchProposeFailure, validateFromManifest } from '../client/batch.js';
import type { SpecIssue } from '../client/client.js';
import { describeArtifactKey } from './batch.js';
import { emit, emitJson, withClient } from './common.js';

export function register(program: Command): void {
  program
    .command('validate <doc>')
    .description(
      'dry-run: check that the doc assembles into a valid OpenAPI 3.1 spec — writes nothing. With --manifest, previews proposing that whole set together (same atomic assembly as propose-batch).',
    )
    .option(
      '--manifest <file>',
      'overlay this manifest of artifacts (convention/schemas/endpoints) and validate as if they were all proposed together',
    )
    .option('--json')
    .action(async (doc: string, opts: { manifest?: string; json?: boolean }) =>
      withClient(async (client) => {
        if (opts.manifest !== undefined) {
          const result = await validateFromManifest(client, doc, opts.manifest);
          if (!result.ok) {
            if (opts.json) {
              emitJson({ valid: false, preflightFailure: result.failed });
            } else {
              emitManifestPreflightFailure(result.failed);
            }
            process.exit(1);
          }
          if (opts.json) {
            emitJson({ valid: result.valid, view: result.view, issues: result.issues });
          } else {
            presentValidate(
              result.valid,
              result.view,
              result.issues,
              `proposing these ${result.itemCount} artifact(s) together`,
              'run `brackish propose-batch` to commit them atomically',
            );
          }
          if (!result.valid) process.exit(1);
          return;
        }

        const res = await client.validate(doc);
        if (opts.json) {
          emitJson(res);
        } else {
          presentValidate(res.valid, res.view, res.issues, 'the current accepted doc', null);
        }
        if (!res.valid) process.exit(1);
      }),
    );
}

function presentValidate(
  valid: boolean,
  view: 'accepted' | 'wide',
  issues: SpecIssue[],
  subject: string,
  validHint: string | null,
): void {
  if (valid) {
    emit(`valid — ${subject} assembles cleanly (${view} view). Dry run: nothing was written.`);
    if (validHint) emit(`  → ${validHint}`);
    return;
  }
  emit(`invalid — ${subject} would not assemble (${view} view). Dry run: nothing was written.`);
  for (const issue of issues) {
    emit(`  ${issue.severity === 'error' ? 'error' : 'warn '}  ${issue.field}: ${issue.message}`);
  }
}

/** Local pre-flight (manifest load / parse / lint) failed before reaching the server. */
function emitManifestPreflightFailure(f: BatchProposeFailure): void {
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
    lines.push(`validation could not run: ${f.message}`);
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}
