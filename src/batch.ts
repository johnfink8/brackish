// Client-side composition over single-artifact server routes: batch accept + batch propose-from-manifest.
//
// Both halves share the "stop on first failure, report what succeeded + what's left" semantics so
// the CLI presentation stays uniform.

import { type BrackishClient, ClientError, type ProposeOptionsWire } from './client.js';
import { type LintIssue, lintConventionSpec, lintEndpointSpec, lintSchemaSpec } from './lint.js';
import { type LoadedManifest, loadManifest, type ManifestExpected } from './manifest.js';
import {
  ConventionSpecSchema,
  type DocumentName,
  type HttpMethod,
  JSONSchemaSchema,
  OperationSpecSchema,
  type SchemaArtifact,
  type SchemaName,
} from './models.js';
import { parseSpecFile } from './specfile.js';

export type BatchAcceptResult = {
  accepted: SchemaArtifact[];
  failed: { name: string; code: string | null; message: string } | null;
  /** Names that were never attempted because an earlier accept failed. */
  remaining: string[];
};

/** Sequentially accept schemas in the given order. On the first failure, stop. */
export async function acceptSchemas(
  client: BrackishClient,
  document: DocumentName,
  names: SchemaName[],
): Promise<BatchAcceptResult> {
  const accepted: SchemaArtifact[] = [];
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (n === undefined) continue;
    try {
      const v = await client.acceptSchema(document, n);
      accepted.push(v);
    } catch (e) {
      const code = e instanceof ClientError ? e.code : null;
      const message = e instanceof Error ? e.message : String(e);
      return {
        accepted,
        failed: { name: n, code, message },
        remaining: names.slice(i + 1),
      };
    }
  }
  return { accepted, failed: null, remaining: [] };
}

// --- propose-batch -----------------------------------------------------------

export type ArtifactKey =
  | { kind: 'convention' }
  | { kind: 'schema'; name: string }
  | { kind: 'endpoint'; method: HttpMethod; path: string };

export type BatchProposeFailure =
  | { stage: 'manifest'; message: string }
  | { stage: 'parse'; key: ArtifactKey; file: string; message: string }
  | { stage: 'lint'; key: ArtifactKey; file: string; issues: LintIssue[] }
  | { stage: 'propose'; key: ArtifactKey; file: string; code: string | null; message: string };

export type BatchProposeSuccess = {
  key: ArtifactKey;
  file: string;
  version: number;
};

export type BatchProposeResult = {
  succeeded: BatchProposeSuccess[];
  failed: BatchProposeFailure | null;
  remaining: ArtifactKey[];
};

export type ProposeBatchOptions = { lintOnly?: boolean };

function expectedToWire(e: ManifestExpected): ProposeOptionsWire {
  if (e === 'new') return { expectedVersion: 'new' };
  if (e === 'force') return { force: true };
  return { expectedVersion: e };
}

/** Plan an execution order: convention first, then schemas, then endpoints. */
function planArtifacts(manifest: LoadedManifest): Array<{
  key: ArtifactKey;
  file: string;
  expected: ManifestExpected;
}> {
  const plan: Array<{ key: ArtifactKey; file: string; expected: ManifestExpected }> = [];
  if (manifest.convention) {
    plan.push({
      key: { kind: 'convention' },
      file: manifest.convention.file,
      expected: manifest.convention.expected,
    });
  }
  for (const s of manifest.schemas) {
    plan.push({ key: { kind: 'schema', name: s.name }, file: s.file, expected: s.expected });
  }
  for (const e of manifest.endpoints) {
    plan.push({
      key: { kind: 'endpoint', method: e.method, path: e.path },
      file: e.file,
      expected: e.expected,
    });
  }
  return plan;
}

/** Load + lint + propose every artifact in a manifest. Stop on first failure. Pure orchestration:
 *  parse/lint/propose are the existing primitives. */
export async function proposeBatchFromManifest(
  client: BrackishClient,
  document: DocumentName,
  manifestPath: string,
  opts: ProposeBatchOptions = {},
): Promise<BatchProposeResult> {
  const loaded = loadManifest(manifestPath);
  if (!loaded.ok) {
    return { succeeded: [], failed: { stage: 'manifest', message: loaded.message }, remaining: [] };
  }
  const plan = planArtifacts(loaded.manifest);
  const succeeded: BatchProposeSuccess[] = [];

  for (let i = 0; i < plan.length; i++) {
    const item = plan[i];
    if (!item) continue;
    const remaining = plan.slice(i + 1).map((p) => p.key);

    const parsed = parseSpecFile(item.file);
    if (!parsed.ok) {
      return {
        succeeded,
        failed: { stage: 'parse', key: item.key, file: item.file, message: parsed.message },
        remaining,
      };
    }

    const lintResult = runLintFor(item.key, parsed.data);
    if (lintResult.errors.length > 0) {
      return {
        succeeded,
        failed: { stage: 'lint', key: item.key, file: item.file, issues: lintResult.errors },
        remaining,
      };
    }

    if (opts.lintOnly) {
      succeeded.push({ key: item.key, file: item.file, version: 0 });
      continue;
    }

    const proposeOpts = expectedToWire(item.expected);
    try {
      const version = await proposeFor(client, document, item.key, parsed.data, proposeOpts);
      succeeded.push({ key: item.key, file: item.file, version });
    } catch (e) {
      const code = e instanceof ClientError ? e.code : null;
      const message = e instanceof Error ? e.message : String(e);
      return {
        succeeded,
        failed: { stage: 'propose', key: item.key, file: item.file, code, message },
        remaining,
      };
    }
  }
  return { succeeded, failed: null, remaining: [] };
}

function runLintFor(
  key: ArtifactKey,
  data: unknown,
): { errors: LintIssue[]; warnings: LintIssue[] } {
  if (key.kind === 'convention') return lintConventionSpec(data);
  if (key.kind === 'schema') return lintSchemaSpec(key.name, data);
  return lintEndpointSpec(key.method, key.path, data);
}

async function proposeFor(
  client: BrackishClient,
  doc: DocumentName,
  key: ArtifactKey,
  data: unknown,
  proposeOpts: ProposeOptionsWire,
): Promise<number> {
  // Re-parse against the zod schema to narrow `unknown` → typed without an `as` cast. Lint
  // already validated this; the re-parse is microseconds and keeps the types honest.
  if (key.kind === 'convention') {
    const spec = ConventionSpecSchema.parse(data);
    const v = await client.proposeConvention(doc, spec, proposeOpts);
    return v.version;
  }
  if (key.kind === 'schema') {
    const spec = JSONSchemaSchema.parse(data);
    const v = await client.proposeSchema(doc, key.name, spec, proposeOpts);
    return v.version;
  }
  const spec = OperationSpecSchema.parse(data);
  const v = await client.proposeEndpoint(doc, key.method, key.path, spec, proposeOpts);
  return v.version;
}
