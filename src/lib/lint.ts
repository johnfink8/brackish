// Local pre-flight checks for OpenAPI artifact specs before proposing.
//
// Best-effort client-side checks: zod-parses (structural reject) and a small set of
// brackish-specific cross-field checks (path↔params, security ref consistency within a
// convention, x-brackish.naming enum).
//
// What this does NOT do: full OpenAPI 3.1 meta-schema validation, or cross-artifact
// $ref resolution. Both require doc context (other artifacts in the doc) so they live
// on the server (validateDocument runs the meta-schema on the assembled doc, catching
// shape errors AND dangling refs). Local lint is "did I make a syntax mistake in this
// file?" — the server is the arbitrator.

import type { z } from 'zod';
import type { LintIssue, LintResult } from './lint-types.js';
import {
  ConventionSpecSchema,
  type HttpMethod,
  JSONSchemaSchema,
  OperationSpecSchema,
} from './models.js';

export type { LintIssue, LintResult } from './lint-types.js';

const empty = (): LintResult => ({ errors: [], warnings: [] });

/** Re-used pattern for `{var}` placeholders in operation paths. Kept in one place so
 *  buildOperationSpec and lint stay in sync. */
export const PATH_PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function pathPlaceholders(path: string): string[] {
  return [...path.matchAll(PATH_PLACEHOLDER_RE)].map((m) => m[1] as string);
}

function zodIssuesToLint(error: z.ZodError, rootField = ''): LintIssue[] {
  return error.issues.map((iss) => {
    const fieldPath = [...(rootField ? [rootField] : []), ...iss.path.map(String)].join('.');
    return {
      severity: 'error' as const,
      field: fieldPath || '(root)',
      message: iss.message,
    };
  });
}

/** Lint an Operation (endpoint) spec. Path + method are external context; only path is used. */
export function lintEndpointSpec(method: HttpMethod, path: string, spec: unknown): LintResult {
  const out = empty();
  void method; // method is reserved for future cross-checks (e.g. GET shouldn't have requestBody)

  const parsed = OperationSpecSchema.safeParse(spec);
  if (!parsed.success) {
    out.errors.push(...zodIssuesToLint(parsed.error));
    return out;
  }
  const op = parsed.data;

  // path placeholders ↔ parameters consistency
  const placeholders = pathPlaceholders(path);
  const declaredPathParams = (op.parameters ?? [])
    .map((p, i) => ({ idx: i, name: p.name, in: p.in }))
    .filter((p) => p.in === 'path');
  const declaredNames = new Set(declaredPathParams.map((p) => p.name));
  for (const ph of placeholders) {
    if (!declaredNames.has(ph)) {
      out.errors.push({
        severity: 'error',
        field: 'parameters',
        message: `path placeholder "{${ph}}" has no parameters entry (need { name: "${ph}", in: "path", required: true, schema: {...} })`,
      });
    }
  }
  const placeholderSet = new Set(placeholders);
  for (const p of declaredPathParams) {
    if (!placeholderSet.has(p.name)) {
      out.errors.push({
        severity: 'error',
        field: `parameters[${p.idx}].name`,
        message: `parameter "${p.name}" is declared in:path but path "${path}" has no {${p.name}} placeholder`,
      });
    }
  }

  // $ref strings — flag any that don't start with `#/components/`
  walkRefs(op, (ref, fieldPath) => {
    if (!ref.startsWith('#/components/')) {
      out.warnings.push({
        severity: 'warn',
        field: fieldPath,
        message: `$ref "${ref}" should start with "#/components/" (OpenAPI 3.1 internal-ref convention)`,
      });
    }
  });
  lintNullable(out, op);

  return out;
}

/** Lint a JSON Schema component. zod's `.passthrough()` accepts anything; full meta-schema
 *  validation happens server-side as part of the assembled-doc validation. */
export function lintSchemaSpec(name: string, spec: unknown): LintResult {
  const out = empty();
  void name;
  const parsed = JSONSchemaSchema.safeParse(spec);
  if (!parsed.success) {
    out.errors.push(...zodIssuesToLint(parsed.error));
    return out;
  }
  // $ref consistency, same rule as endpoint
  walkRefs(parsed.data, (ref, fieldPath) => {
    if (!ref.startsWith('#/components/')) {
      out.warnings.push({
        severity: 'warn',
        field: fieldPath,
        message: `$ref "${ref}" should start with "#/components/" (OpenAPI 3.1 internal-ref convention)`,
      });
    }
  });
  lintNullable(out, parsed.data);
  return out;
}

/** Lint a Convention spec. Catches mismatch between `security` and declared `securitySchemes`,
 *  plus the `x-brackish.naming` enum that `buildConventionSpec` rejects when the flag form is
 *  used but not when the `--file` form is. */
export function lintConventionSpec(spec: unknown): LintResult {
  const out = empty();
  const parsed = ConventionSpecSchema.safeParse(spec);
  if (!parsed.success) {
    out.errors.push(...zodIssuesToLint(parsed.error));
    return out;
  }
  const conv = parsed.data;

  // security[*].<scheme> must reference a declared scheme
  const declared = new Set(Object.keys(conv.securitySchemes ?? {}));
  const security = readSecurityField(spec);
  if (security !== null) {
    security.forEach((req, i) => {
      for (const schemeName of Object.keys(req)) {
        if (!declared.has(schemeName)) {
          out.errors.push({
            severity: 'error',
            field: `security[${i}]`,
            message: `references security scheme "${schemeName}" which is not declared in securitySchemes (declared: ${[...declared].sort().join(', ') || 'none'})`,
          });
        }
      }
    });
  }

  // x-brackish.naming must be one of camelCase | snake_case if set
  const naming = readNamingField(spec);
  if (naming !== null && naming !== 'camelCase' && naming !== 'snake_case') {
    out.errors.push({
      severity: 'error',
      field: 'x-brackish.naming',
      message: `must be "camelCase" or "snake_case" (got "${naming}")`,
    });
  }

  return out;
}

// --- helpers ---

/** Warn on OpenAPI 3.0-style `nullable: <bool>` anywhere in a schema/operation. 3.1 dropped the
 *  keyword (it's JSON Schema 2020-12); the meta-schema silently ignores it, so it passes server
 *  validation but 3.1 codegen treats the field as non-nullable. Use `type: [..., 'null']`. */
function lintNullable(out: LintResult, root: unknown): void {
  walkNullable(root, (fieldPath) => {
    out.warnings.push({
      severity: 'warn',
      field: fieldPath,
      message:
        "OpenAPI 3.0 `nullable` is ignored in 3.1 — use `type: [<type>, 'null']` instead (3.1 tooling treats this field as non-nullable)",
    });
  });
}

function walkNullable(
  obj: unknown,
  visit: (fieldPath: string) => void,
  trail: string[] = [],
): void {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) walkNullable(obj[i], visit, [...trail, String(i)]);
    return;
  }
  if (typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'nullable' && typeof v === 'boolean') {
      visit(trail.length === 0 ? 'nullable' : `${trail.join('.')}.nullable`);
    } else {
      walkNullable(v, visit, [...trail, k]);
    }
  }
}

/** Recursively walk an object, calling `visit(refString, dottedPath)` for every `$ref: "..."`. */
function walkRefs(
  obj: unknown,
  visit: (ref: string, fieldPath: string) => void,
  trail: string[] = [],
): void {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkRefs(obj[i], visit, [...trail, String(i)]);
    }
    return;
  }
  if (typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (k === '$ref' && typeof v === 'string') {
      visit(v, trail.length === 0 ? '$ref' : `${trail.join('.')}.$ref`);
    } else {
      walkRefs(v, visit, [...trail, k]);
    }
  }
}

/** Convention's `security` lives in passthrough territory; extract without an `as` cast. */
function readSecurityField(spec: unknown): Array<Record<string, string[]>> | null {
  if (typeof spec !== 'object' || spec === null) return null;
  if (!('security' in spec)) return null;
  const sec = spec.security;
  if (!Array.isArray(sec)) return null;
  const out: Array<Record<string, string[]>> = [];
  for (const entry of sec) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const norm: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(entry)) {
        norm[k] = Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
      }
      out.push(norm);
    }
  }
  return out;
}

/** Read `x-brackish.naming` from a convention spec without casting. Returns null if absent. */
function readNamingField(spec: unknown): string | null {
  if (typeof spec !== 'object' || spec === null) return null;
  if (!('x-brackish' in spec)) return null;
  const ext = spec['x-brackish'];
  if (typeof ext !== 'object' || ext === null) return null;
  if (!('naming' in ext)) return null;
  const naming = ext.naming;
  return typeof naming === 'string' ? naming : null;
}
