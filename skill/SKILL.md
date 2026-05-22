---
name: brackish
description: Two Claude Code instances co-developing a REST API contract — frontend ↔ backend, producer ↔ consumer, Python server ↔ TS client. Triggers — "the backend Claude", "frontend's in another window", "we're co-developing X", "let's negotiate the X API", `/brackish invite <peer>`, `/brackish connect URL --token T --identity N`. Use whenever you're about to commit to a contract another Claude implements the other side of (TS interface, pydantic model, JSON Schema, OpenAPI fragment, response-shape assumption). NOT for internal types, single-developer projects, or where the API has already shipped. Negotiates a real OpenAPI 3.1 document via propose/accept/reject lifecycle with diff-based churn. **READ THE SUBFILES** before running commands — server.md (you implement the API) or client.md (you consume it). They contain non-obvious ordering and flag requirements. Critical points the body teaches that you WILL get wrong without reading: cross-machine bind defaults to loopback, you must pass `brackish up --bind 0.0.0.0` explicitly; per-document ACLs gate every doc-scoped TCP endpoint, so the server's invite MUST include `--grant <doc>` AND the doc MUST be created BEFORE the invite is minted, else the peer redeems successfully but is locked out with `forbidden: not a member of "<doc>"` on every read. Bundles batch helpers — `brackish schema accept <doc> A B C ...`, `brackish endpoint accept <doc> --target GET:/a --target POST:/b ...`, `brackish propose-batch <doc> --manifest manifest.yaml`. Role-specific workflow lives in subfiles: server.md (you implement the API), client.md (you consume it), propose.md (flag reference + manifest), patterns.md (WS/SSE/x-brackish canonical shapes).
---

# brackish — negotiate an OpenAPI document with the other Claude

You're paired with **another Claude Code instance** building the other half of a REST API. brackish is a message bus + structured propose/accept lifecycle for OpenAPI 3.1: endpoints, schemas, and a document-level convention. Use it to *agree on the contract* rather than each guessing.

## When to reach for brackish

The moment you would otherwise type a TS `interface`, pydantic model, JSON Schema, or OpenAPI fragment for a request/response shape the *other* Claude owns — or decide an HTTP method/path/status another component implements — or write "I'll assume the response is `{ id, name, email }`...".

Skip brackish if the contract is purely internal, the API is already shipped, or there's no other Claude on the other side.

## Step 0 — confirm scope with the human

**Before any brackish state changes**, use the AskUserQuestion tool to confirm scope. Three seed questions that worked in real trials (adapt as needed — but lead with these in this order):

1. **What scope is the other Claude implementing — what should this API negotiation cover?** (e.g. "the full data pipeline", "just the auth endpoints", "everything under /v2/orders/*")
2. **What name should the OpenAPI document use?** (typically the API name or the cwd repo name — e.g. `orders-api`, `payments-api`)
3. **Where is the other Claude running?** ("same machine" → socket transport, no invite needed; "different machine" → `brackish up --bind 0.0.0.0` and mint an invite)

Wait for the answers before running anything — don't `brackish up`, don't `brackish doc new`, don't invite a peer until you have them. The scope answer becomes the chat message you send right after creating the doc; both sides refer back to it for "is this in scope?" decisions.

If the human's invocation already supplies an answer (e.g. `/brackish invite mac2 — just the chat endpoints`), paraphrase back and skip that question.

**Bind addresses.** Bare `brackish up --bind` (or `brackish serve --bind`) resolves to `127.0.0.1:11442` — loopback only, a peer on another host can't reach it. For cross-machine, pass `--bind 0.0.0.0`. The daemon prints a security warning banner on non-loopback binds; surface it to the human along with the connect URL, but you don't need to re-confirm the bind choice with them.

## Pick your role + load the matching subfile

After the human's answers, you know two things:

- **Same-machine or cross-machine?** (answer 3)
- **Server or client?** Sniff your cwd: FastAPI / Express / Hono / Rails / actix source → you're the **server** (implementing the API). React / Vue / Next / raw fetch / native client → you're the **client** (consuming it). If the cwd is genuinely both, ask the human which half is yours.

Once you know your role, **read the matching subfile** before any brackish state changes:

- **Server** (you're implementing the API): read [`server.md`](server.md).
- **Client** (you're consuming the API): read [`client.md`](client.md).

If the subfile pointer is unclear at runtime, default to reading both — but it's cheaper to commit to one.

## Subfile index

- **[`server.md`](server.md)** — server-side workflow: `brackish up --bind`, mint invite, scope-claim chat, initial artifact drop.
- **[`client.md`](client.md)** — client-side workflow: redeem `/brackish connect`, inbox loop, accept/reject/counter cycles.
- **[`propose.md`](propose.md)** — propose-verb flag reference (endpoint / schema / convention), `--file` vs flags, lint pre-flight, race-protection, `propose-batch --manifest`.
- **[`patterns.md`](patterns.md)** — WebSocket handshake, SSE stream, `x-brackish.*` canonical shapes. Read this if WS or SSE is in scope.

## High-leverage verbs (always available)

```
brackish status <doc>                                  # "what am I blocked on?" — always start a turn here
brackish schema   accept <doc> A B C ...               # batch accept; stops on first failure
brackish endpoint accept <doc> --target GET:/a --target POST:/b ...
brackish propose-batch <doc> --manifest manifest.yaml  # convention → schemas → endpoints in one go
brackish <kind> lint <args> <file>                     # local pre-flight before any --file propose
brackish nap [--seconds 60]                            # block + check inbox when waiting on peer
```

**If you find yourself running `accept` or `propose` three times in a row for the same kind, you're using the wrong verb — switch to a batch form.**

## Once an artifact is accepted

That's the contract. Render and use it:

- Frontend: `brackish visualize <doc> --format openapi --out openapi.yaml` → feed to `openapi-typescript`, `orval`, etc.
- Backend: same YAML → `oapi-codegen`, `fastapi-codegen`, equivalents.
- Human eyes: open `http://localhost:<port>/ui/<doc>` (if `brackish serve` is running) for Swagger UI + the brackish rationale sidebar.

If the other side later changes an accepted artifact, you'll get an `artifact_proposed` event with a bumped version and a compact delta showing exactly what shifted. Accept or reject; regenerate.

## The hook

`brackish install` wires a `UserPromptSubmit` hook that surfaces pending events at the start of each turn:

```
<system-reminder>
brackish: pending negotiations for your identity. Read and respond before continuing your current task.
orders-api  3 new  …  peer  artifact_proposed operation POST /users v3 +responses.409
</system-reminder>
```

When you see it, treat it as a real interruption: handle the pending traffic before continuing. The hook fires every turn — its absence means the inbox was empty.

**When you're done negotiating and switching to implementing** the agreed contract, run `brackish deactivate` to mute the hook + stop the daemon. The skill stays installed (Claude still loads it on demand); only the per-turn ping goes silent. Re-enable later with `brackish activate` + `brackish up`.

## Output conventions

- Compact text by default; `--json` for structured output.
- `brackish endpoint show ... --full > endpoint.yaml` writes a clean file (metadata goes to stderr).
- Exit codes: `0` = success (incl. timed-out `wait`); `1` = operation error (4xx); `2` = config/auth/connection error.
