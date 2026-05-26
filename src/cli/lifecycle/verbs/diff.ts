// `diff` — JSON Patch between two versions (defaults prev → latest); `--format` selects the output
// (patch | yaml | json | rendered). `rendered` fetches both versions' specs for a side-by-side YAML.

import { emitDiff, emitRenderedDiff } from '../../common.js';
import { requireSingle } from '../guards.js';
import { makeVerb } from '../make-verb.js';
import type { Capability, VerbContext } from '../types.js';

export const diffVerb = makeVerb({
  verb: 'diff',
  arity: 'one',
  summary: 'JSON Patch between two versions (defaults prev → latest); see --format',
  options: ['from', 'to', 'format'],
  async handle<Id, V>(ctx: VerbContext<Id, V>, diff: Capability<'diff', Id, V>): Promise<void> {
    const { client, doc, target, opts } = ctx;
    const id = requireSingle(target);
    const range = {
      ...(opts.from !== undefined ? { from: opts.from } : {}),
      ...(opts.to !== undefined ? { to: opts.to } : {}),
    };
    const d = await diff.compute(client, doc, id, range);
    if (opts.format === 'rendered') {
      const [from, to] = await Promise.all([
        diff.getVersionSpec(client, doc, id, d.fromVersion),
        diff.getVersionSpec(client, doc, id, d.toVersion),
      ]);
      emitRenderedDiff(from, to, d.fromVersion, d.toVersion);
      return;
    }
    emitDiff(d, opts.format ?? 'patch');
  },
});
