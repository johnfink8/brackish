// Project the doc state into an OpenAPI document, with an optional overlay applied.
//
// brackish is the arbitrator: every propose / accept must leave the doc valid against the
// OpenAPI 3.1 meta-schema, including ref resolution. The handler workflow is:
//   1. Build the doc state (wide or accepted-only depending on the operation)
//   2. Overlay the artifact(s) being proposed/accepted
//   3. Assemble into an OpenAPI document
//   4. Run validateDocument
//   5. 400 if invalid; commit if valid
//
// "Wide" view (used on propose): includes accepted + currently-proposed artifacts. Refs
// from a new propose may legitimately point at peer-proposed artifacts that haven't been
// accepted yet — the peer can accept after.
//
// "Accepted" view (used on accept): only artifacts in the accepted state. Refs must
// resolve here for the assembled-accepted doc to be valid.

import type {
  ConventionSpec,
  DocumentName,
  HttpMethod,
  JSONSchema,
  OperationSpec,
} from '../lib/models.js';
import { assembleFromSpecs, type OpenAPIDocument } from '../lib/openapi.js';
import type { Store } from './store/index.js';

export type ProjectionView = 'wide' | 'accepted';

export type Overlay = {
  /** Replace/add this convention if set. null = no convention overlay (keep store state). */
  convention?: ConventionSpec | null;
  /** Replace/add these schemas (keyed by name). */
  schemas?: Map<string, JSONSchema>;
  /** Replace/add these operations (keyed by `<METHOD> <path>`). */
  operations?: Map<string, { method: HttpMethod; path: string; spec: OperationSpec }>;
};

/** Build the projected OpenAPI document. */
export async function projectDocument(
  store: Store,
  doc: DocumentName,
  view: ProjectionView,
  overlay: Overlay = {},
): Promise<OpenAPIDocument> {
  // Convention
  let convention: ConventionSpec | null;
  if (overlay.convention !== undefined) {
    convention = overlay.convention;
  } else {
    convention = await currentConvention(store, doc, view);
  }

  // Schemas
  const schemaSummaries = await store.listSchemas(doc);
  const schemaMap = new Map<string, JSONSchema>();
  for (const s of schemaSummaries) {
    if (overlay.schemas?.has(s.name)) continue; // overlaid below
    const artifact = await pickArtifact(view, s.currentVersion, s.latestProposedVersion, (v) =>
      store.getSchemaByVersion(doc, s.name, v),
    );
    if (artifact) schemaMap.set(s.name, artifact.spec);
  }
  if (overlay.schemas) {
    for (const [name, spec] of overlay.schemas) schemaMap.set(name, spec);
  }

  // Operations
  const endpointSummaries = await store.listEndpoints(doc);
  const operationMap = new Map<string, { method: HttpMethod; path: string; spec: OperationSpec }>();
  for (const ep of endpointSummaries) {
    const key = operationKey(ep.method, ep.path);
    if (overlay.operations?.has(key)) continue;
    const artifact = await pickArtifact(view, ep.currentVersion, ep.latestProposedVersion, (v) =>
      store.getEndpointByVersion(doc, ep.method, ep.path, v),
    );
    if (artifact) {
      operationMap.set(key, { method: ep.method, path: ep.path, spec: artifact.spec });
    }
  }
  if (overlay.operations) {
    for (const [key, op] of overlay.operations) operationMap.set(key, op);
  }

  return assembleFromSpecs({
    convention,
    schemas: [...schemaMap].map(([name, spec]) => ({ name, spec })),
    operations: [...operationMap.values()],
  });
}

export function operationKey(method: HttpMethod, path: string): string {
  return `${method} ${path}`;
}

async function currentConvention(
  store: Store,
  doc: DocumentName,
  view: ProjectionView,
): Promise<ConventionSpec | null> {
  if (view === 'wide') {
    const proposed = await store.getConventionProposed(doc);
    if (proposed) return proposed.spec;
  }
  const current = await store.getConventionCurrent(doc);
  return current && current.status === 'accepted' ? current.spec : null;
}

async function pickArtifact<T>(
  view: ProjectionView,
  currentVersion: number | null,
  latestProposedVersion: number | null,
  fetchByVersion: (v: number) => Promise<T | null>,
): Promise<T | null> {
  if (view === 'wide') {
    const version = latestProposedVersion ?? currentVersion;
    if (version === null) return null;
    return fetchByVersion(version);
  }
  if (currentVersion === null) return null;
  return fetchByVersion(currentVersion);
}
