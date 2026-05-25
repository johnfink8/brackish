// Replay a real chat-app trial extract into the brackish daemon — the doc that lands in the
// browser UI when you run `brackish demo`. The move log under `./demo-data.json` is generated
// by `harness/extract-demo.ts` against a finished trial; regenerate it to refresh the seed.

import Database from 'better-sqlite3';
import { z } from 'zod';
import { BrackishClient } from './client/client.js';
import rawDemoData from './demo-data.json' with { type: 'json' };
import { type DemoData, DemoDataSchema, type DemoMove } from './lib/demo-data.js';
import { type DocumentName, DocumentNameSchema, type Identity } from './lib/models.js';

const ArtifactEventRefSchema = z.object({
  artifactKind: z.enum(['convention', 'schema', 'operation']),
  identityKey: z.string(),
  version: z.number().int().positive(),
});

const demoData: DemoData = DemoDataSchema.parse(rawDemoData);

export const DEFAULT_DEMO_DOCUMENT: DocumentName = demoData.document;

// The doc creator — used by `brackish demo` as the identity that mints the browser invite. Any
// party that ran during the seed would work; the creator just happens to be the natural pick.
const creator = demoData.moves.find((m) => m.t === 'create_document');
if (!creator) throw new Error('demo-data.json: no create_document move');
export const DEFAULT_DEMO_ADMIN: Identity = creator.actor;

export type SeedOptions = {
  socketPath: string;
  documentName?: DocumentName;
  // Moves to replay. Defaults to the bundled chat-app demo (`brackish demo`); callers like the
  // trial harness pass their own settled-contract seed instead.
  moves?: DemoMove[];
  // Path to the daemon's SQLite file. When provided, after the replay completes the seed
  // rewrites events.created_at + artifact_versions.{proposed,accepted,rejected}_at to the
  // original trial timestamps from the move log — so the sidebar's wall-clock gaps show the
  // real shape of the negotiation instead of all collapsing to seed-time.
  dataPath?: string;
  onStep?: (message: string) => void;
};

export async function seedDemo(opts: SeedOptions): Promise<{ documentName: DocumentName }> {
  const docName = DocumentNameSchema.parse(opts.documentName ?? demoData.document);
  const moves = opts.moves ?? demoData.moves;
  const step = opts.onStep ?? ((_m: string) => {});

  const clients = new Map<Identity, BrackishClient>();
  const clientFor = (actor: Identity): BrackishClient => {
    let c = clients.get(actor);
    if (!c) {
      c = new BrackishClient({ socketPath: opts.socketPath, identity: actor });
      clients.set(actor, c);
    }
    return c;
  };

  try {
    for (const move of moves) {
      await dispatch(move, clientFor(move.actor), docName, step);
    }
    // Events are held until their author delivers — a seeded doc should land fully delivered so
    // its history is visible in /ui and to both sides. Deliver each actor's events.
    for (const c of clients.values()) await c.deliver(docName);
  } finally {
    await Promise.all([...clients.values()].map((c) => c.close()));
  }

  if (opts.dataPath !== undefined) {
    step('rewriting timestamps to original trial wall-clock');
    patchTimestamps(opts.dataPath, docName, moves);
  }

  return { documentName: docName };
}

function patchTimestamps(dataPath: string, doc: DocumentName, moves: DemoMove[]): void {
  const db = new Database(dataPath);
  try {
    type EventRow = { id: number; kind: string; data: string };
    const events = db
      .prepare<[string], EventRow>(
        'select id, kind, data from events where document_name = ? order by id',
      )
      .all(doc);
    if (events.length !== moves.length) {
      throw new Error(
        `patch-timestamps: ${moves.length} moves but ${events.length} events for doc '${doc}'`,
      );
    }
    const updateEvent = db.prepare<[string, number]>(
      'update events set created_at = ? where id = ?',
    );
    const updateProposedAt = db.prepare<[string, string, string, string, number]>(
      'update artifact_versions set proposed_at = ? where document_name = ? and kind = ? and identity_key = ? and version = ?',
    );
    const updateAcceptedAt = db.prepare<[string, string, string, string, number]>(
      'update artifact_versions set accepted_at = ? where document_name = ? and kind = ? and identity_key = ? and version = ?',
    );
    const updateRejectedAt = db.prepare<[string, string, string, string, number]>(
      'update artifact_versions set rejected_at = ? where document_name = ? and kind = ? and identity_key = ? and version = ?',
    );

    db.transaction(() => {
      for (let i = 0; i < moves.length; i++) {
        const move = moves[i];
        const ev = events[i];
        if (!move || !ev) continue;
        const at = move.at;
        if (at === undefined) continue;
        updateEvent.run(at, ev.id);
        if (
          ev.kind === 'artifact_proposed' ||
          ev.kind === 'artifact_accepted' ||
          ev.kind === 'artifact_rejected'
        ) {
          const ref = ArtifactEventRefSchema.parse(JSON.parse(ev.data));
          const stmt =
            ev.kind === 'artifact_proposed'
              ? updateProposedAt
              : ev.kind === 'artifact_accepted'
                ? updateAcceptedAt
                : updateRejectedAt;
          stmt.run(at, doc, ref.artifactKind, ref.identityKey, ref.version);
        }
      }
    })();
  } finally {
    db.close();
  }
}

async function dispatch(
  move: DemoMove,
  client: BrackishClient,
  doc: DocumentName,
  step: (m: string) => void,
): Promise<void> {
  switch (move.t) {
    case 'create_document':
      step(`${move.actor} creates document ${doc}`);
      await client.createDocument(doc);
      return;
    case 'message':
      step(`${move.actor} message (${move.text.length} chars)`);
      await client.sendMessage(doc, move.text);
      return;
    case 'propose_convention':
      step(`${move.actor} proposes convention`);
      await client.proposeConvention(doc, move.spec);
      return;
    case 'propose_schema':
      step(`${move.actor} proposes schema ${move.name}`);
      await client.proposeSchema(doc, move.name, move.spec);
      return;
    case 'propose_endpoint':
      step(`${move.actor} proposes ${move.method.toUpperCase()} ${move.path}`);
      await client.proposeEndpoint(doc, move.method, move.path, move.spec);
      return;
    case 'accept_convention':
      step(`${move.actor} accepts convention`);
      await client.acceptConvention(doc, undefined, move.reason);
      return;
    case 'accept_schema':
      step(`${move.actor} accepts schema ${move.name}`);
      await client.acceptSchema(doc, move.name, undefined, move.reason);
      return;
    case 'accept_endpoint':
      step(`${move.actor} accepts ${move.method.toUpperCase()} ${move.path}`);
      await client.acceptEndpoint(doc, move.method, move.path, undefined, move.reason);
      return;
    case 'reject_convention':
      step(`${move.actor} rejects convention`);
      await client.rejectConvention(doc, move.reason);
      return;
    case 'reject_schema':
      step(`${move.actor} rejects schema ${move.name}`);
      await client.rejectSchema(doc, move.name, move.reason);
      return;
    case 'reject_endpoint':
      step(`${move.actor} rejects ${move.method.toUpperCase()} ${move.path}`);
      await client.rejectEndpoint(doc, move.method, move.path, move.reason);
      return;
  }
}
