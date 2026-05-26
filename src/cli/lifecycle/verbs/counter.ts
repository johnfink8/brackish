// `counter` — reject the current proposed version AND propose a replacement, atomically (peer-only).
// The replacement spec comes from `--file` (parsed by the noun, like propose); `--rationale` is the
// reject reason and is required. One server transaction: either both land or neither does, so you
// never end up rejected-with-no-counter. Distinct from a bare `reject` so the move reads as a
// counter, not a refusal.

import { emit, emitJson } from '../../common.js';
import { requireFile, requireReason, requireSingle } from '../guards.js';
import { makeVerb } from '../make-verb.js';
import { concurrencyFromOpts } from '../options.js';
import type { Capability, VerbContext } from '../types.js';

export const counterVerb = makeVerb({
  verb: 'counter',
  arity: 'one',
  summary:
    'reject the current proposed version + propose a replacement from --file, atomically (peer-only)',
  options: ['file', 'rationale', 'expectedRev', 'force', 'json'],
  async handle<Id, V>(
    ctx: VerbContext<Id, V>,
    counter: Capability<'counter', Id, V>,
  ): Promise<void> {
    const { client, doc, descriptor, target, opts } = ctx;
    const id = requireSingle(target);
    const file = requireFile(opts.file);
    const reason = requireReason(opts.rationale);
    const v = await counter(client, doc, id, file, reason, concurrencyFromOpts(opts));
    if (opts.json === true) emitJson(v);
    else emit(`countered ${descriptor.render(v)}\n  → prior proposal rejected: ${reason}`);
  },
});
