// Schema (JSON Schema component) noun descriptor. Identity is a single name; batch refs are names,
// so parseRefs is a pass-through. Supports a verb iff its capability appears in `capabilities`.

import { lintSchemaSpec } from '../../../lib/lint.js';
import { JSONSchemaSchema, type SchemaArtifact } from '../../../lib/models.js';
import { loadSpecFile } from '../../../lib/specfile.js';
import { describeSchema, formatSchemaSummaries } from '../../../render/output.js';
import { errExit } from '../../common.js';
import { fetchTaggedShow } from '../read.js';
import type { NounDescriptor } from '../types.js';

export const schemaDescriptor: NounDescriptor<string, SchemaArtifact> = {
  noun: 'schema',
  identityArgs: ['name'],
  parseIdentity(operands) {
    const name = operands[0];
    if (name === undefined) errExit(2, 'schema: provide <name> (or --target for batch)');
    return name;
  },
  parseRefs: (refs) => [...refs],
  describeIdentity: (name) => `schema ${name}`,
  render: describeSchema,
  capabilities: {
    accept: {
      one: (client, doc, name, rev, rationale) => client.acceptSchema(doc, name, rev, rationale),
      many: (client, doc, names, rationale, opts) =>
        client.batchAcceptSchemas(doc, names, rationale, opts.includeDependencies),
    },
    reject: (client, doc, name, reason, rev) => client.rejectSchema(doc, name, reason, rev),
    withdraw: (client, doc, name, rev) => client.withdrawSchema(doc, name, rev),
    show: (client, doc, name) =>
      fetchTaggedShow(
        `schema ${name}`,
        () => client.getSchema(doc, name),
        () => client.getSchema(doc, name, { proposed: true }),
      ),
    diff: {
      compute: (client, doc, name, range) => client.diffSchema(doc, name, range),
      getVersionSpec: (client, doc, name, version) =>
        client.getSchema(doc, name, { version }).then((a) => a.spec),
    },
    propose: (client, doc, name, file, concurrency) =>
      client.proposeSchema(doc, name, loadSpecFile(file, JSONSchemaSchema), concurrency),
    counter: (client, doc, name, file, reason, concurrency) =>
      client.counterSchema(doc, name, loadSpecFile(file, JSONSchemaSchema), reason, concurrency),
    list: async (client, doc) => {
      const schemas = await client.listSchemas(doc);
      return { json: { schemas }, text: formatSchemaSummaries(schemas) };
    },
    lint: (name) => (data) => lintSchemaSpec(name, data),
  },
};
