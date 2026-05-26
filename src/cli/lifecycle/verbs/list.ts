// `list` — enumerate a noun's artifacts in a document. Doc-level (no identity), so it's a
// hand-written VerbRegistrar rather than a make-verb verb: resolve the doc, call the noun's `list`
// capability (which fetches + renders), emit. Registers only for nouns that provide `list`.

import type { Command } from 'commander';
import { emit, emitJson, resolveDoc, withClient } from '../../common.js';
import type { VerbRegistrar } from '../make-verb.js';
import { applyOptions, parseStandardOpts } from '../options.js';
import type { NounDescriptor } from '../types.js';

export const listVerb: VerbRegistrar = <Id, V>(
  program: Command,
  verbCommands: Map<string, Command>,
  d: NounDescriptor<Id, V>,
) => {
  const list = d.capabilities.list;
  if (list === undefined) return;
  let parent = verbCommands.get('list');
  if (parent === undefined) {
    parent = program.command('list').description('list a kind of artifact in a document');
    verbCommands.set('list', parent);
  }
  const leaf = parent.command(d.noun).description(`list ${d.noun}s — ${d.noun}`);
  applyOptions(leaf, ['doc', 'all', 'json']);
  leaf.action(async () => {
    const opts = parseStandardOpts(leaf.opts());
    await withClient(async (client) => {
      const doc = await resolveDoc(client, opts.doc);
      const result = await list(client, doc, { all: opts.all === true });
      if (opts.json === true) emitJson(result.json);
      else emit(result.text);
    });
  });
};
