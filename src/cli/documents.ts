// Document CRUD: `documents` (alias `docs`) + `doc new`.

import type { Command } from 'commander';
import { formatDocuments } from '../render/output.js';
import { emit, emitJson, withClient } from './common.js';

export function register(program: Command): void {
  program
    .command('documents')
    .aliases(['docs'])
    .description('list documents')
    .option('--json', 'output JSON')
    .action(async (opts: { json?: boolean }) =>
      withClient(async (client) => {
        const documents = await client.listDocuments();
        if (opts.json) emitJson({ documents });
        else emit(formatDocuments(documents));
      }),
    );

  const document = program.command('doc').description('document management');
  document
    .command('new <name>')
    .description('create a new document')
    .option('--json', 'output JSON')
    .action(async (name: string, opts: { json?: boolean }) =>
      withClient(async (client) => {
        const t = await client.createDocument(name);
        if (opts.json) emitJson(t);
        else
          emit(
            `created document "${t.name}" by ${t.createdBy}\n  → next: brackish propose convention --doc ${t.name} --file <convention.yaml>   # set doc-level defaults (info, security, naming) before schemas/endpoints`,
          );
      }),
    );

  document
    .command('grant <doc> <identity>')
    .description('add <identity> as a member of <doc> (peer-trust on socket; owner-only on TCP)')
    .option('--owner', 'grant owner role instead of plain member')
    .action(async (doc: string, identity: string, opts: { owner?: boolean }) =>
      withClient(async (client) => {
        await client.addMember(doc, identity, opts.owner ? 'owner' : 'member');
        emit(`granted ${identity} ${opts.owner ? 'owner' : 'member'} on ${doc}`);
      }),
    );

  document
    .command('revoke <doc> <identity>')
    .description('remove <identity> from <doc>')
    .action(async (doc: string, identity: string) =>
      withClient(async (client) => {
        await client.removeMember(doc, identity);
        emit(`revoked ${identity} from ${doc}`);
      }),
    );

  document
    .command('members <doc>')
    .description('list members of <doc>')
    .option('--json', 'output JSON')
    .action(async (doc: string, opts: { json?: boolean }) =>
      withClient(async (client) => {
        const members = await client.listMembers(doc);
        if (opts.json) emitJson({ members });
        else {
          const lines = members.map(
            (m) => `  ${m.identity.padEnd(20)} ${m.role.padEnd(8)} granted_by=${m.grantedBy}`,
          );
          emit(`members of ${doc}:\n${lines.join('\n') || '  (none)'}`);
        }
      }),
    );
}
