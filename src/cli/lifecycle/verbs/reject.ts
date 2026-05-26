// `reject` — reject the latest proposed version of an artifact (peer-only). Single only; a reason is
// required (rides on the event so the peer sees why). Target resolution + reason are guards.

import { emit, emitJson } from '../../common.js';
import { requireReason, requireSingle } from '../guards.js';
import { makeVerb } from '../make-verb.js';
import type { Capability, VerbContext } from '../types.js';

export const rejectVerb = makeVerb({
  verb: 'reject',
  arity: 'one',
  summary: 'reject the latest proposed version (peer-only); a reason is required',
  options: ['rev', 'rationale', 'json'],
  async handle<Id, V>(ctx: VerbContext<Id, V>, reject: Capability<'reject', Id, V>): Promise<void> {
    const { client, doc, descriptor, target, opts } = ctx;
    const id = requireSingle(target);
    const reason = requireReason(opts.rationale);
    const v = await reject(client, doc, id, reason, opts.rev);
    if (opts.json === true) emitJson(v);
    else emit(`rejected ${descriptor.render(v)}`);
  },
});
