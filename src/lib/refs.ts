// Walk an OpenAPI / JSON Schema spec for `$ref: '#/components/schemas/<X>'` strings
// and return the referenced schema names that haven't been accepted yet. Used by
// `brackish status` to surface proposals that can't be accepted because they depend
// on a peer schema that's still in proposed/rejected limbo.
//
// Scope: only resolves component schema refs (the only ref kind brackish uses today).
// Doesn't follow remote refs or component.* refs other than `schemas/`.

const COMPONENT_SCHEMA_REF = /^#\/components\/schemas\/([A-Za-z][A-Za-z0-9_]*)$/;

/** Recursively walk an arbitrary value collecting every `#/components/schemas/<X>` ref. */
export function collectSchemaRefs(spec: unknown): string[] {
  const found = new Set<string>();
  walk(spec, found);
  return [...found].sort();
}

function walk(node: unknown, out: Set<string>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === 'string') {
    const m = COMPONENT_SCHEMA_REF.exec(ref);
    if (m?.[1]) out.add(m[1]);
  }
  for (const key of Object.keys(obj)) {
    if (key === '$ref') continue;
    walk(obj[key], out);
  }
}

/** Return the subset of refs in `spec` that point at schemas NOT in `acceptedSchemas`. */
export function findBlockingRefs(spec: unknown, acceptedSchemas: Set<string>): string[] {
  return collectSchemaRefs(spec).filter((name) => !acceptedSchemas.has(name));
}
