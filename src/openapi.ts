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

  // Hoist any extension fields the convention carries (`security`, `x-brackish`, etc.) to the
  // document root so codegen tools see them where OpenAPI specifies they live.
  if (conventionSpec) {
    if (conventionSpec.security && conventionSpec.security.length > 0) {
      doc.security = conventionSpec.security;
    }
    for (const [key, value] of Object.entries(conventionSpec)) {
      if (key.startsWith('x-')) doc[key] = value;
    }
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
