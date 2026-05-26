// Retraction (negotiated removal) noun descriptor. Identity is a numeric id; not versioned and not
// batchable, so no `parseRefs`, no `rev`. The client returns a { retraction } envelope which the
// adapters unwrap to the Retraction itself (so V is uniform with the other nouns' artifacts).

import type { Retraction, RetractionTarget } from '../../../lib/models.js';
import { errExit } from '../../common.js';
import type { NounDescriptor } from '../types.js';

function describeTarget(t: RetractionTarget): string {
  if (t.kind === 'endpoint') return `${t.method.toUpperCase()} ${t.path}`;
  if (t.kind === 'schema') return `schema ${t.name}`;
  return 'convention';
}

function formatRetraction(r: Retraction): string {
  const what = r.targets.map(describeTarget).join(', ');
  const reason = r.reason ? ` — "${r.reason}"` : '';
  return `#${r.id}  [${r.status}]  by ${r.proposedBy}  remove ${what}${reason}`;
}

export const retractionDescriptor: NounDescriptor<number, Retraction> = {
  noun: 'retraction',
  identityArgs: ['id'],
  parseIdentity(operands) {
    const raw = operands[0];
    if (raw === undefined) errExit(2, 'retraction: provide <id>');
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) errExit(2, `invalid retraction id: ${raw}`);
    return n;
  },
  describeIdentity: (id) => `retraction #${id}`,
  render: formatRetraction,
  capabilities: {
    accept: {
      one: (client, doc, id) => client.acceptRetraction(doc, id).then((r) => r.retraction),
    },
    reject: (client, doc, id, reason) =>
      client.rejectRetraction(doc, id, reason).then((r) => r.retraction),
    withdraw: (client, doc, id) => client.withdrawRetraction(doc, id).then((r) => r.retraction),
    list: async (client, doc, opts) => {
      const res = await client.listRetractions(
        doc,
        opts.all === true ? {} : { status: 'proposed' },
      );
      const text =
        res.retractions.length > 0
          ? res.retractions.map(formatRetraction).join('\n')
          : opts.all === true
            ? '(no retractions)'
            : '(no pending retractions)';
      return { json: res, text };
    },
  },
};
