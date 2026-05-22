// Client-side composition over single-artifact server routes: batch accept + batch propose-from-manifest.
//
// Both halves share the "stop on first failure, report what succeeded + what's left" semantics so
// the CLI presentation stays uniform.

import {
  type LintIssue,
  lintConventionSpec,
  lintEndpointSpec,
  lintSchemaSpec,
} from '../lib/lint.js';
import {
  type BatchItemOptions,
  ConventionSpecSchema,
  type DocumentName,
  type HttpMethod,
  JSONSchemaSchema,
  type OperationArtifact,
  OperationSpecSchema,
  type ProposeBatchRequest,
  type SchemaArtifact,
  type SchemaName,
} from '../lib/models.js';
import { parseSpecFile } from '../lib/specfile.js';
import { type BrackishClient, ClientError } from './client.js';
import { type LoadedManifest, loadManifest, type ManifestExpected } from './manifest.js';

export type BatchAcceptResult = {
  accepted: SchemaArtifact[];
  failed: { name: string; code: string | null; message: string } | null;
  /** Names that were never attempted because an earlier accept failed. */
  remaining: string[];
};

/** Sequentially accept schemas in the given order. On the first failure, stop.
 *  When `reason` is passed, it's attached to each accept event in the batch. */
export async function acceptSchemas(
  client: BrackishClient,
  document: DocumentName,
  names: SchemaName[],
  reason?: string,
): Promise<BatchAcceptResult> {
  const accepted: SchemaArtifact[] = [];
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (n === undefined) continue;
    try {
      const v = await client.acceptSchema(document, n, undefined, reason);
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

export type EndpointTarget = { method: HttpMethod; path: string };

export type EndpointBatchAcceptResult = {
  accepted: OperationArtifact[];
  failed: { target: EndpointTarget; code: string | null; message: string } | null;
  /** Targets that were never attempted because an earlier accept failed. */
  remaining: EndpointTarget[];
};

/** Sequentially accept endpoints in the given order. On the first failure, stop. Mirrors
 *  `acceptSchemas`; the only structural difference is `(method, path)` per target. */
export async function acceptEndpoints(
  client: BrackishClient,
  document: DocumentName,
  targets: EndpointTarget[],
  reason?: string,
): Promise<EndpointBatchAcceptResult> {
  const accepted: OperationArtifact[] = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (t === undefined) continue;
    try {
      const v = await client.acceptEndpoint(document, t.method, t.path, undefined, reason);
      accepted.push(v);
    } catch (e) {
      const code = e instanceof ClientError ? e.code : null;
      const message = e instanceof Error ? e.message : String(e);
      return {
        accepted,
        failed: { target: t, code, message },
        remaining: targets.slice(i + 1),
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

/** Load + lint + propose every artifact in a manifest. Submits the whole batch as a single
 *  atomic request to /documents/:name/propose-batch, which assembles all items into the
 *  projected wide doc and validates once — so forward and mutual refs work without manifest
 *  ordering tricks. The server commits all-or-nothing on validation. */
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

  // Local pre-flight: parse every file + run brackish-side lint (zod + cross-field checks).
  // The deep meta-schema validation runs on the server, but we still catch parse errors and
  // brackish-specific structural issues here without a round-trip.
  const parsedItems: Array<{
    key: ArtifactKey;
    file: string;
    expected: ManifestExpected;
    data: unknown;
  }> = [];
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i];
    if (!item) continue;
    const remaining = plan.slice(i + 1).map((p) => p.key);
    const parsed = parseSpecFile(item.file);
    if (!parsed.ok) {
      return {
        succeeded: [],
        failed: { stage: 'parse', key: item.key, file: item.file, message: parsed.message },
        remaining,
      };
    }
    const lintResult = runLintFor(item.key, parsed.data);
    if (lintResult.errors.length > 0) {
      return {
        succeeded: [],
        failed: { stage: 'lint', key: item.key, file: item.file, issues: lintResult.errors },
        remaining,
      };
    }
    parsedItems.push({
      key: item.key,
      file: item.file,
      expected: item.expected,
      data: parsed.data,
    });
  }

  if (opts.lintOnly) {
    return {
      succeeded: parsedItems.map((p) => ({ key: p.key, file: p.file, version: 0 })),
      failed: null,
      remaining: [],
    };
  }

  // Build the atomic batch request. Re-parse each spec against its kind's zod schema to
  // narrow `unknown` → typed without an `as` cast.
  const body: ProposeBatchRequest = {};
  const schemaItems: Array<{ key: ArtifactKey; file: string }> = [];
  const endpointItems: Array<{ key: ArtifactKey; file: string }> = [];
  for (const item of parsedItems) {
    const options = expectedToBatchOptions(item.expected);
    if (item.key.kind === 'convention') {
      body.convention = withOptions({ spec: ConventionSpecSchema.parse(item.data) }, options);
    } else if (item.key.kind === 'schema') {
      body.schemas ??= [];
      body.schemas.push(
        withOptions({ name: item.key.name, spec: JSONSchemaSchema.parse(item.data) }, options),
      );
      schemaItems.push({ key: item.key, file: item.file });
    } else {
      body.endpoints ??= [];
      body.endpoints.push(
        withOptions(
          {
            method: item.key.method,
            path: item.key.path,
            spec: OperationSpecSchema.parse(item.data),
          },
          options,
        ),
      );
      endpointItems.push({ key: item.key, file: item.file });
    }
  }

  try {
    const res = await client.proposeBatch(document, body);
    // Match each succeeded server-side envelope back to its manifest file path.
    const succeeded: BatchProposeSuccess[] = [];
    let schemaCursor = 0;
    let endpointCursor = 0;
    for (const s of res.succeeded) {
      if (s.kind === 'convention') {
        const conv = parsedItems.find((p) => p.key.kind === 'convention');
        if (conv) succeeded.push({ key: conv.key, file: conv.file, version: s.envelope.version });
      } else if (s.kind === 'schema') {
        const slot = schemaItems[schemaCursor++];
        if (slot) succeeded.push({ key: slot.key, file: slot.file, version: s.envelope.version });
      } else {
        const slot = endpointItems[endpointCursor++];
        if (slot) succeeded.push({ key: slot.key, file: slot.file, version: s.envelope.version });
      }
    }
    return { succeeded, failed: null, remaining: [] };
  } catch (e) {
    const code = e instanceof ClientError ? e.code : null;
    const message = e instanceof Error ? e.message : String(e);
    // Whole-batch failure: nothing was committed (validation rejected before any writes),
    // unless a mid-batch propose raced a peer (rare). Mark every item as remaining.
    return {
      succeeded: [],
      failed: {
        stage: 'propose',
        key: plan[0]?.key ?? { kind: 'convention' },
        file: '',
        code,
        message,
      },
      remaining: plan.map((p) => p.key),
    };
  }
}

function runLintFor(
  key: ArtifactKey,
  data: unknown,
): { errors: LintIssue[]; warnings: LintIssue[] } {
  if (key.kind === 'convention') return lintConventionSpec(data);
  if (key.kind === 'schema') return lintSchemaSpec(key.name, data);
  return lintEndpointSpec(key.method, key.path, data);
}

function expectedToBatchOptions(e: ManifestExpected): BatchItemOptions | undefined {
  if (e === 'new') return { expectedVersion: 'new' };
  if (e === 'force') return { force: true };
  if (e === null || e === undefined) return undefined;
  return { expectedVersion: e };
}

function withOptions<T extends Record<string, unknown>>(
  item: T,
  options: BatchItemOptions | undefined,
): T & { options?: BatchItemOptions } {
  if (options === undefined) return item;
  return { ...item, options };
}
