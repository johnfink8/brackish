// Batch propose-from-manifest: a thin presentation layer over src/batch.ts.

import type { Command } from 'commander';
import {
  type ArtifactKey,
  type BatchProposeResult,
  type BatchProposeSuccess,
  proposeBatchFromManifest,
} from '../batch.js';
import { emit, emitJson, withClient } from './common.js';

export function register(program: Command): void {
  program
    .command('propose-batch <doc>')
    .description(
      'propose every artifact in a YAML/JSON manifest (convention → schemas → endpoints). Each artifact is parsed + linted locally before sending; stops on first failure with what-succeeded + what-remains.',
    )
    .requiredOption(
      '--manifest <file>',
      'manifest path (see `brackish propose-batch --help-format`)',
    )
    .option('--lint-only', "lint and parse every artifact, but don't send any proposes")
    .option('--json')
    .action(async (doc: string, opts: { manifest: string; lintOnly?: boolean; json?: boolean }) =>
      withClient(async (client) => {
        const result = await proposeBatchFromManifest(client, doc, opts.manifest, {
          ...(opts.lintOnly ? { lintOnly: true } : {}),
        });
        if (opts.json) {
          emitJson(result);
          if (result.failed) process.exit(1);
          return;
        }
        for (const s of result.succeeded) {
          const where = describeArtifactKey(s.key);
          const vTag = opts.lintOnly ? '(lint-only)' : `v${s.version}`;
          emit(`${opts.lintOnly ? 'linted  ' : 'proposed'} ${where.padEnd(40)} ${vTag}`);
        }
        if (result.failed) {
          emitProposeBatchFailure(result);
          process.exit(1);
        } else {
          const counts = countSucceededByKind(result.succeeded);
          const verb = opts.lintOnly ? 'linted' : 'proposed';
          emit(
            `${verb}: ${counts.convention} convention, ${counts.schemas} schemas, ${counts.endpoints} endpoints`,
          );
        }
      }),
    );
}

function describeArtifactKey(key: ArtifactKey): string {
  if (key.kind === 'convention') return 'convention';
  if (key.kind === 'schema') return `schema ${key.name}`;
  return `endpoint ${key.method.toUpperCase()} ${key.path}`;
}

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
    lines.push(
      `propose failed for ${describeArtifactKey(f.key)} (${f.file}): ${f.code ?? 'error'} (${f.message})`,
    );
  }
  if (result.remaining.length > 0) {
    lines.push(
      `remaining (not attempted): ${result.remaining.map(describeArtifactKey).join(', ')}`,
    );
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}
