---
name: brackish
description: Use whenever you are about to commit to a REST API contract (endpoint method/path, request/response shape, JSON-typed schema, auth/timing/idempotency) at a boundary that another Claude Code instance is implementing the other side of. Trigger words include "the backend Claude", "frontend's in another window", "we're co-developing X", or moments where you'd otherwise type a TS interface, pydantic model, OpenAPI fragment, or assume a response shape you don't actually know. Also responds to slash-command-style asks for bootstrap: `/brackish invite <peer-name>` mints + prints a cross-machine connect token (server side), `/brackish connect <url> --token T --identity N` redeems one (client side). brackish negotiates a real OpenAPI 3.1 document via propose/accept/reject lifecycle, with diff-based churn so the negotiation doesn't burn either agent's context. NOT for internal types, single-developer projects, or where the API has already shipped — only when there's a live other-Claude implementing the other half.
---

# brackish — negotiate an OpenAPI document with the other Claude

You're paired with **another Claude Code instance** building the other half of a REST API (frontend ↔ backend, producer ↔ consumer). brackish is a small message bus + structured propose/accept lifecycle for OpenAPI 3.1 documents: endpoints, schemas, and the document-level convention (info/servers/security). Use it to *agree on the contract* rather than each guessing.

## When to reach for brackish

The moment you would otherwise:

- Type a TS `interface`, pydantic model, JSON Schema, or OpenAPI fragment for a request/response shape the *other* Claude owns.
- Decide an HTTP method/path/status code for an endpoint another component implements.
- Write "I'll assume the response is `{ id, name, email }`...".
- Hand-roll a fixture for a payload another component produces.
- Re-derive a shape from a sibling repo that's being actively changed.

Skip brackish if:
- The contract is purely internal to your component.
- The API is already shipped and the shape is locked.
- There's no other Claude on the other side.

## Start of session: `up` → `documents` → `inbox` → claim scope

At the start of any session that might involve cross-component contracts:

```
brackish up           # idempotent: writes client config if missing + starts daemon if not running
brackish documents    # which documents already exist? you might be joining mid-stream
brackish inbox        # any pending events for your identity? handle them first
```

**Empty inbox does not mean the peer is idle.** They may be mid-propose (the hook hasn't fired yet) or working in a different document. Always check `documents` first to avoid `brackish doc new` on a name that's already taken.

### Coordinate scope first (before any propose)

After the three steps above, send **one chat message claiming scope** before you touch any artifacts:

```
brackish send <doc> "I'll take the User/Auth schemas and POST /users + POST /sessions. You take Message + GET/POST /messages."
```

This is the single highest-leverage move for avoiding duplicate-name collisions. The proposer-side concurrency check (the 409 you'd get on a race) is the safety net; the chat message is the prevention.

Tear down later with `brackish down`.

## The model: it's literally OpenAPI 3.1

Every brackish document assembles into a real OpenAPI 3.1 spec. There are exactly three kinds of negotiable artifact:

| Kind | What it is | Identity key | When to use |
|---|---|---|---|
| `endpoint` | OpenAPI Operation Object (method + path + requestBody + responses + security + `x-brackish`) | `<METHOD> <path>` | One per `(method, path)` |
| `schema` | JSON Schema (lives under `components.schemas[name]`) | `<Name>` | Reusable shapes (`User`, `OrderCreate`) |
| `convention` | `{ info, servers, securitySchemes }` (document-level header) | singleton | One per document |

Brackish-specific metadata uses OpenAPI's `x-` extension hatch, **consolidated into one key per object** so it reads as a single metadata block and doesn't pattern-match against HTTP headers:

```yaml
# On an Operation:
x-brackish:
  idempotent: true                              # declares intent (orthogonal to HTTP method)
  sideEffects:                                  # free-text notes on what state this mutates
    - "writes orders table"
    - "publishes order.created event"
  timing: { p50: 20ms, p99: 150ms, timeout: 2s }
  streaming: sse                                # for SSE/long-poll endpoints
  protocol: websocket                           # for WS handshake operations
  frames:                                       # WS frame catalog (when protocol=websocket)
    client_to_server: [ "..." ]
    server_to_client: [ "..." ]

# On a Convention:
x-brackish:
  naming: camelCase                             # JSON-key casing across the wire (camelCase | snake_case)
```

These are **OpenAPI Specification Extensions**, not HTTP headers — they live alongside `responses` and `security` on the Operation Object as vendor metadata. Validators and codegen tools that don't understand them ignore them; Swagger UI passes them through silently; brackish renders them in the markdown + sidebar views. **Use the canonical field names above** — don't invent variants (e.g. `sideEffect` singular, `idempotency`); the consolidation exists so we have one place that defines them.

## Workflow

```
brackish documents               # list existing docs (alias: `brackish docs`)
brackish doc new orders-api      # if you need a new one
```

### Propose the convention with the document-level defaults baked in

```
brackish convention propose orders-api --expected-new \
  --title "Orders API" --api-version 1.0.0 \
  --server-url https://api.example.com --server-description "production" \
  --security-scheme "bearer:http:bearerFormat=JWT" \
  --global-security bearer \
  --naming camelCase
```

- `--server-url` + `--server-description` are unambiguous. The older colon-form `--server "url:description"` still works but fails on URLs containing a port colon (`http://host:8000:desc` mis-parses); brackish warns when it sees that shape.
- `--global-security bearer` emits an OpenAPI doc-level `security: [{ bearer: [] }]`. Endpoints inherit it automatically (no `--security` per endpoint needed). Opt out with `--no-inherit-security` on a specific endpoint (e.g. `/health`); brackish 0.3.1+ emits `security: []` on that op, which is the OpenAPI spelling for "no auth required".
- `--naming camelCase` (or `snake_case`) stamps the JSON-key policy onto `x-brackish.naming` so the convention documents the casing decision once.

**If the convention gets rejected, hold off on proposing dependents.** Endpoints and schemas inherit doc-level defaults from the convention (security, naming, info.version), so proposing them on top of an in-flight or rejected convention means re-proposing once the convention finally settles. `brackish status <doc>` surfaces a stalled convention in a dedicated "needs attention" bucket — clear it before chewing through the endpoint queue.

**Ground in code, not docs.** If the repo has prior API docs (`API.md`, an older `openapi.yaml`, a README schema block), treat them as a prior-negotiation snapshot, not ground truth. Stale docstrings are common; the actual emit/handler sites win. Before proposing a schema for a payload your peer produces, grep the emit site (`response.json(...)`, `return jsonify(...)`, `WebSocket.send(...)`) in their codebase and reconcile with the docs.

### Schemas: prefer `--file` over the `--field` sugar

The `--field 'name:type[?][:description]'` sugar handles flat objects with primitive/array/ref types. As soon as you need **nullable, enum, nested objects, arrays of refs, additionalProperties, oneOf/anyOf, or per-field examples**, write the schema as a YAML file and pass `--file`:

```
cat > /tmp/User.yaml <<'EOF'
type: object
required: [id, email, createdAt]
properties:
  id: { type: string }
  email: { type: string, format: email }
  displayName: { type: string, nullable: true }
  role: { type: string, enum: [admin, member] }
  createdAt: { type: string, format: date-time }
EOF
brackish schema propose orders-api User --expected-new --file /tmp/User.yaml
```

Don't burn round-trips on `--field` collisions — write the file.

**`--file` replaces other CLI flags, not merges with them.** If you pass `--file convention.yaml --global-security bearer`, the `--global-security` is silently dropped (brackish 0.3.1+ warns to stderr, but the file still wins). Bake every field you want into the file. Same rule for `endpoint propose --file` and `schema propose --file`.

**Block-style descriptions when the text contains `:`, `,`, `(`, `{`.** YAML flow-mappings with embedded colons parse confusingly:

```yaml
# Foot-gun (flow-style with embedded colon):
description: "salience: interrupt; barge over current speech"

# Safer (block-style):
description: |
  salience: interrupt; barge over current speech
```

### Endpoints: auto-derived `parameters` and inherited security

```
brackish endpoint propose orders-api POST /users/{id}/posts --expected-new \
  --summary "Create a post for a user" \
  --request-content 'application/json=PostCreate' \
  --response '201:application/json:Post:created' \
  --response '409:application/json:Error:duplicate'
```

`{id}` placeholders auto-become a `parameters` entry (`name: id, in: path, required: true, schema: { type: string }`). The convention's `--global-security` flows in as the operation's `security`. You only need `--security` to override or `--no-inherit-security` to make an endpoint explicitly public.

### `x-brackish` extension fields

For brackish metadata (idempotency, side effects, timing) use the dedicated flags:

```
brackish endpoint propose orders-api POST /orders \
  --idempotent \
  --side-effect "writes orders row" --side-effect "publishes order.created" \
  --timing-p50 20ms --timing-p99 150ms
```

They land at `x-brackish: { idempotent, sideEffects, timing }` per the canonical shape.

## Avoid races: declare what version you expect

Two agents can independently decide to propose the same identity at roughly the same time. brackish guards against this with three opt-in flags on every `propose`:

- `--expected-new` — **use this for any first proposal.** Refuses if any version of this identity already exists (regardless of status). If it errors, it's because the other side already proposed; run `brackish endpoint show <id> --proposed` (or `schema` / `convention`) and react instead.
- `--expected-version <N>` — **use this for revisions.** Refuses unless the latest version is exactly `N` (any status). After you've read v3, propose v4 with `--expected-version 3`; if the other side slipped in their own v4, you'll get a 409 and re-read.
- `--force` — only meaningful without `--expected-*`. Lets you stack a counter-proposal on top of an unresolved (still-`proposed`) version. The normal recipe for a counter-proposal is to **reject first, then propose** — use `--force` only when you want both versions visible side by side.

**Default behavior (no flags):** brackish refuses a new propose when the latest version is still `proposed` (i.e., neither accepted nor rejected). You'll see `version_in_flight` and a message naming the in-flight proposer. Recovery: read it, then accept / reject / or counter-propose explicitly.

The 409 errors are your friend — they catch the race window. Prefer to be explicit (`--expected-new` / `--expected-version`) over relying on the default behavior; an explicit assertion gets you a clear `version_mismatch` when state has drifted.

## Responding to other-you

```
brackish read orders-api                                                # conversation + propose events with delta summary
brackish endpoint show orders-api POST /users                           # compact: status, version chain, latest delta
brackish endpoint show orders-api POST /users --full                    # include the full Operation body
brackish endpoint show orders-api POST /users --proposed                # the in-flight version (falls back to accepted w/ a hint if none in flight)
brackish endpoint accept orders-api POST /users                         # accept the latest proposed
brackish endpoint reject orders-api POST /users "needs auth section"
brackish endpoint withdraw orders-api POST /users                       # take back your OWN still-proposed version
brackish endpoint diff orders-api POST /users --from 1 --to 2           # default: RFC 6902 patch
brackish endpoint diff orders-api POST /users --from 1 --to 2 --format rendered   # side-by-side YAML for human review
```

Same verbs for `schema` and `convention`.

You **can't accept your own proposal** (the server enforces it). One side proposes; the other side accepts or rejects. If you proposed something you shouldn't have (wrong path, wrong name, raced the other side), `brackish <kind> withdraw <id>` takes it back — only works on your own still-proposed versions.

### `brackish status <doc>` — "what am I blocked on?"

When the document has many artifacts in flight, the cleanest single view is:

```
brackish status orders-api
```

Buckets by ownership: **awaiting peer review** (you proposed), **awaiting your review** (peer proposed), **accepted**, plus a **needs attention** bucket that surfaces a rejected or withdrawn convention (which would otherwise be invisible since it's neither current nor proposed). Add `--verbose` to also list withdrawn / rejected items, or `--json` for structured output.

### Triaging a big drop from the peer

If `status` shows you're holding ten or more incoming artifacts (peer dumped a whole batch), don't just power through. **Send a chat message proposing a review order** before chewing through them:

```
brackish send orders-api "I'll start with the convention + User/Auth/Session schemas, then the auth endpoints, then come back for the rest. Reject any of those that need to ship sooner."
```

This gives the peer a chance to redirect (maybe the `/health` endpoint matters more than the auth schemas) and saves you from re-running the same triage in your head every turn.

### Rejecting with a reason

`<kind> reject <doc> <selector> "<reason>"` accepts the reason inline. You don't usually need a separate `brackish send` alongside it — the reason is already attached to the reject event and renders in the rationale. Use `brackish send` only when the rationale wouldn't fit (e.g., proposing an alternative spec sketch).

## Token-efficient catch-up (do this)

A high-churn negotiation can balloon an agent's context if you're not careful. brackish gives you compact paths — use them in this order:

1. **`brackish status <doc>` first.** Single best "what am I blocked on?" view; buckets by ownership (awaiting peer, awaiting me, accepted) and surfaces a rejected/withdrawn convention separately (which is what's blocking every dependent, if so). This is where you start a turn, not `read`.
2. `brackish read <doc>` — events with compact `delta` summaries like `+responses.409` so you can see what each propose changed without fetching the full spec. Reach for it after `status` when you need *why*, not just *what*.
3. `brackish endpoint show <doc> METHOD /path` — defaults to a status line + delta; only add `--full` when you actually need to read the spec body.
4. `brackish <kind> diff <doc> <id> --from N --to M` — emits an RFC 6902 JSON Patch between two versions. For "I rejected v1, what's different in v2", this is the smallest possible context cost.
5. `brackish visualize <doc>` — defaults to a table-of-contents (no spec bodies). Add `--full` for everything. Use `--format openapi` to write a real OpenAPI YAML; `--format markdown` for a human-readable doc with rationale interleaved.
6. `brackish nap` — when you've responded to everything in the inbox and have nothing left to do but wait for the peer, `brackish nap` sleeps 60s (override with `--seconds N`), then snapshots the inbox. setTimeout-shape, not a recurring monitor: it returns once, with whatever showed up. Use it instead of asking the human "anything new?". If `nap` returns empty twice in a row, `brackish send <doc> "<status>"` ping the peer rather than napping a third time.

Rough rule: **don't pull a full spec body until you've decided you need it.** The delta summary + diff command tell you what changed at a fraction of the bytes.

## WebSocket and SSE: canonical patterns

Frame catalogs are **documentation, not codegen targets** — codegen tools won't auto-generate a dispatcher from `x-brackish.frames`. Use these patterns so the next pair of agents reading the spec doesn't reinvent them:

### WebSocket handshake

Model the handshake as a `GET` operation with response code `101 Switching Protocols`. Put the frame catalog in `x-brackish.frames` as arrays of **`$ref` strings**, pointing at component schemas that define each frame shape:

```yaml
# brackish endpoint propose <doc> GET /ws --file ws-handshake.yaml
summary: WebSocket handshake
responses:
  "101": { description: Switching Protocols }
  "401": { description: missing/invalid auth }
security:
  - bearer: []
x-brackish:
  protocol: websocket
  frames:
    client_to_server:
      - "#/components/schemas/ClientHello"
      - "#/components/schemas/ClientMessage"
    server_to_client:
      - "#/components/schemas/ServerEvent"
      - "#/components/schemas/ServerError"
```

### SSE stream

Model the stream as a `GET` returning `text/event-stream`. Put the event-type catalog in `x-brackish.streaming` + `x-brackish.eventTypes`:

```yaml
summary: Live order updates
responses:
  "200":
    description: SSE stream; reconnect with Last-Event-ID
    content: { text/event-stream: {} }
security:
  - bearer: []
x-brackish:
  streaming: sse
  eventTypes:
    - "#/components/schemas/OrderCreatedEvent"
    - "#/components/schemas/OrderUpdatedEvent"
    - "#/components/schemas/OrderCancelledEvent"
```

Both patterns: the consumer reads the catalog to know **which schemas to expect**, but the runtime dispatcher (the `case event.type === 'order.created'` block) is still hand-written.

## Once an artifact is accepted

That's the contract. Render it and use it:

- Frontend: `brackish visualize <doc> --format openapi --out openapi.yaml`, then run your favorite codegen (`openapi-typescript`, `orval`, etc.) against it.
- Backend: same OpenAPI YAML feeds server-stub codegen (e.g. `oapi-codegen` for Go, `fastapi-codegen` for Python).
- Human eyes: open `http://localhost:<port>/ui/<doc>` (if `brackish serve` is running) for Swagger UI + the brackish rationale sidebar — every endpoint and schema shows its negotiation history.

If the other side later changes an accepted artifact, you'll get a new `artifact_proposed` event with a bumped version and a compact delta showing exactly what shifted. Accept or reject; regenerate.

## The hook

If `brackish install` wired the `UserPromptSubmit` hook into `~/.claude/settings.json`, you'll see a block at the start of relevant turns:

```
<system-reminder>
brackish: pending negotiations for your identity. Read and respond before continuing your current task.

orders-api                3 new     2026-05-19T...  peer    artifact_proposed operation POST /users v3 +responses.409
…
</system-reminder>
```

When you see this, treat it as a real interruption: handle the pending traffic before continuing your current task. The hook silently fires every turn — its absence means the inbox was empty.

If the user hasn't run `brackish install`, the hook isn't there. Suggest it when relevant.

## Output conventions (worth knowing)

- Compact text by default; `--json` flag returns structured output for scripting.
- `brackish endpoint show ... --full` writes the spec body to stdout; metadata to stderr (`brackish endpoint show ... --full > endpoint.yaml` writes a clean file).
- `brackish visualize ... --format openapi --out X.yaml` writes the assembled OpenAPI doc to a file.
- Exit codes: `0` = success (incl. a timed-out `wait` with zero events); `1` = operation error (4xx); `2` = config/auth/connection error.

## Bootstrap: same-machine vs cross-machine

**Same machine (two Claudes, one host).** No tokens needed. Each side just runs `brackish up` (idempotent — the second one detects the daemon is already up). Both can immediately read/write the same documents over the local Unix socket. Done.

**Cross-machine.** The user pairs the two sides explicitly. The skill recognizes two slash-command-style asks from the user:

The slash-command verbs mirror the bash CLI: `/brackish invite NAME` means "run `brackish invite NAME` (with any setup)"; `/brackish connect URL --token T --identity N` means "run `brackish connect URL --token T --identity N` (with any setup)". One verb, one form — pass the args through.

### Server side: `/brackish invite <peer-name>`

When the user says something like `/brackish invite my-macbook` (or "invite my macbook" / "mint a token for the frontend Claude"):

1. `brackish up --bind` — ensures the daemon is running with TCP enabled. Idempotent. If the daemon was already up without TCP, run `brackish down && brackish up --bind` to restart it with TCP.
2. `brackish invite <peer-name> --json` — mint a one-time connect token. The output's `connectCommand` field is a bash string like `brackish connect URL --token T --identity NAME`. For a multi-hour negotiation, pass `--ttl 86400` so the invite doesn't expire mid-session.
3. **Print a single line the user can paste verbatim into the peer Claude.** Take the `brackish connect …` string and replace the leading `brackish ` with `/brackish `. Result:
   ```
   /brackish connect <URL> --token <T> --identity <peer-name>
   ```
   That single line activates the peer's skill and supplies all the args. Print it on its own line in your final response.

If `brackish serve --invite <peer-name>` is more convenient (daemon wasn't running yet), use it — the output is the same `brackish connect …` string; transform it the same way.

### Client side: `/brackish connect <url> --token <t> --identity <name>`

When the user pastes a line like `/brackish connect http://1.2.3.4:11442 --token … --identity my-macbook`:

1. Run the bash equivalent verbatim — same args, drop the `/`: `brackish connect http://… --token … --identity …`. This writes `~/.brackish/config.toml` with the persistent token + identity + remote server URL.
2. `brackish whoami` — confirm the identity is bound.
3. `brackish inbox` — pick up any traffic the other side already sent.

After connect, every brackish command on this side goes to the remote daemon transparently. You do **not** need to run `brackish up` on the client side — the remote daemon is what you're talking to.

## When the user says "let's negotiate the API"

1. `brackish up` — daemon + client config in one idempotent step.
2. `brackish documents` — see what documents exist. Reuse or `brackish doc new <name>` (only after confirming the name's free).
3. `brackish inbox` — see what's already pending for your identity.
4. **`brackish send <doc> "I'll take A, B, C; you take D, E, F"`** — claim scope via chat before any propose.
5. Propose the convention first (with `--global-security` + `--naming` to bake in document-level defaults), then schemas (`--file` for anything non-trivial), then endpoints (path placeholders auto-derive `parameters`; convention security flows in automatically). Always pass `--expected-new` on first proposal.
6. When revising, pass `--expected-version <N>` (where N is the version you just read). On 409, re-read with `brackish read` + `brackish status` and reconcile.
7. Use `brackish status <doc>` to see what's blocked on you vs them; `brackish endpoint diff … --format rendered` for side-by-side review; `brackish visualize` for the assembled state.
