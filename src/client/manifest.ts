// Manifest loader for `brackish propose-batch`.
//
// A manifest names which spec files to propose and in what shape. Format intentionally minimal:
// three top-level keys (convention, schemas, endpoints). Order in the manifest is preserved within
// each group; we always run convention → schemas → endpoints regardless of the manifest's own
// ordering (schemas can $ref convention metadata; endpoints can $ref schemas).

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as yamlParse } from 'yaml';
import { z } from 'zod';
import { HttpMethodSchema, PathSchema, SchemaNameSchema } from '../lib/models.js';

// "expected" controls the concurrency assertion on each propose call.
const ExpectedSchema = z.union([z.literal('new'), z.literal('force'), z.number().int().positive()]);
export type ManifestExpected = z.infer<typeof ExpectedSchema>;

const ConventionEntrySchema = z
  .object({
    file: z.string().min(1),
    expected: ExpectedSchema.optional(),
  })
  .strict();

const SchemaEntrySchema = z
  .object({
    name: SchemaNameSchema,
    file: z.string().min(1),
    expected: ExpectedSchema.optional(),
  })
  .strict();

// Accept either case (`POST` or `post`) in manifests, normalize to lowercase. CLI verbs do the
// same normalization for the same reason: humans write methods in upper-case more often.
const LooseMethodSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.toLowerCase() : v),
  HttpMethodSchema,
);

const EndpointEntrySchema = z
  .object({
    method: LooseMethodSchema,
    path: PathSchema,
    file: z.string().min(1),
    expected: ExpectedSchema.optional(),
  })
  .strict();

export const ManifestSchema = z
  .object({
    convention: ConventionEntrySchema.optional(),
    schemas: z.array(SchemaEntrySchema).optional(),
    endpoints: z.array(EndpointEntrySchema).optional(),
  })
  .strict();
export type Manifest = z.infer<typeof ManifestSchema>;

/** File paths in the manifest resolve relative to the manifest file's own dir. */
export type LoadedManifest = {
  manifestPath: string;
  manifestDir: string;
  convention: { file: string; expected: ManifestExpected } | null;
  schemas: Array<{ name: string; file: string; expected: ManifestExpected }>;
  endpoints: Array<{
    method: z.infer<typeof HttpMethodSchema>;
    path: string;
    file: string;
    expected: ManifestExpected;
  }>;
};

export type LoadManifestResult =
  | { ok: true; manifest: LoadedManifest }
  | { ok: false; message: string };

export function loadManifest(manifestPath: string): LoadManifestResult {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (e) {
    return {
      ok: false,
      message: `cannot read manifest ${manifestPath}: ${e instanceof Error ? e.message : e}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = manifestPath.endsWith('.json') ? JSON.parse(raw) : yamlParse(raw);
  } catch (e) {
    return {
      ok: false,
      message: `manifest parse error: ${e instanceof Error ? e.message : e}`,
    };
  }
  const validated = ManifestSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`)
      .join('; ');
    return { ok: false, message: `manifest validation failed: ${issues}` };
  }
  if (
    !validated.data.convention &&
    !validated.data.schemas?.length &&
    !validated.data.endpoints?.length
  ) {
    return { ok: false, message: 'manifest is empty (no convention, no schemas, no endpoints)' };
  }
  const manifestDir = dirname(resolve(manifestPath));
  const resolvePath = (p: string): string => (isAbsolute(p) ? p : resolve(manifestDir, p));
  const defaultExpected: ManifestExpected = 'new';
  const loaded: LoadedManifest = {
    manifestPath: resolve(manifestPath),
    manifestDir,
    convention: validated.data.convention
      ? {
          file: resolvePath(validated.data.convention.file),
          expected: validated.data.convention.expected ?? defaultExpected,
        }
      : null,
    schemas: (validated.data.schemas ?? []).map((s) => ({
      name: s.name,
      file: resolvePath(s.file),
      expected: s.expected ?? defaultExpected,
    })),
    endpoints: (validated.data.endpoints ?? []).map((e) => ({
      method: e.method,
      path: e.path,
      file: resolvePath(e.file),
      expected: e.expected ?? defaultExpected,
    })),
  };
  return { ok: true, manifest: loaded };
}
