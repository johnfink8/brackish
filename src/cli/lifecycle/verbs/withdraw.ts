// `withdraw` — take back your own still-proposed version (only the proposer can withdraw). Single
// only.

import { emit, emitJson } from '../../common.js';
import { requireSingle } from '../guards.js';
import { makeVerb } from '../make-verb.js';
import type { Capability, VerbContext } from '../types.js';

export const withdrawVerb = makeVerb({
  verb: 'withdraw',
  arity: 'one',
  summary: 'take back your own still-proposed version (only the proposer can withdraw)',
  options: ['rev', 'json'],
  async handle<Id, V>(
    ctx: VerbContext<Id, V>,
    withdraw: Capability<'withdraw', Id, V>,
  ): Promise<void> {
    const { client, doc, descriptor, target, opts } = ctx;
    const id = requireSingle(target);
    const v = await withdraw(client, doc, id, opts.rev);
    if (opts.json === true) emitJson(v);
    else emit(`withdrew ${descriptor.render(v)}`);
  },
});
