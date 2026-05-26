// Endpoint (OpenAPI Operation) noun descriptor. Identity is two tokens (METHOD + path); its batch
// refs are METHOD:PATH (a single variadic positional can't pair them, hence the --target selector).
// It supports a verb iff that verb's capability appears in `capabilities` below.

import type { EndpointTarget } from '../../../client/batch.js';
import { lintEndpointSpec } from '../../../lib/lint.js';
import {
  HttpMethodSchema,
  type OperationArtifact,
  OperationSpecSchema,
} from '../../../lib/models.js';
import { loadSpecFile } from '../../../lib/specfile.js';
import { describeOperation, formatEndpointSummaries } from '../../../render/output.js';
import { errExit } from '../../common.js';
import { fetchTaggedShow } from '../read.js';
import type { NounDescriptor } from '../types.js';

export const endpointDescriptor: NounDescriptor<EndpointTarget, OperationArtifact> = {
  noun: 'endpoint',
  identityArgs: ['method', 'path'],
  parseIdentity(operands) {
    const methodRaw = operands[0];
    const path = operands[1];
    if (methodRaw === undefined || path === undefined) {
      errExit(2, 'endpoint: provide <method> <path> (or --target for batch)');
    }
    return { method: HttpMethodSchema.parse(methodRaw.toLowerCase()), path };
  },
  parseRefs: (refs) =>
    refs.map((tok) => {
      const colon = tok.indexOf(':');
      if (colon < 1) errExit(2, `--target "${tok}": expected METHOD:PATH (e.g. GET:/users/{id})`);
      return {
        method: HttpMethodSchema.parse(tok.slice(0, colon).toLowerCase()),
        path: tok.slice(colon + 1),
      };
    }),
  describeIdentity: (id) => `${id.method.toUpperCase()} ${id.path}`,
  render: describeOperation,
  capabilities: {
    accept: {
      one: (client, doc, id, rev, rationale) =>
        client.acceptEndpoint(doc, id.method, id.path, rev, rationale),
      many: (client, doc, ids, rationale, opts) =>
        client.batchAcceptEndpoints(doc, ids, rationale, opts.includeDependencies),
    },
    reject: (client, doc, id, reason, rev) =>
      client.rejectEndpoint(doc, id.method, id.path, reason, rev),
    withdraw: (client, doc, id, rev) => client.withdrawEndpoint(doc, id.method, id.path, rev),
    show: (client, doc, id) =>
      fetchTaggedShow(
        `endpoint ${id.method.toUpperCase()} ${id.path}`,
        () => client.getEndpoint(doc, id.method, id.path),
        () => client.getEndpoint(doc, id.method, id.path, { proposed: true }),
      ),
    diff: {
      compute: (client, doc, id, range) => client.diffEndpoint(doc, id.method, id.path, range),
      getVersionSpec: (client, doc, id, version) =>
        client.getEndpoint(doc, id.method, id.path, { version }).then((a) => a.spec),
    },
    propose: (client, doc, id, file, concurrency) =>
      client.proposeEndpoint(
        doc,
        id.method,
        id.path,
        loadSpecFile(file, OperationSpecSchema),
        concurrency,
      ),
    counter: (client, doc, id, file, reason, concurrency) =>
      client.counterEndpoint(
        doc,
        id.method,
        id.path,
        loadSpecFile(file, OperationSpecSchema),
        reason,
        concurrency,
      ),
    list: async (client, doc) => {
      const endpoints = await client.listEndpoints(doc);
      return { json: { endpoints }, text: formatEndpointSummaries(endpoints) };
    },
    lint: (id) => (data) => lintEndpointSpec(id.method, id.path, data),
  },
};
