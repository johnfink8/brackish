// Client-side propose-from-manifest: load a manifest, pre-flight (parse + lint) locally, then submit
// the whole set as one atomic propose-batch request. (Batch ACCEPT is a single atomic server call —
// see BrackishClient.batchAcceptSchemas / batchAcceptEndpoints — so it isn't composed here.)

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
  OperationSpecSchema,
  type ProposeBatchRequest,
} from '../lib/models.js';
import { parseSpecFile } from '../lib/specfile.js';
import { type BrackishClient, ClientError, type SpecIssue } from './client.js';
import { type LoadedManifest, loadManifest, type ManifestExpected } from './manifest.js';

/** A batch-accept target identity (also the endpoint noun's Id). */
export type EndpointTarget = { method: HttpMethod; path: string };

// --- propose-batch -----------------------------------------------------------

export type ArtifactKey =
  | { kind: 'convention' }
  | { kind: 'schema'; name: string }
  | { kind: 'endpoint'; method: HttpMethod; path: string };

/** One-line label for an artifact key — shared by the propose --manifest and validate presenters. */
export function describeArtifactKey(key: ArtifactKey): string {
  if (key.kind === 'convention') return 'convention';
  if (key.kind === 'schema') return `schema ${key.name}`;
  return `endpoint ${key.method.toUpperCase()} ${key.path}`;
}

export type BatchProposeFailure =
  | { stage: 'manifest'; message: string }
  | { stage: 'parse'; key: ArtifactKey; file: string; message: string }
  | { stage: 'lint'; key: ArtifactKey; file: string; issues: LintIssue[] }
  // The whole batch was rejected as one unit — the assembled doc didn't validate, and nothing
  // was written. Not attributable to a single item, so no `key`/`remaining`.
  | { stage: 'batch'; code: string | null; message: string; issues: SpecIssue[] };

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

type ParsedItem = {
  key: ArtifactKey;
  file: string;
  expected: ManifestExpected;
  data: unknown;
};

/** Load a manifest, then parse + brackish-lint every file in plan order. Stops at the first
 *  parse/lint failure (those checks are genuinely sequential), returning a BatchProposeResult
 *  carrying the failure + the items not yet reached. The deep meta-schema validation happens
 *  server-side; this is the cheap local pre-flight shared by propose-batch and validate. */
function loadAndParseManifest(
  manifestPath: string,
): { ok: true; items: ParsedItem[] } | { ok: false; result: BatchProposeResult } {
  const loaded = loadManifest(manifestPath);
  if (!loaded.ok) {
    return {
      ok: false,
      result: {
        succeeded: [],
        failed: { stage: 'manifest', message: loaded.message },
        remaining: [],
      },
    };
  }
  const plan = planArtifacts(loaded.manifest);
  const items: ParsedItem[] = [];
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i];
    if (!item) continue;
    const remaining = plan.slice(i + 1).map((p) => p.key);
    const parsed = parseSpecFile(item.file);
    if (!parsed.ok) {
      return {
        ok: false,
        result: {
          succeeded: [],
          failed: { stage: 'parse', key: item.key, file: item.file, message: parsed.message },
          remaining,
        },
      };
    }
    const lintResult = runLintFor(item.key, parsed.data);
    if (lintResult.errors.length > 0) {
      return {
        ok: false,
        result: {
          succeeded: [],
          failed: { stage: 'lint', key: item.key, file: item.file, issues: lintResult.errors },
          remaining,
        },
      };
    }
    items.push({ key: item.key, file: item.file, expected: item.expected, data: parsed.data });
  }
  return { ok: true, items };
}

/** Build the wire batch request from parsed items, keeping ordered key→file lists so the
 *  caller can match server-side envelopes back to manifest paths. Re-parses each spec against
 *  its kind's zod schema to narrow `unknown` → typed without an `as` cast. */
function buildBatchBody(items: ParsedItem[]): {
  body: ProposeBatchRequest;
  schemaItems: Array<{ key: ArtifactKey; file: string }>;
  endpointItems: Array<{ key: ArtifactKey; file: string }>;
} {
  const body: ProposeBatchRequest = {};
  const schemaItems: Array<{ key: ArtifactKey; file: string }> = [];
  const endpointItems: Array<{ key: ArtifactKey; file: string }> = [];
  for (const item of items) {
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
  return { body, schemaItems, endpointItems };
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
  const loaded = loadAndParseManifest(manifestPath);
  if (!loaded.ok) return loaded.result;
  const parsedItems = loaded.items;

  if (opts.lintOnly) {
    return {
      succeeded: parsedItems.map((p) => ({ key: p.key, file: p.file, version: 0 })),
      failed: null,
      remaining: [],
    };
  }

  const { body, schemaItems, endpointItems } = buildBatchBody(parsedItems);

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
    const issues = e instanceof ClientError ? e.issues : [];
    // Atomic whole-batch rejection: the server validated the assembled doc and wrote nothing
    // (a mid-batch peer race rolls back the same way). There's no partial state and no single
    // culprit item, so report it as one batch failure — not a per-item "remaining" list.
    return { succeeded: [], failed: { stage: 'batch', code, message, issues }, remaining: [] };
  }
}

export type ValidateManifestResult =
  | {
      ok: true;
      valid: boolean;
      view: 'accepted' | 'wide';
      issues: SpecIssue[];
      itemCount: number;
    }
  | { ok: false; failed: BatchProposeFailure };

/** Dry-run a manifest: pre-flight locally, then ask the server to assemble + meta-schema-validate
 *  the whole set without committing. Same load/lint path as propose-batch, so a manifest that
 *  validates here will commit cleanly there. */
export async function validateFromManifest(
  client: BrackishClient,
  document: DocumentName,
  manifestPath: string,
): Promise<ValidateManifestResult> {
  const loaded = loadAndParseManifest(manifestPath);
  if (!loaded.ok) {
    // loadAndParseManifest only ever produces manifest/parse/lint failures here.
    return { ok: false, failed: loaded.result.failed ?? { stage: 'manifest', message: 'unknown' } };
  }
  const { body } = buildBatchBody(loaded.items);
  const res = await client.validate(document, body);
  return {
    ok: true,
    valid: res.valid,
    view: res.view,
    issues: res.issues,
    itemCount: loaded.items.length,
  };
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
