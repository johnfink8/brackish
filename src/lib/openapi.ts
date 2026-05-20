// Assemble a valid OpenAPI 3.1 document from the accepted artifacts in a brackish document.
//
// Input: arrays of accepted artifacts (operations + schemas + the singleton convention).
// Output: a typed OpenAPI 3.1 document object suitable for yaml.stringify / JSON serialization.
//
// We don't enforce strict OpenAPI validity here — `passthrough` on the spec schemas means
// odd things can slip through. Downstream consumers (Swagger UI, codegen tools) will catch
// deeper errors. Our job is structural assembly.

import { z } from 'zod';
import {
  type ConventionArtifact,
  type ConventionSpec,
  type HttpMethod,
  HttpMethodSchema,
  type JSONSchema,
  JSONSchemaSchema,
  type OperationArtifact,
  type OperationSpec,
  OperationSpecSchema,
  type SchemaArtifact,
} from './models.js';

// Loose zod schema matching the structural type below. `.passthrough()` everywhere so the
// OpenAPI extension fields (x-brackish.*, vendor extensions on info/servers/etc.) round-trip
// cleanly. Used at the client/server boundary on /documents/:name/openapi.json.
export const OpenAPIDocumentSchema = z
  .object({
    openapi: z.literal('3.1.0'),
    info: z
      .object({
        title: z.string(),
        version: z.string(),
        description: z.string().optional(),
      })
      .passthrough(),
    servers: z
      .array(
        z
          .object({
            url: z.string(),
            description: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    security: z.array(z.record(z.string(), z.array(z.string()))).optional(),
    // OpenAPI says a path item may contain any subset of HTTP methods. We keep the inner record
    // string-keyed and validate method names via HttpMethodSchema in `listOperations`.
    paths: z.record(z.string(), z.record(z.string(), OperationSpecSchema)),
    components: z
      .object({
        schemas: z.record(z.string(), JSONSchemaSchema).optional(),
        securitySchemes: z
          .record(z.string(), z.object({ type: z.string() }).passthrough())
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type OpenAPIDocument = z.infer<typeof OpenAPIDocumentSchema>;

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
  return assembleFromSpecs({
    convention: input.convention?.status === 'accepted' ? input.convention.spec : null,
    schemas: input.schemas
      .filter((s) => s.status === 'accepted')
      .map((s) => ({ name: s.name, spec: s.spec })),
    operations: input.operations
      .filter((op) => op.status === 'accepted')
      .map((op) => ({ method: op.method, path: op.path, spec: op.spec })),
  });
}

export type AssembleFromSpecsInput = {
  convention: ConventionSpec | null;
  schemas: Array<{ name: string; spec: JSONSchema }>;
  operations: Array<{ method: HttpMethod; path: string; spec: OperationSpec }>;
};

/** Assemble an OpenAPI document from pre-resolved spec values (no artifact envelopes / no
 *  status filtering). Used by the propose/accept handlers' projection step: build the
 *  doc-after-this-operation-applied from a slice of the store's current state, then run
 *  validateDocument on the result.
 *
 *  Operation specs are zod-typed (OperationSpec) but written in via passthrough; same shape
 *  as artifact.spec. This is intentionally permissive — the meta-schema validator catches
 *  shape issues; here we just assemble. */
export function assembleFromSpecs(input: AssembleFromSpecsInput): OpenAPIDocument {
  const conventionSpec = input.convention;
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

  if (conventionSpec) {
    if (conventionSpec.security && conventionSpec.security.length > 0) {
      doc.security = conventionSpec.security;
    }
    for (const [key, value] of Object.entries(conventionSpec)) {
      if (key.startsWith('x-')) doc[key] = value;
    }
  }

  for (const op of input.operations) {
    const path = op.path;
    if (!doc.paths[path]) doc.paths[path] = {};
    doc.paths[path][op.method] = op.spec;
  }

  if (input.schemas.length > 0) {
    const schemaMap: Record<string, JSONSchema> = {};
    for (const s of input.schemas) schemaMap[s.name] = s.spec;
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
    for (const [methodKey, spec] of Object.entries(ops)) {
      // doc.paths is built from the schema's z.record(HttpMethodSchema, …); the key narrows
      // via the same schema so we don't reach for `as HttpMethod`.
      const method = HttpMethodSchema.parse(methodKey);
      const sum: string | undefined = typeof spec.summary === 'string' ? spec.summary : undefined;
      out.push(sum !== undefined ? { method, path, summary: sum } : { method, path });
    }
  }
  return out;
}
