// Assemble a valid OpenAPI 3.1 document from the accepted artifacts in a brackish document.
//
// Input: arrays of accepted artifacts (operations + schemas + the singleton convention).
// Output: a typed OpenAPI 3.1 document object suitable for yaml.stringify / JSON serialization.
//
// We don't enforce strict OpenAPI validity here — `passthrough` on the spec schemas means
// odd things can slip through. Downstream consumers (Swagger UI, codegen tools) will catch
// deeper errors. Our job is structural assembly.

import type {
  ConventionArtifact,
  ConventionSpec,
  HttpMethod,
  JSONSchema,
  OperationArtifact,
  OperationSpec,
  SchemaArtifact,
} from './models.js';

export type OpenAPIDocument = {
  openapi: '3.1.0';
  info: {
    title: string;
    version: string;
    description?: string | undefined;
    [extra: string]: unknown;
  };
  servers?: Array<{ url: string; description?: string | undefined; [extra: string]: unknown }>;
  paths: Record<string, Record<string, OperationSpec>>;
  components?: {
    schemas?: Record<string, JSONSchema>;
    securitySchemes?: Record<string, { type: string; [extra: string]: unknown }>;
    [extra: string]: unknown;
  };
  [extra: string]: unknown;
};

export type AssembleInput = {
  /** Only accepted operations are included. */
  operations: OperationArtifact[];
  /** Only accepted schemas are included. */
  schemas: SchemaArtifact[];
  /** Latest accepted convention; null means "use a stub info block." */
  convention: ConventionArtifact | null;
};

/** Build the OpenAPI document. Missing convention → a placeholder info block so downstream
 *  tools still accept the result. */
export function assembleDocument(input: AssembleInput): OpenAPIDocument {
  const conventionSpec: ConventionSpec | null =
    input.convention && input.convention.status === 'accepted' ? input.convention.spec : null;

  const info = conventionSpec?.info ?? { title: 'Untitled', version: '0.0.0' };
  const doc: OpenAPIDocument = {
    openapi: '3.1.0',
    info,
    paths: {},
  };

  if (conventionSpec?.servers) doc.servers = conventionSpec.servers;

  const securitySchemes = conventionSpec?.securitySchemes;
  if (securitySchemes && Object.keys(securitySchemes).length > 0) {
    doc.components = { ...(doc.components ?? {}), securitySchemes };
  }

  for (const op of input.operations) {
    if (op.status !== 'accepted') continue;
    const path = op.path;
    if (!doc.paths[path]) doc.paths[path] = {};
    doc.paths[path][op.method] = op.spec;
  }

  if (input.schemas.length > 0) {
    const schemaMap: Record<string, JSONSchema> = {};
    for (const s of input.schemas) {
      if (s.status !== 'accepted') continue;
      schemaMap[s.name] = s.spec;
    }
    if (Object.keys(schemaMap).length > 0) {
      doc.components = { ...(doc.components ?? {}), schemas: schemaMap };
    }
  }

  return doc;
}

/** Helper: pretty list of all (method, path) pairs from a doc. Used by visualize text mode. */
export function listOperations(
  doc: OpenAPIDocument,
): Array<{ method: HttpMethod; path: string; summary?: string }> {
  const out: Array<{ method: HttpMethod; path: string; summary?: string }> = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [method, spec] of Object.entries(ops)) {
      const sum: string | undefined = typeof spec.summary === 'string' ? spec.summary : undefined;
      out.push(
        sum !== undefined
          ? { method: method as HttpMethod, path, summary: sum }
          : { method: method as HttpMethod, path },
      );
    }
  }
  return out;
}
