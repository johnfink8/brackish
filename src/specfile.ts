// Spec-file load + parse helpers shared between `propose --file`, `<kind> lint`, and
// `propose-batch --manifest`. Pulled into its own module so batch logic doesn't depend on cli.ts.

import { readFileSync } from 'node:fs';
import { YAMLParseError, parse as yamlParse } from 'yaml';

/** Throws on parse failure. Existing `propose --file` path uses this; failures bubble through
 *  `withClient` as a generic 1-exit. Lint should prefer `parseSpecFile` for location-aware
 *  errors. */
export function loadSpecFile(path: string): unknown {
  const raw = readFileSync(path, 'utf8');
  if (path.endsWith('.json')) return JSON.parse(raw);
  return yamlParse(raw);
}

export type ParseResult = { ok: true; data: unknown } | { ok: false; message: string };

/** Parse with location-aware errors. Returns an envelope so callers can present line/col instead
 *  of a generic stack trace. */
export function parseSpecFile(path: string): ParseResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, message: `cannot read ${path}: ${e instanceof Error ? e.message : e}` };
  }
  if (path.endsWith('.json')) {
    try {
      return { ok: true, data: JSON.parse(raw) };
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
    return { ok: true, data: yamlParse(raw) };
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
