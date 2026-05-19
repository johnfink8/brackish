// RFC 6902 JSON Patch generation + a compact one-line summary derived from a patch.
//
// We only emit `add` / `remove` / `replace` ops — never `move` / `copy` / `test`. That keeps
// the diff readable and unambiguous, at the cost of a slightly larger patch when fields
// move around. Worth it for our use case (compact display for agent context).
//
// JSON Pointer escaping (RFC 6901): `/` in a key becomes `~1`, `~` becomes `~0`.

import type { JsonPatch, JsonPatchOp } from './models.js';

/** Generate an RFC 6902 patch transforming `before` into `after`. */
export function generatePatch(before: unknown, after: unknown): JsonPatch {
  const ops: JsonPatchOp[] = [];
  walk('', before, after, ops);
  return ops;
}

function walk(path: string, before: unknown, after: unknown, out: JsonPatchOp[]): void {
  if (deepEqual(before, after)) return;

  // Type mismatch or non-object on either side → replace whole subtree
  if (
    !isArrayOrPlainObject(before) ||
    !isArrayOrPlainObject(after) ||
    Array.isArray(before) !== Array.isArray(after)
  ) {
    if (before === undefined) {
      out.push({ op: 'add', path, value: after });
    } else if (after === undefined) {
      out.push({ op: 'remove', path });
    } else {
      out.push({ op: 'replace', path, value: after });
    }
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    // Index-by-index diff. Not as clever as LCS but predictable and good enough.
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i++) {
      const bv = i < before.length ? before[i] : undefined;
      const av = i < after.length ? after[i] : undefined;
      walk(`${path}/${i}`, bv, av, out);
    }
    return;
  }

  // Both are non-array objects → diff by key. The guards above narrowed before+after to plain
  // records; iterate by union of keys.
  if (!isPlainObject(before) || !isPlainObject(after)) return;
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const sub = `${path}/${escapePointerSegment(key)}`;
    walk(sub, before[key], after[key], out);
  }
}

/** Plain object guard: typeof 'object' is true for arrays + null, so we filter both. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isArrayOrPlainObject(v: unknown): v is Record<string, unknown> | readonly unknown[] {
  return typeof v === 'object' && v !== null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (!isArrayOrPlainObject(a) || !isArrayOrPlainObject(b)) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function escapePointerSegment(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Compact one-line summary of a patch: `+a.b; -c.d; ~e.f` (add / remove / replace).
 *  This is what we display in event lists and inbox previews — small enough that agents can
 *  decide whether to fetch the full spec from a glance. */
export function compactSummary(patch: JsonPatch): string {
  if (patch.length === 0) return '';
  return patch
    .map((op) => {
      const sigil = op.op === 'add' ? '+' : op.op === 'remove' ? '-' : '~';
      return `${sigil}${jsonPointerToDotted(op.path)}`;
    })
    .join('; ');
}

/** Convert an RFC 6901 JSON Pointer like `/responses/201/content/application~1json` to a
 *  readable dotted path like `responses.201.content.application/json`. Unescapes per RFC 6901. */
function jsonPointerToDotted(pointer: string): string {
  if (pointer === '') return '(root)';
  return pointer
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');
}
