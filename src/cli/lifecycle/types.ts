// Shared shapes for the lifecycle tables. Applicability is STRUCTURAL: a noun lists, in
// `capabilities`, an adapter for each verb it supports; a verb's name IS the capability it consumes;
// a cell registers iff the noun provides it. Identity reading lives on the noun (`parseIdentity` /
// `parseRefs`); `make-verb` resolves a validated `Target` from it BEFORE a verb's handler runs, so
// handlers receive an already-decided single-or-batch target and do no parsing.

import type { Command } from 'commander';
import type { BrackishClient, ProposeOptionsWire } from '../../client/client.js';
import type { LintResult } from '../../lib/lint.js';
import type {
  ConventionArtifact,
  ConventionSpec,
  DiffResponse,
  DocumentName,
  JSONSchema,
  OperationArtifact,
  OperationSpec,
  SchemaArtifact,
} from '../../lib/models.js';
import type { OptName, StandardOpts } from './options.js';

/** What a verb operates on, resolved + validated before its handler runs. */
export type Target<Id> =
  | { readonly mode: 'single'; readonly id: Id }
  | { readonly mode: 'batch'; readonly ids: Id[] };

/** The closed set of artifact kinds. (No source to derive from, unlike CapabilityKey ← capabilities,
 *  so it's a small hand-maintained union — the canonical noun vocabulary.) */
type NounName = 'endpoint' | 'schema' | 'convention' | 'retraction';

/** How many artifacts a verb addresses. (Doc-level verbs like `list` get their own shape later.) */
export type VerbArity = 'one' | 'one-or-many';

/** The three spec-bearing artifact kinds, and their specs — used by the read verbs (show/diff),
 *  whose rendering is inherently over the concrete artifact union, not a generic V. */
export type ShowArtifact = OperationArtifact | SchemaArtifact | ConventionArtifact;
type ArtifactSpec = OperationSpec | JSONSchema | ConventionSpec;

/** What a `show` produces: the accepted/proposed pair (for --json) plus its tagged rendering. */
export type ShowResult = {
  json: {
    accepted: ShowArtifact | null;
    proposed: ShowArtifact | null;
    deltaVsAccepted: string | null;
  };
  meta: string;
  body: string;
};

// One entry per verb. Each flattens the bespoke client API to a uniform (doc, Id, …) shape; a noun
// implements only the ones it supports (e.g. retraction will omit `diff`). A capability is a bare
// method when single-shot, or a bundle when it has modes — `accept` bundles single (`one`) and an
// optional batch runner (`many`); the batch identity parsing lives on the descriptor (`parseRefs`).
interface NounCapabilities<Id, V> {
  accept?: {
    one(
      client: BrackishClient,
      doc: DocumentName,
      id: Id,
      rev: number | undefined,
      rationale: string | undefined,
    ): Promise<V>;
    // Atomic: the server accepts the whole set in one transaction (all-or-nothing). On any failure
    // it rejects and nothing is accepted. `opts.includeDependencies` also accepts the targets'
    // still-proposed $ref-closure in the same batch; `dependencies` lists those auto-included
    // artifacts (human labels) so the handler can report them. `accepted` is the named set.
    many?(
      client: BrackishClient,
      doc: DocumentName,
      ids: Id[],
      rationale: string | undefined,
      opts: { includeDependencies?: boolean },
    ): Promise<{ accepted: V[]; dependencies: string[] }>;
  };
  reject?(
    client: BrackishClient,
    doc: DocumentName,
    id: Id,
    reason: string,
    rev: number | undefined,
  ): Promise<V>;
  withdraw?(client: BrackishClient, doc: DocumentName, id: Id, rev: number | undefined): Promise<V>;
  // `show` fetches the accepted/proposed pair and renders it (rendering is over the concrete
  // artifact union, so the noun does it and returns the ready ShowResult).
  show?(client: BrackishClient, doc: DocumentName, id: Id): Promise<ShowResult | null>;
  diff?: {
    compute(
      client: BrackishClient,
      doc: DocumentName,
      id: Id,
      range: { from?: number; to?: number },
    ): Promise<DiffResponse>;
    getVersionSpec(
      client: BrackishClient,
      doc: DocumentName,
      id: Id,
      version: number,
    ): Promise<ArtifactSpec>;
  };
  // propose is file-only (the noun loads + parses its own spec schema, then sends).
  propose?(
    client: BrackishClient,
    doc: DocumentName,
    id: Id,
    file: string,
    concurrency: ProposeOptionsWire,
  ): Promise<V>;
  // counter = reject-current-proposed + propose-replacement, atomic. File-based like propose, plus
  // the reject `reason`. Returns the new proposed version.
  counter?(
    client: BrackishClient,
    doc: DocumentName,
    id: Id,
    file: string,
    reason: string,
    concurrency: ProposeOptionsWire,
  ): Promise<V>;
  // `list` is doc-level (no identity), registered off make-verb; returns the rendered roster + a
  // --json payload serialized as-is (hence unknown).
  list?(
    client: BrackishClient,
    doc: DocumentName,
    opts: { all?: boolean },
  ): Promise<{ json: unknown; text: string }>;
  // `lint` is purely local (no client/doc): given the parsed identity it returns a validator for
  // file data. `data: unknown` mirrors lintEndpointSpec/lintSchemaSpec.
  lint?(id: Id): (data: unknown) => LintResult;
  // hold?, counter? — added with each verb.
}

/** The capability names a verb may require. Derived from NounCapabilities (keys are independent of
 *  Id/V, so the `never` placeholders are inert) so it can never drift from the actual adapter set. */
export type CapabilityKey = keyof NounCapabilities<never, never>;

/** A capability, narrowed to present (non-optional) — what a verb handler receives. */
export type Capability<K extends CapabilityKey, Id, V> = NonNullable<NounCapabilities<Id, V>[K]>;

export interface NounDescriptor<Id, V> {
  readonly noun: NounName;
  readonly identityArgs: readonly string[]; // identity arg names; make-verb renders the [..] syntax
  parseIdentity(operands: string[]): Id; // one identity from positional args
  parseRefs?(refs: readonly string[]): Id[]; // batch refs from --target; presence ⇒ noun is batchable
  describeIdentity(id: Id): string;
  render(version: V): string;
  readonly capabilities: NounCapabilities<Id, V>;
}

export interface VerbContext<Id, V> {
  readonly client: BrackishClient;
  readonly doc: DocumentName;
  readonly descriptor: NounDescriptor<Id, V>;
  readonly target: Target<Id>; // resolved + validated by make-verb
  readonly opts: StandardOpts;
}

export interface VerbSpec<K extends CapabilityKey> {
  // The command name AND the capability it consumes — for a lifecycle verb these are one concept,
  // so `verb` doubles as the capability key (typed: it must name a real NounCapabilities entry).
  readonly verb: K;
  readonly arity: VerbArity; // how make-verb resolves the target before handle
  readonly summary: string;
  readonly options: readonly OptName[];
  handle<Id, V>(ctx: VerbContext<Id, V>, capability: Capability<K, Id, V>): Promise<void>;
  // Run once, when make-verb first creates this verb's parent command, to hang verb-wide options +
  // a no-noun action on it (e.g. `propose --manifest`). Optional; most verbs don't need it.
  configureParent?(parent: Command): void;
}
