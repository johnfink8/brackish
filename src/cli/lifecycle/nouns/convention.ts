// Convention (document-level Info/Servers/SecuritySchemes) noun descriptor. It's a singleton per
// document — no identity args, not batchable — so its Id is the unit `null`.

import { type ConventionArtifact, ConventionSpecSchema } from '../../../lib/models.js';
import { loadSpecFile } from '../../../lib/specfile.js';
import { describeConvention } from '../../../render/output.js';
import { fetchTaggedShow } from '../read.js';
import type { NounDescriptor } from '../types.js';

export const conventionDescriptor: NounDescriptor<null, ConventionArtifact> = {
  noun: 'convention',
  identityArgs: [],
  parseIdentity: () => null,
  describeIdentity: () => 'convention',
  render: describeConvention,
  capabilities: {
    accept: {
      one: (client, doc, _id, rev, rationale) => client.acceptConvention(doc, rev, rationale),
    },
    reject: (client, doc, _id, reason, rev) => client.rejectConvention(doc, reason, rev),
    withdraw: (client, doc, _id, rev) => client.withdrawConvention(doc, rev),
    show: (client, doc) =>
      fetchTaggedShow(
        'convention',
        () => client.getConventionCurrent(doc),
        () => client.getConventionProposed(doc),
      ),
    diff: {
      compute: (client, doc, _id, range) => client.diffConvention(doc, range),
      getVersionSpec: (client, doc, _id, version) =>
        client.getConventionByVersion(doc, version).then((a) => a.spec),
    },
    propose: (client, doc, _id, file, concurrency) =>
      client.proposeConvention(doc, loadSpecFile(file, ConventionSpecSchema), concurrency),
    counter: (client, doc, _id, file, reason, concurrency) =>
      client.counterConvention(doc, loadSpecFile(file, ConventionSpecSchema), reason, concurrency),
  },
};
