// The standard option catalog + the parsed-opts boundary schema. Each option is defined once here so
// it means and reads the same wherever a verb references it. Coercion (string→number, enum) happens
// at this single commander→app boundary via zod — not re-inlined per command.
//
// StandardOptsSchema is the source of truth for which options exist; OPT must carry exactly the same
// keys (`satisfies Record<keyof StandardOpts, OptionDef>`). Verbs reference options by KEY (typed
// OptName), and applyOptions derives the flag as `--${kebab(key)}` — so the flag string is never
// written by hand and can't drift from the key (and the key can't drift from the schema field). The
// whole chain key ⇿ flag ⇿ schema-field is locked at compile time.

import type { Command } from 'commander';
import { z } from 'zod';
import type { ProposeOptionsWire } from '../../client/client.js';
import { collect, errExit } from '../common.js';

interface OptionDef {
  readonly description: string;
  readonly arg?: string; // value placeholder, e.g. 'n', 'path'; absent ⇒ boolean flag
  readonly repeatable?: boolean; // accumulate repeats into an array (e.g. --target)
}

// The parsed shape every handler reads. `target` is a descriptor-supplied identity selector (batch),
// not a standard option; it rides in the same bag so handlers read one typed object.
const StandardOptsSchema = z.object({
  doc: z.string().optional(),
  json: z.boolean().optional(),
  rationale: z.string().optional(),
  rev: z.coerce.number().int().positive().optional(),
  expectedRev: z.coerce.number().int().positive().optional(),
  expectedNew: z.boolean().optional(),
  force: z.boolean().optional(),
  file: z.string().optional(),
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
  format: z.enum(['patch', 'yaml', 'json', 'rendered']).optional(),
  strict: z.boolean().optional(),
  all: z.boolean().optional(),
  full: z.boolean().optional(),
  target: z.array(z.string()).optional(),
  includeDependencies: z.boolean().optional(),
});
export type StandardOpts = z.infer<typeof StandardOptsSchema>;

/** An option name — a field of StandardOpts. Verbs list these; the flag is derived from the name. */
export type OptName = keyof StandardOpts;

/** One definition per option, keyed by the StandardOpts field it feeds — the `Record<OptName, …>`
 *  annotation keeps the two in lockstep (missing or excess key → compile error) and widens entries
 *  to OptionDef so applyOptions can read `arg`/`repeatable`. The flag is derived from the key. */
const OPT: Record<OptName, OptionDef> = {
  doc: {
    description: 'document name (defaults to the only one; required when several exist)',
    arg: 'name',
  },
  json: { description: 'emit JSON instead of text' },
  rationale: { description: 'the why; rides on the event to the peer', arg: 'text' },
  rev: { description: 'act on a specific existing revision (artifact version N)', arg: 'n' },
  expectedRev: { description: 'concurrency guard: latest revision must be exactly N', arg: 'n' },
  expectedNew: { description: 'concurrency guard: refuse if any revision exists' },
  force: { description: 'allow proposing atop an unresolved revision' },
  file: { description: 'load the full body from a YAML/JSON file', arg: 'path' },
  from: { description: 'diff: lower revision bound', arg: 'n' },
  to: { description: 'diff: upper revision bound', arg: 'n' },
  format: { description: 'diff output form', arg: 'patch|yaml|json|rendered' },
  strict: { description: 'lint: treat warnings as errors' },
  all: { description: 'include resolved, not just pending' },
  full: { description: 'no-op (the body is always included)' },
  // Batch selector, shared by any verb that supports a batch mode. The ref grammar is per-noun
  // (endpoint METHOD:PATH, schema NAME, …) — the noun's capability parses it.
  target: {
    description: 'an artifact to include (repeatable for a batch operation)',
    arg: 'ref',
    repeatable: true,
  },
  includeDependencies: {
    description:
      'also accept the still-proposed schemas the targets $ref (transitively), in the same atomic batch',
  },
};

const camelToKebab = (s: string): string => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

/** Register the named options on a command, deriving each flag as `--<kebab-key> [<arg>]`. */
export function applyOptions(cmd: Command, names: readonly OptName[]): void {
  for (const name of names) {
    const def = OPT[name];
    const flags = `--${camelToKebab(name)}${def.arg !== undefined ? ` <${def.arg}>` : ''}`;
    if (def.repeatable === true) cmd.option(flags, def.description, collect, []);
    else cmd.option(flags, def.description);
  }
}

/** Parse commander's loosely-typed opts into StandardOpts, failing with a clean one-line message
 *  (not zod's raw issue dump) — the CLI's errors are read by Claude mid-task. */
export function parseStandardOpts(raw: unknown): StandardOpts {
  const result = StandardOptsSchema.safeParse(raw);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path[0];
  const flag = typeof field === 'string' ? `--${camelToKebab(field)}` : 'option';
  errExit(2, `invalid ${flag}: ${issue?.message ?? 'bad value'}`);
}

/** Build the propose/counter concurrency guard from the standard opts —
 *  `--expected-rev` / `--expected-new` / `--force`. */
export function concurrencyFromOpts(opts: StandardOpts): ProposeOptionsWire {
  if (opts.expectedNew === true && opts.expectedRev !== undefined) {
    errExit(2, 'pass at most one of --expected-new or --expected-rev');
  }
  const out: ProposeOptionsWire = {};
  if (opts.expectedNew === true) out.expectedVersion = 'new';
  else if (opts.expectedRev !== undefined) out.expectedVersion = opts.expectedRev;
  if (opts.force === true) {
    if (out.expectedVersion !== undefined) {
      errExit(2, '--force is meaningless with --expected-* (the assertion already governs racing)');
    }
    out.force = true;
  }
  return out;
}
