// `lint` — validate a local YAML/JSON spec file before proposing. Purely local: no daemon, no doc,
// no `withClient` — so it's a hand-written VerbRegistrar. The identity (e.g. method/path) is
// required here and the file is the last positional. Registers only for nouns that provide `lint`.

import type { Command } from 'commander';
import { parseSpecFile } from '../../../lib/specfile.js';
import { errExit, finalizeLint } from '../../common.js';
import type { VerbRegistrar } from '../make-verb.js';
import { applyOptions, parseStandardOpts } from '../options.js';
import type { NounDescriptor } from '../types.js';

export const lintVerb: VerbRegistrar = <Id, V>(
  program: Command,
  verbCommands: Map<string, Command>,
  d: NounDescriptor<Id, V>,
) => {
  const lint = d.capabilities.lint;
  if (lint === undefined) return;
  let parent = verbCommands.get('lint');
  if (parent === undefined) {
    parent = program
      .command('lint')
      .description('check a local YAML/JSON spec file before proposing');
    verbCommands.set('lint', parent);
  }
  // Identity is required for lint (you lint a specific artifact's file), then the file itself.
  const identity = d.identityArgs.map((name) => `<${name}>`).join(' ');
  const sig = identity.length > 0 ? `${d.noun} ${identity} <file>` : `${d.noun} <file>`;
  const leaf = parent.command(sig).description(`lint a ${d.noun} spec file — ${d.noun}`);
  applyOptions(leaf, ['json', 'strict']);
  leaf.action(async () => {
    const opts = parseStandardOpts(leaf.opts());
    const args = leaf.args;
    const file = args[args.length - 1];
    if (file === undefined) errExit(2, `lint ${d.noun}: <file> is required`);
    const id = d.parseIdentity(args.slice(0, -1));
    await finalizeLint(parseSpecFile(file), lint(id), {
      json: opts.json === true,
      strict: opts.strict === true,
    });
  });
};
