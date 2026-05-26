// `accept` — take the latest proposed version of an artifact (peer-only). Target resolution (single
// vs --target batch, and all the arg validation) happens in make-verb; this handler just runs the
// capability for whichever target it's handed. The batch path is ATOMIC: `accept.many` accepts the
// whole set in one server transaction, so it either returns every accepted version or rejects with
// nothing accepted — there's no partial state to report. The lone guard is batch run-support
// (`accept.many`), which the generic resolver can't see.

import { emit, emitJson } from '../../common.js';
import { requireMany } from '../guards.js';
import { makeVerb } from '../make-verb.js';
import type { Capability, VerbContext } from '../types.js';

export const acceptVerb = makeVerb({
  verb: 'accept',
  arity: 'one-or-many',
  summary: 'accept the latest proposed version (peer-only)',
  options: ['rev', 'rationale', 'json', 'target', 'includeDependencies'],
  async handle<Id, V>(ctx: VerbContext<Id, V>, accept: Capability<'accept', Id, V>): Promise<void> {
    const { client, doc, descriptor, target, opts } = ctx;

    // The batch path also serves a single target when --include-dependencies is set (a batch of one
    // whose $ref-closure gets pulled in). For non-batchable nouns (convention) the flag is a no-op —
    // there's nothing to depend on — so fall through to the single accept.
    const wantDeps = opts.includeDependencies === true;
    if (target.mode === 'batch' || (wantDeps && accept.many !== undefined)) {
      const ids = target.mode === 'batch' ? target.ids : [target.id];
      const run = requireMany(accept.many, descriptor.noun);
      const res = await run(client, doc, ids, opts.rationale, { includeDependencies: wantDeps }); // throws ⇒ nothing accepted
      if (opts.json === true) {
        emitJson(res);
        return;
      }
      for (const v of res.accepted) emit(`accepted ${descriptor.render(v)}`);
      if (res.dependencies.length > 0) {
        emit(
          `  + ${res.dependencies.length} dependency(ies) accepted in the same batch: ${res.dependencies.join(', ')}`,
        );
      }
      return;
    }

    const v = await accept.one(client, doc, target.id, opts.rev, opts.rationale);
    if (opts.json === true) emitJson(v);
    else emit(`accepted ${descriptor.render(v)}`);
  },
});
