// Standardized verb-handler guards. Each narrows a value (returning it, so TS respects the
// non-undefined type downstream — no `!`/`as`) AND owns the one canonical error message, so a given
// failure reads identically across every verb instead of each inventing its own phrasing.

import { errExit } from '../common.js';
import type { Target } from './types.js';

/** Narrow a capability's optional batch runner (`many`) to present; errExits with the one standard
 *  "can't batch this kind" message when absent (the noun is batchable but this verb has no batch
 *  runner for it). */
export function requireMany<R>(many: R | undefined, noun: string): R {
  if (many === undefined) errExit(2, `batch isn't supported for ${noun}`);
  return many;
}

/** Narrow a resolved target to its single id. Arity-'one' verbs never receive a batch target (the
 *  resolver rejects --target for them), so the batch branch is defensive. */
export function requireSingle<Id>(target: Target<Id>): Id {
  if (target.mode === 'batch') errExit(2, 'this verb takes a single target, not --target');
  return target.id;
}

/** A reject/counter reason is required; narrow opts.rationale to present with one standard message. */
export function requireReason(rationale: string | undefined): string {
  if (rationale === undefined || rationale.length === 0) {
    errExit(2, 'a reason is required — pass --rationale "<why>"');
  }
  return rationale;
}

/** propose is file-only; narrow opts.file to present with one standard message. */
export function requireFile(file: string | undefined): string {
  if (file === undefined) errExit(2, 'propose needs a spec file — pass --file <path.yaml>');
  return file;
}
