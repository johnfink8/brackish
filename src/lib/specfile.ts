// Spec-file load + parse helpers shared between `propose --file`, `<kind> lint`, and
// `propose-batch --manifest`. Pulled into its own module so batch logic doesn't depend on cli.ts.

import { readFileSync } from 'node:fs';
import { YAMLParseError, parse as yamlParse } from 'yaml';
import type { z } from 'zod';

/** Read + parse a spec file (JSON or YAML) and validate it against a zod schema. Throws on
 *  parse failure or schema mismatch — callers use this via `withClient` so the failure bubbles
 *  through as a generic 1-exit. Lint should prefer `parseSpecFile` for location-aware errors. */
export function loadSpecFile<T>(path: string, schema: z.ZodType<T>): T {
  const raw = readFileSync(path, 'utf8');
  const data: unknown = path.endsWith('.json') ? JSON.parse(raw) : yamlParse(raw);
  return schema.parse(data);
}

export type ParseResult<T = unknown> = { ok: true; data: T } | { ok: false; message: string };

/** Parse with location-aware errors. Returns an envelope so callers can present line/col instead
 *  of a generic stack trace. Returns `unknown`; pair with a schema-aware caller (or the typed
 *  `parseSpecFileAs` below) to narrow. */
export function parseSpecFile(path: string): ParseResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, message: `cannot read ${path}: ${e instanceof Error ? e.message : e}` };
  }
  if (path.endsWith('.json')) {
    try {
      const data: unknown = JSON.parse(raw);
      return { ok: true, data };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const posMatch = msg.match(/at position (\d+)/);
      if (posMatch?.[1] !== undefined) {
        const { line, col } = offsetToLineCol(raw, Number.parseInt(posMatch[1], 10));
        return { ok: false, message: `JSON parse error at line ${line}, col ${col}: ${msg}` };
      }
      return { ok: false, message: `JSON parse error: ${msg}` };
    }
  }
  try {
    const data: unknown = yamlParse(raw);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof YAMLParseError && e.linePos && e.linePos[0]) {
      const { line, col } = e.linePos[0];
      const cleaned = e.message.replace(/\n\s*/g, ' ');
      return { ok: false, message: `YAML parse error at line ${line}, col ${col}: ${cleaned}` };
    }
    return { ok: false, message: `YAML parse error: ${e instanceof Error ? e.message : e}` };
  }
}

function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}
