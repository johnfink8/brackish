// Chat-app negotiation scenario.
//
// Two Claude Code instances are spawned. Each side gets a small CLAUDE.md with its team's
// own initial assumptions about the API — not adversarial talking points; just different
// mental models of what the chat app is and what version of it ships first. Friction
// emerges from the gap between the two understandings, not from prescribed positions.
//
// Backend has a simple v1 mental model (send a message, list history, polling for new
// messages) and is the firstMover. Frontend's mental model is richer: they know product
// asked for typing indicators and edit/delete on top of the basics. The plan is to wait
// for backend's first pass, accept what makes sense, then propose the additions.

import type { Scenario } from '../types.js';

const BACKEND_BRIEF = `# Your team's chat-app project

You're the backend engineer for a small realtime chat app. Your team owns the API server (Node + Postgres). The frontend team is doing the React/web client.

Your team's mental model of v1:

- **Core feature set.** Send a message; list message history; receive new messages.
- **Receive-new-messages**, you've been planning to ship as short-polling — \`GET /messages?since=<cursor>\`. Long-lived push (SSE/WebSocket) is operationally heavier and you'd rather not commit to it for v1 unless the frontend has a strong argument.
- **Data shapes.** A \`Message\` has an id, text, author, and timestamp. The author is just an \`authorId\` reference into the \`User\` table — the frontend can cache users separately. A \`User\` has an id, displayName, and avatarUrl.
- **Auth.** Bearer tokens. The frontend gets one out of band (signup/login flow is out of scope for this contract).
- **JSON keys.** Your ORM emits snake_case naturally. If the frontend has a strong preference for camelCase you can negotiate, but starting from snake_case is the path of least resistance for your codebase.
- **Errors.** Some shared envelope is fine, but you haven't designed it carefully — propose something simple and iterate.

You're NOT writing implementation code in this exercise — the deliverable is an agreed OpenAPI 3.1 contract, negotiated via the \`brackish\` tool that's installed in this project.

Be open to the frontend's reasoning. They'll know things about the consumer side (rendering, UX) that aren't obvious from a server-side seat. Don't fight on operational details the frontend wouldn't reasonably care about (e.g. cursor opacity), but do push back when something has real cost on your side.

# Single-shot session

This is a one-shot turn — the frontend's reply will come in a separate session, not during this one. **Do not** call \`brackish nap\`, \`brackish wait\`, \`brackish watch\`, or any other blocking poll. After your moves are done, write a one-paragraph summary of what you proposed/accepted/rejected and what you're handing off, then exit. The harness will alternate sessions; don't loop waiting for the peer.
`;

const FRONTEND_BRIEF = `# Your team's chat-app project

You're the frontend engineer for a small realtime chat app. Your team owns the React/web client. The backend team is doing the Node + Postgres API server.

Your team's mental model:

- **Core feature set** (what backend probably has scoped): send a message, list history, receive new messages live. You're aligned with them on these.
- **What product also signed off on, that the backend hasn't seen yet.** Two extras the design covers:
  1. **"Three dots" typing indicator** — when another user is typing, show the dots in the message thread. This needs some lightweight signaling channel (a typing event, presence ping, etc. — the shape isn't dictated, but it has to exist).
  2. **Edit + delete on your own messages** — within a few minutes of sending, the user can edit their own message text or delete it entirely. Standard chat UX. Other clients viewing the same thread need to see the edit/delete propagate.
- **Render-readiness**, your only strong preference: when you fetch a message list, you want enough to render an entire chat row without N+1 fetches. Embedding the author's display name + avatar URL on the message itself is the ideal. You can work with author-id-only if the backend insists, but say so.
- **camelCase JSON keys**, light preference. Your codegen and TS types are friendlier when keys are camelCase. Not a hill to die on if the backend pushes back hard.

**Your move ordering matters.** The backend is going first — let them propose their v1 (probably just the core feature set) and converge on that before you load in the typing/edit/delete asks. Don't dump everything at once. After backend's initial drop, accept what fits and reject only what genuinely doesn't, then propose the additions as follow-ups so the negotiation stays focused.

You're NOT writing implementation code in this exercise — the deliverable is an agreed OpenAPI 3.1 contract, negotiated via the \`brackish\` tool that's installed in this project.

# Single-shot session

This is a one-shot turn — the backend's reply will come in a separate session, not during this one. **Do not** call \`brackish nap\`, \`brackish wait\`, \`brackish watch\`, or any other blocking poll. After your moves are done, write a one-paragraph summary of what you accepted/rejected/proposed and what you're handing off, then exit. The harness will alternate sessions; don't loop waiting for the peer.
`;

// Starter and wake prompts mimic what a human would type. The brackish skill (installed via
// `brackish install --local`) handles the actual workflow.
//
// We pre-supply the three Step 0 scope-Q answers (scope, doc name, where) inline because
// `claude -p` has no interactive AskUserQuestion surface — same approach validate-skill.ts
// takes. Per the skill: "if the human's invocation already supplies an answer, paraphrase back
// and skip that question." Real human invocations look similar ("let's negotiate the X API,
// call it foo-api, frontend's on this machine").

const STARTER_BACKEND = `Let's negotiate the chat app API with the frontend team. Call the OpenAPI document \`chat-api\`. The frontend Claude is on the same machine — no invite needed.`;
const STARTER_FRONTEND = `Let's negotiate the chat app API with the backend team. The document is \`chat-api\` (already created by them). They're on the same machine.`;

const WAKE = `The other team made some moves on the chat app API. Check brackish and respond.`;

export const chatAppScenario: Scenario = {
  name: 'chat-app',
  documentName: 'chat-api',
  briefs: { frontend: FRONTEND_BRIEF, backend: BACKEND_BRIEF },
  starterPrompts: { frontend: STARTER_FRONTEND, backend: STARTER_BACKEND },
  wakePrompt: WAKE,
  firstMover: 'backend',
  maxRounds: 24,
  perTurnBudgetUsd: 1.5,
  // 6 min wall-clock per turn. With the single-shot hint in each brief, sub-Claudes no longer
  // call `brackish nap` / wait; they finish their moves, summarize, exit. Previous trials under
  // the inlined-skill setup peaked at ~4.5 min on a heavy round; the split skill adds some file
  // reads but should still land well under 6.
  perTurnTimeoutMs: 360_000,
  successCriterion: {
    minAcceptedEndpoints: 3,
    requireAcceptedConvention: true,
    // Naturalistic split — friction may or may not produce rejections. Don't force one.
    requireRejectionCycle: false,
    // Don't terminate while either side still has in-flight proposals — we want a fully
    // settled contract so the demo lands on "done", not "mid-negotiation".
    requireSettled: true,
  },
};
