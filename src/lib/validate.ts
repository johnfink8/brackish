// OpenAPI 3.1 meta-schema validation for assembled brackish documents.
//
// brackish is the arbitrator of the negotiation: every operation (propose / accept / batch)
// must leave the doc valid against the official OpenAPI 3.1 meta-schema, including ref
// resolution. The caller builds the projected doc state (accepted + this operation applied,
// or accepted + currently-proposed + this proposal applied, depending on context) and runs
// validateDocument on the whole thing.
//
// The validator instance is module-shared. Ajv compiles the meta-schemas on first use
// (a few ms); subsequent calls are fast.

import { Validator } from '@seriousme/openapi-schema-validator';
import type { ErrorObject } from 'ajv';
import type { LintIssue, LintResult } from './lint-types.js';

const validator = new Validator();

/** Validate an assembled OpenAPI document against the 3.1 meta-schema, including ref
 *  resolution. Returns the existing LintResult shape so callers don't branch. */
export async function validateDocument(doc: Record<string, unknown>): Promise<LintResult> {
  const res = await validator.validate(doc);
  if (res.valid) return { errors: [], warnings: [] };
  // The validator returns `errors` as a string when the schema-match step passed but
  // checkRefs failed (e.g. "Can't resolve #/components/schemas/Message"). Surface as a
  // single root-level issue.
  if (typeof res.errors === 'string') {
    return { errors: [{ severity: 'error', field: '(refs)', message: res.errors }], warnings: [] };
  }
  if (!Array.isArray(res.errors)) return { errors: [], warnings: [] };
  return { errors: res.errors.map(ajvErrorToLintIssue), warnings: [] };
}

// --- helpers ---

/** JSON Pointer escaping (RFC 6901): `~` → `~0`, `/` → `~1`. ajv uses this in instancePath. */
function unescapeJsonPointer(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Convert an ajv error to our LintIssue shape. Field path is the JSON Pointer with
 *  segments unescaped and joined by `.`. For required-property errors, the missing
 *  property is appended so the user sees `securitySchemes.bearer.scheme` instead of just
 *  `securitySchemes.bearer`. */
function ajvErrorToLintIssue(error: ErrorObject): LintIssue {
  const segments = error.instancePath
    .split('/')
    .filter((s) => s.length > 0)
    .map(unescapeJsonPointer);
  if (error.keyword === 'required' && isRequiredParams(error.params)) {
    segments.push(error.params.missingProperty);
  }
  const field = segments.length === 0 ? '(root)' : segments.join('.');
  return { severity: 'error', field, message: error.message ?? 'invalid' };
}

function isRequiredParams(p: unknown): p is { missingProperty: string } {
  return typeof p === 'object' && p !== null && 'missingProperty' in p;
}
