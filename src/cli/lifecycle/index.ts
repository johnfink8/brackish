// Lifecycle registry: applies every verb registrar to every noun descriptor. Each registrar
// registers a `<verb> <noun>` leaf iff the noun provides that verb's capability (see make-verb).
// Commander parses + dispatches; this only wires the tree. To add a verb: drop a file in verbs/ and
// list it in VERB_REGISTRARS. To add a noun: drop a file in nouns/ and add a registerNoun line.

import type { Command } from 'commander';
import type { VerbRegistrar } from './make-verb.js';
import { conventionDescriptor } from './nouns/convention.js';
import { endpointDescriptor } from './nouns/endpoint.js';
import { retractionDescriptor } from './nouns/retraction.js';
import { schemaDescriptor } from './nouns/schema.js';
import type { NounDescriptor } from './types.js';
import { acceptVerb } from './verbs/accept.js';
import { counterVerb } from './verbs/counter.js';
import { diffVerb } from './verbs/diff.js';
import { lintVerb } from './verbs/lint.js';
import { listVerb } from './verbs/list.js';
import { proposeVerb } from './verbs/propose.js';
import { proposeRetractionVerb } from './verbs/propose-retraction.js';
import { rejectVerb } from './verbs/reject.js';
import { showVerb } from './verbs/show.js';
import { withdrawVerb } from './verbs/withdraw.js';

const VERB_REGISTRARS: readonly VerbRegistrar[] = [
  proposeVerb,
  proposeRetractionVerb,
  acceptVerb,
  counterVerb,
  rejectVerb,
  withdrawVerb,
  showVerb,
  diffVerb,
  listVerb,
  lintVerb,
];

/** Apply every verb registrar to one concrete descriptor. Monomorphic per call (Id/V fixed), so no
 *  heterogeneous descriptor array and no `as`. */
function registerNoun<Id, V>(
  program: Command,
  verbCommands: Map<string, Command>,
  d: NounDescriptor<Id, V>,
): void {
  for (const register of VERB_REGISTRARS) register(program, verbCommands, d);
}

export function registerLifecycle(program: Command): void {
  // Verb parent commands are created lazily by the first registrar that needs them, keyed here so
  // they're shared across nouns (verb-first: `accept endpoint`, `accept schema`).
  const verbCommands = new Map<string, Command>();
  registerNoun(program, verbCommands, endpointDescriptor);
  registerNoun(program, verbCommands, schemaDescriptor);
  registerNoun(program, verbCommands, conventionDescriptor);
  registerNoun(program, verbCommands, retractionDescriptor);
}
