// Read a trial's SQLite db and emit a demo-data JSON file replayable by `brackish demo`.
//
// Usage (standalone):
//   npx tsx harness/extract-demo.ts <trial-dir> <out-path>
// Usage (from run-trial.ts): see exported `extractDemoFromTrial`.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { z } from 'zod';

import { type DemoData, DemoDataSchema } from '../src/lib/demo-data.js';
import { parseOperationIdentityKey } from '../src/lib/models.js';

// Raw event-data shapes from the daemon — only the fields this extractor needs.
const DocumentCreatedDataSchema = z.object({ by: z.string() });
const MessageDataSchema = z.object({ from: z.string(), text: z.string() });
const ArtifactRefSchema = z.object({
  from: z.string(),
  artifactKind: z.enum(['convention', 'schema', 'operation']),
  identityKey: z.string(),
  version: z.number().int().positive(),
});
const ArtifactRejectedDataSchema = ArtifactRefSchema.extend({ reason: z.string() });
const ArtifactAcceptedDataSchema = ArtifactRefSchema.extend({ reason: z.string().optional() });

type DocumentRow = { name: string };
type EventRow = { id: number; kind: string; created_at: string; data: string };
type ArtifactRow = { spec: string };
type RawMove = Record<string, unknown>;

export function extractDemoFromTrial(trialDir: string): DemoData {
  const dbPath = join(trialDir, 'brackish-home', 'brackish.db');
  const db = new Database(dbPath, { readonly: true });
  try {
    const docRow = db.prepare<[], DocumentRow>('select name from documents limit 1').get();
    if (!docRow) throw new Error(`no documents found in ${dbPath}`);
    const document = docRow.name;

    const events = db
      .prepare<[string], EventRow>(
        'select id, kind, created_at, data from events where document_name = ? order by id',
      )
      .all(document);

    const getSpec = db.prepare<[string, string, string, number], ArtifactRow>(
      'select spec from artifact_versions where document_name = ? and kind = ? and identity_key = ? and version = ?',
    );

    const moves: RawMove[] = [];
    for (const ev of events) {
      const data: unknown = JSON.parse(ev.data);
      const at = ev.created_at;
      switch (ev.kind) {
        case 'document_created': {
          const d = DocumentCreatedDataSchema.parse(data);
          moves.push({ t: 'create_document', actor: d.by, at, doc: document });
          break;
        }
        case 'message': {
          const d = MessageDataSchema.parse(data);
          moves.push({ t: 'message', actor: d.from, at, text: d.text });
          break;
        }
        case 'artifact_proposed': {
          const d = ArtifactRefSchema.parse(data);
          const row = getSpec.get(document, d.artifactKind, d.identityKey, d.version);
          if (!row) {
            throw new Error(
              `propose event ${ev.id} references missing artifact_version: ${d.artifactKind} ${d.identityKey} v${d.version}`,
            );
          }
          const spec: unknown = JSON.parse(row.spec);
          moves.push(buildProposeMove(d.from, at, d.artifactKind, d.identityKey, spec));
          break;
        }
        case 'artifact_accepted': {
          const d = ArtifactAcceptedDataSchema.parse(data);
          moves.push(buildAcceptMove(d.from, at, d.artifactKind, d.identityKey, d.reason));
          break;
        }
        case 'artifact_rejected': {
          const d = ArtifactRejectedDataSchema.parse(data);
          moves.push(buildRejectMove(d.from, at, d.artifactKind, d.identityKey, d.reason));
          break;
        }
        case 'artifact_withdrawn':
          // The seed doesn't replay withdraws yet — no trial has produced one to test against.
          // Surface loudly so a future trial that hits this gets a real signal.
          throw new Error(
            `extract-demo: unsupported event kind 'artifact_withdrawn' (event ${ev.id})`,
          );
        default:
          throw new Error(`extract-demo: unknown event kind '${ev.kind}' (event ${ev.id})`);
      }
    }

    // Parse-at-boundary: every move flows through DemoMoveSchema, which validates each spec
    // against ConventionSpecSchema/JSONSchemaSchema/OperationSpecSchema in turn.
    return DemoDataSchema.parse({ document, moves });
  } finally {
    db.close();
  }
}

function buildProposeMove(
  actor: string,
  at: string,
  kind: 'convention' | 'schema' | 'operation',
  identityKey: string,
  spec: unknown,
): RawMove {
  if (kind === 'convention') return { t: 'propose_convention', actor, at, spec };
  if (kind === 'schema') return { t: 'propose_schema', actor, at, name: identityKey, spec };
  const { method, path } = parseOperationIdentityKey(identityKey);
  return { t: 'propose_endpoint', actor, at, method, path, spec };
}

function buildAcceptMove(
  actor: string,
  at: string,
  kind: 'convention' | 'schema' | 'operation',
  identityKey: string,
  reason: string | undefined,
): RawMove {
  const reasonPart = reason !== undefined ? { reason } : {};
  if (kind === 'convention') return { t: 'accept_convention', actor, at, ...reasonPart };
  if (kind === 'schema') return { t: 'accept_schema', actor, at, name: identityKey, ...reasonPart };
  const { method, path } = parseOperationIdentityKey(identityKey);
  return { t: 'accept_endpoint', actor, at, method, path, ...reasonPart };
}

function buildRejectMove(
  actor: string,
  at: string,
  kind: 'convention' | 'schema' | 'operation',
  identityKey: string,
  reason: string,
): RawMove {
  if (kind === 'convention') return { t: 'reject_convention', actor, at, reason };
  if (kind === 'schema') return { t: 'reject_schema', actor, at, name: identityKey, reason };
  const { method, path } = parseOperationIdentityKey(identityKey);
  return { t: 'reject_endpoint', actor, at, method, path, reason };
}

export function writeDemoDataFile(data: DemoData, outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(data, null, 2)}\n`);
  // biome's JSON formatter collapses single-element arrays etc.; running it here keeps
  // the file lint-clean across regenerations. Best-effort: skip if biome isn't installed.
  spawnSync('npx', ['biome', 'format', '--write', outPath], { stdio: 'ignore' });
}

// Standalone CLI entry. Only fires when the file is invoked directly (e.g. `tsx
// harness/extract-demo.ts <trial> <out>`); `run-trial.ts` imports the function instead.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  if (process.argv.length < 4) {
    process.stderr.write('usage: tsx harness/extract-demo.ts <trial-dir> <out-path>\n');
    process.exit(2);
  }
  const trialDir = resolve(process.argv[2] ?? '');
  const outPath = resolve(process.argv[3] ?? '');
  const data = extractDemoFromTrial(trialDir);
  writeDemoDataFile(data, outPath);
  process.stderr.write(
    `extract-demo: wrote ${data.moves.length} moves for doc '${data.document}' → ${outPath}\n`,
  );
}
