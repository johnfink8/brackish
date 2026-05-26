// `show` — display an artifact, tagged by status (accepted and/or proposed, with body). The noun's
// capability does the fetch + tagged render (rendering is over the concrete artifact union); this
// handler just emits — metadata to stderr, spec body to stdout (so a redirect captures only YAML).

import { emitJson, emitShow, errExit } from '../../common.js';
import { requireSingle } from '../guards.js';
import { makeVerb } from '../make-verb.js';
import type { Capability, VerbContext } from '../types.js';

export const showVerb = makeVerb({
  verb: 'show',
  arity: 'one',
  summary: 'show an artifact, tagged by status (accepted and/or proposed, with body)',
  options: ['full', 'json'],
  async handle<Id, V>(ctx: VerbContext<Id, V>, show: Capability<'show', Id, V>): Promise<void> {
    const { client, doc, descriptor, target, opts } = ctx;
    const id = requireSingle(target);
    const result = await show(client, doc, id);
    if (result === null) {
      errExit(1, `artifact_not_found: no ${descriptor.describeIdentity(id)} in ${doc}`);
    }
    if (opts.json === true) emitJson(result.json);
    else emitShow({ meta: result.meta, body: result.body });
  },
});
