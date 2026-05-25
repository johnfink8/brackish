// Renegotiation scenario.
//
// Unlike chat-app (greenfield, empty doc), this trial SEEDS a settled v1 chat-api contract before
// the two Claudes wake, then has them drive a breaking re-architecture: move live message delivery
// from polling (`GET /messages?since=`) to SSE push (a new `GET /stream`), retiring the poll
// endpoint entirely. Purpose: surface where brackish's missing renegotiation primitives hurt —
// mechanical carryover (no `doc fork`), breaking-change blindness (no classification), and
// supersession (no `doc supersede`/`retire`). The seed is VALID and settled; the invalid-on-arrival
// case is a separate future "import" trial.

import rawDemo from '../../src/demo-data.json' with { type: 'json' };
import { DemoDataSchema, type DemoMove } from '../../src/lib/demo-data.js';
import type { HttpMethod } from '../../src/lib/models.js';
import type { Scenario } from '../types.js';

// The bundled chat-app demo is a real, server-validated contract. We reuse its final-accepted
// artifact specs (not its negotiation path) to assemble a clean, linear, settled v1 seed.
const demo = DemoDataSchema.parse(rawDemo);

type ProposeConvention = Extract<DemoMove, { t: 'propose_convention' }>;
type ProposeSchema = Extract<DemoMove, { t: 'propose_schema' }>;
type ProposeEndpoint = Extract<DemoMove, { t: 'propose_endpoint' }>;

function conventionSpec(): ProposeConvention['spec'] {
  const m = [...demo.moves]
    .reverse()
    .find((x): x is ProposeConvention => x.t === 'propose_convention');
  if (!m) throw new Error('renegotiation seed: no propose_convention in demo-data');
  return m.spec;
}
function schemaSpec(name: string): ProposeSchema['spec'] {
  const m = [...demo.moves]
    .reverse()
    .find((x): x is ProposeSchema => x.t === 'propose_schema' && x.name === name);
  if (!m) throw new Error(`renegotiation seed: no propose_schema ${name} in demo-data`);
  return m.spec;
}
function endpointSpec(method: HttpMethod, path: string): ProposeEndpoint['spec'] {
  const m = [...demo.moves]
    .reverse()
    .find(
      (x): x is ProposeEndpoint =>
        x.t === 'propose_endpoint' && x.method === method && x.path === path,
    );
  if (!m) throw new Error(`renegotiation seed: no propose_endpoint ${method} ${path} in demo-data`);
  return m.spec;
}

const DOC = 'chat-api';
// Dependency order: a referenced schema must be proposed+accepted before the one that $refs it
// (propose validates the wide doc; accept validates the accepted doc). User < Message < MessageList.
const SEED_SCHEMAS = ['User', 'Message', 'MessageCreate', 'MessageList', 'Error', 'MessageEdit'];
const SEED_ENDPOINTS: Array<[HttpMethod, string]> = [
  ['get', '/messages'], // the poll endpoint — to be RETIRED in the reneg
  ['post', '/messages'],
  ['get', '/users/{id}'],
  ['patch', '/messages/{id}'],
  ['delete', '/messages/{id}'],
];

function buildSeed(): DemoMove[] {
  const moves: DemoMove[] = [
    { t: 'create_document', actor: 'backend', doc: DOC },
    { t: 'propose_convention', actor: 'backend', spec: conventionSpec() },
    { t: 'accept_convention', actor: 'frontend' },
  ];
  for (const name of SEED_SCHEMAS) {
    moves.push({ t: 'propose_schema', actor: 'backend', name, spec: schemaSpec(name) });
    moves.push({ t: 'accept_schema', actor: 'frontend', name });
  }
  for (const [method, path] of SEED_ENDPOINTS) {
    moves.push({
      t: 'propose_endpoint',
      actor: 'backend',
      method,
      path,
      spec: endpointSpec(method, path),
    });
    moves.push({ t: 'accept_endpoint', actor: 'frontend', method, path });
  }
  // Validate the whole seed against the move schema so a bad fragment fails loudly at load,
  // not mid-trial.
  return DemoDataSchema.parse({ document: DOC, moves }).moves;
}

const SINGLE_SHOT = `# Single-shot session

This is a one-shot turn — the other team's reply comes in a separate session, not during this one. **Do not** call \`brackish nap\`, \`brackish wait\`, \`brackish watch\`, or any other blocking poll. After your moves are done, write a one-paragraph summary of what you proposed/accepted/rejected/retracted and what you're handing off, then exit. The harness alternates sessions; don't loop waiting for the peer.`;

const BACKEND_BRIEF = `# chat-api — v1.1 re-architecture (backend)

You're the backend engineer for a realtime chat app (Node + Postgres). The \`chat-api\` OpenAPI contract is **already settled at v1** with the frontend team — it exists in brackish now, fully accepted. Start by reading it (\`brackish status chat-api\`, then \`brackish read chat-api\`) before you touch anything.

**The change.** v1 ships live updates as short-polling: \`GET /messages?since=<cursor>\`. In production that's a real cost — idle rooms still poll on a timer, and the change-time cursor semantics on \`GET /messages\` got complicated once edits/deletes had to propagate through the same poll. You're moving to **server push** for v1.1:

- Add a new **\`GET /stream\`** Server-Sent-Events endpoint that pushes a discriminated event envelope — message created / edited / deleted, and (finally cheap now) a typing indicator. Deliver initial history via the stream's replay-from-cursor at connect, so a client doesn't need a separate poll for backfill.
- **Retire \`GET /messages\`** — once the stream carries both backfill and live updates, the poll endpoint is dead. Remove it from the contract.
- The rest of the surface (\`POST /messages\`, \`GET /users/{id}\`, edit/delete, and the \`User\`/\`Message\`/\`Error\` schemas) is **unchanged** — it carries over as-is.

This is a breaking change for the consumer (their polling client stops working). Drive it on the contract, be clear about what breaks and what carries over, and make sure history isn't lost when the poll goes away.

You're NOT writing implementation code — the deliverable is the evolved OpenAPI 3.1 contract, negotiated via \`brackish\` (installed in this project).

${SINGLE_SHOT}`;

const FRONTEND_BRIEF = `# chat-api — v1.1 re-architecture (frontend)

You're the frontend engineer for a realtime chat app (React/web client). The \`chat-api\` contract is **already settled at v1** with the backend — it's in brackish, fully accepted, and you have a **working polling client** built against \`GET /messages?since=\`. Start by reading the current contract (\`brackish status chat-api\`, \`brackish read chat-api\`).

The backend wants to re-architect live delivery from polling to **SSE push** (a new \`GET /stream\`) and **retire \`GET /messages\`**. From your seat:

- A transport switch is a **real migration cost** — your polling client has to be rewritten against the event stream. Make sure the new \`GET /stream\` actually covers everything the poll did: initial history/backfill (you can't lose the thread on load), plus created/edited/deleted propagation.
- You've wanted a **typing indicator** since v1 (it got deferred because polling made it expensive); push finally makes it cheap, so make sure the event envelope includes it.
- Push back where the change costs you or leaves a gap. Accept what's right; reject or counter what isn't.

You're NOT writing implementation code — the deliverable is the evolved OpenAPI 3.1 contract, negotiated via \`brackish\` (installed in this project).

${SINGLE_SHOT}`;

const STARTER_BACKEND = `We're evolving the \`chat-api\` contract to v1.1 — moving live message delivery from polling to SSE push, and retiring the old poll endpoint. The document \`chat-api\` already exists with the settled v1 (don't recreate it). The frontend Claude is on the same machine. Read the current contract first, then drive the re-architecture.`;

const STARTER_FRONTEND = `The backend wants to re-architect \`chat-api\` live delivery from polling to push (SSE), retiring \`GET /messages\`. The document \`chat-api\` already has our settled v1 (don't recreate it). Read what's there and what they propose, and protect the consumer side.`;

const WAKE = `The other team made moves on the chat-api re-architecture. Check brackish and respond.`;

export const renegotiationScenario: Scenario = {
  name: 'renegotiation',
  documentName: DOC,
  seedingMoves: buildSeed(),
  notes: {
    what: 'Do brackish’s missing renegotiation primitives (fork / supersede / retire / breaking-change classification) hurt when two Claudes evolve a settled v1 contract? Specifically the poll→SSE-push re-architecture of chat-api, retiring GET /messages.',
    why: '0.6.1 shipped the recovery primitives (retract, validate). Before designing the evolution primitives, we want empirical evidence of WHERE the gaps bite — grounded friction, not speculation. chat-app already proved greenfield works; this is the first renegotiation trial.',
    how: 'Seed a settled v1 (convention + 6 schemas + 5 endpoints, all accepted) before the loop. Backend drives poll→push + retires GET /messages; frontend consumes/pushes back. Success = GET /stream accepted + GET /messages absent + settled. Held constant from chat-app: model, budget/turn, single-shot framing, install path. Varied: pre-seeded doc, delta-based success criterion.',
  },
  briefs: { frontend: FRONTEND_BRIEF, backend: BACKEND_BRIEF },
  starterPrompts: { frontend: STARTER_FRONTEND, backend: STARTER_BACKEND },
  wakePrompt: WAKE,
  firstMover: 'backend',
  maxRounds: 16,
  perTurnBudgetUsd: 1.5,
  perTurnTimeoutMs: 360_000,
  successCriterion: {
    minAcceptedEndpoints: 4,
    requireAcceptedConvention: true,
    requireRejectionCycle: false,
    requireSettled: true,
    requireAcceptedEndpoints: ['GET /stream'],
    requireAbsentEndpoints: ['GET /messages'],
    requireAcceptedSchemas: ['User', 'Message'],
  },
};
