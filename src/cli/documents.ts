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
            `created document "${t.name}" by ${t.createdBy}\n  → next: brackish convention propose ${t.name}   # set doc-level defaults (info, security, naming) before schemas/endpoints`,
          );
      }),
    );
}
