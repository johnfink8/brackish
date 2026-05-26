// makeVerb turns a VerbSpec<K> into a VerbRegistrar — a function applied to each noun that registers
// a `<verb> <noun>` leaf iff the noun provides the verb's required capability. The capability key K
// is captured in the returned closure, so a list of registrars is homogeneous (VerbRegistrar[]);
// that's what sidesteps TS's correlated-union limit and lets the handler call the narrowed
// capability with no `as`.
//
// The document is NOT a positional — it's the `--doc` option, defaulting to the sole document
// (`resolveDoc`), since a session is virtually always one contract. Before handle runs,
// `resolveTarget` turns the identity positionals (+ --target) into a validated single/batch
// `Target`, so handlers receive an already-decided doc + target and do no parsing.

import type { Command } from 'commander';
import { errExit, resolveDoc, withClient } from '../common.js';
import { applyOptions, parseStandardOpts, type StandardOpts } from './options.js';
import type { CapabilityKey, NounDescriptor, Target, VerbArity, VerbSpec } from './types.js';

export type VerbRegistrar = <Id, V>(
  program: Command,
  verbCommands: Map<string, Command>,
  d: NounDescriptor<Id, V>,
) => void;

/** Resolve + validate what a verb operates on, generically (descriptor-level parsing only). The one
 *  thing it can't check is whether a verb's capability provides a batch runner (`many`) — that's
 *  capability-level, opaque here — so a batch handler still guards on it. */
function resolveTarget<Id, V>(
  d: NounDescriptor<Id, V>,
  arity: VerbArity,
  operands: string[],
  opts: StandardOpts,
): Target<Id> {
  const refs = opts.target ?? [];
  if (refs.length > 0) {
    if (arity !== 'one-or-many')
      errExit(2, `${d.noun}: this verb takes a single <identity>, not --target`);
    if (d.parseRefs === undefined) errExit(2, `${d.noun}: this kind can't be batched`);
    if (operands.length > 0) errExit(2, `${d.noun}: pass <identity> OR --target, not both`);
    if (opts.rev !== undefined) errExit(2, '--rev pins a single target; drop it for batch');
    return { mode: 'batch', ids: d.parseRefs(refs) };
  }
  return { mode: 'single', id: d.parseIdentity(operands) };
}

export function makeVerb<K extends CapabilityKey>(spec: VerbSpec<K>): VerbRegistrar {
  return <Id, V>(
    program: Command,
    verbCommands: Map<string, Command>,
    d: NounDescriptor<Id, V>,
  ) => {
    const capability = d.capabilities[spec.verb];
    if (capability === undefined) return; // noun doesn't support this verb → no cell
    let parent = verbCommands.get(spec.verb);
    if (parent === undefined) {
      parent = program.command(spec.verb).description(spec.summary);
      spec.configureParent?.(parent);
      verbCommands.set(spec.verb, parent);
    }
    const positional = d.identityArgs.map((name) => `[${name}]`).join(' ');
    const sig = positional.length > 0 ? `${d.noun} ${positional}` : d.noun;
    const leaf = parent.command(sig).description(`${spec.summary} — ${d.noun}`);
    applyOptions(leaf, spec.options);
    applyOptions(leaf, ['doc']); // every lifecycle verb is doc-scoped
    leaf.action(async () => {
      const opts = parseStandardOpts(leaf.opts());
      const target = resolveTarget(d, spec.arity, leaf.args, opts);
      await withClient(async (client) => {
        const doc = await resolveDoc(client, opts.doc);
        await spec.handle({ client, doc, descriptor: d, target, opts }, capability);
      });
    });
  };
}
