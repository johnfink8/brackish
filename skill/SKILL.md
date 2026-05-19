---
name: brackish
description: Use whenever you are about to commit to a REST API contract (endpoint method/path, request/response shape, JSON-typed schema, auth/timing/idempotency) at a boundary that another Claude Code instance is implementing the other side of. Trigger words include "the backend Claude", "frontend's in another window", "we're co-developing X", or moments where you'd otherwise type a TS interface, pydantic model, OpenAPI fragment, or assume a response shape you don't actually know. brackish negotiates a real OpenAPI 3.1 document via propose/accept/reject lifecycle, with diff-based churn so the negotiation doesn't burn either agent's context. NOT for internal types, single-developer projects, or where the API has already shipped — only when there's a live other-Claude implementing the other half.
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

## Start of session: `brackish up`

At the start of any session that might involve cross-component contracts, run:

```
brackish up
```

This is idempotent: it writes a client config if you don't have one yet (identity defaults to your hostname; pass `--identity <name>` to override), then starts the daemon in the background if it isn't already running. After `up`, every other brackish command can talk to the daemon. Tear down later with `brackish down`.

Then check the inbox:

```
brackish inbox
```

If there are pending events for your identity, deal with them before resuming. Other-you may have proposed/rejected something that should change your next move.

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

Then propose pieces:

```
brackish convention propose orders-api \
  --title "Orders API" --api-version 1.0.0 \
  --server "https://api.example.com:production" \
  --security-scheme "bearer:http:bearerFormat=JWT"

brackish schema propose orders-api UserCreate \
  --field 'email:string' --field 'name:string'

brackish schema propose orders-api User \
  --field 'id:string' --field 'email:string' \
  --field 'createdAt:string:ISO 8601'

brackish endpoint propose orders-api POST /users \
  --summary "Create a user" \
  --request-content 'application/json=UserCreate' \
  --response '201:application/json:User:created' \
  --response '409:application/json:Error:email exists' \
  --idempotent
```

`--field` syntax: `name:type[?][:description]`. Type can be `string`, `integer`, `number`, `boolean`, `null`, `string[]` (array), or a `PascalCase` name (becomes a `$ref` to another schema). The `?` after type marks the property optional.

When the spec needs more than the sugar covers, pass `--file path/to/operation.yaml` (or `.json`) instead.

## Avoid races: declare what version you expect

Two agents can independently decide to propose the same identity at roughly the same time. brackish guards against this with three opt-in flags on every `propose`:

- `--expected-new` — **use this for any first proposal.** Refuses if any version of this identity already exists (regardless of status). If it errors, it's because the other side already proposed; run `brackish endpoint show <id> --proposed` (or `schema` / `convention`) and react instead.
- `--expected-version <N>` — **use this for revisions.** Refuses unless the latest version is exactly `N` (any status). After you've read v3, propose v4 with `--expected-version 3`; if the other side slipped in their own v4, you'll get a 409 and re-read.
- `--force` — only meaningful without `--expected-*`. Lets you stack a counter-proposal on top of an unresolved (still-`proposed`) version. The normal recipe for a counter-proposal is to **reject first, then propose** — use `--force` only when you want both versions visible side by side.

**Default behavior (no flags):** brackish refuses a new propose when the latest version is still `proposed` (i.e., neither accepted nor rejected). You'll see `version_in_flight` and a message naming the in-flight proposer. Recovery: read it, then accept / reject / or counter-propose explicitly.

The 409 errors are your friend — they catch the race window. Prefer to be explicit (`--expected-new` / `--expected-version`) over relying on the default behavior; an explicit assertion gets you a clear `version_mismatch` when state has drifted.

## Responding to other-you

```
brackish read orders-api         # see the conversation + propose events with their delta summary
brackish endpoint show orders-api POST /users          # compact: status, version chain, latest delta
brackish endpoint show orders-api POST /users --full   # include the full Operation body
brackish endpoint show orders-api POST /users --proposed   # the in-flight version
brackish endpoint accept orders-api POST /users        # accept the latest proposed
brackish endpoint reject orders-api POST /users "needs auth section"
brackish endpoint diff orders-api POST /users --from 1 --to 2   # see only what changed
```

Same verbs for `schema` and `convention`.

You **can't accept your own proposal** (the server enforces it). One side proposes; the other side accepts or rejects.

## Token-efficient catch-up (do this)

A high-churn negotiation can balloon an agent's context if you're not careful. brackish gives you compact paths — use them:

1. `brackish read <doc>` — events come with compact `delta` summaries like `+responses.409` so you can see what each propose actually changed without fetching the full spec.
2. `brackish endpoint show <doc> METHOD /path` — defaults to a status line + delta; only add `--full` when you actually need to read the spec body.
3. `brackish <kind> diff <doc> <id> --from N --to M` — emits an RFC 6902 JSON Patch between two versions. For "I rejected v1, what's different in v2", this is the smallest possible context cost.
4. `brackish visualize <doc>` — defaults to a table-of-contents (no spec bodies). Add `--full` for everything. Use `--format openapi` to write a real OpenAPI YAML; `--format markdown` for a human-readable doc with rationale interleaved.

Rough rule: **don't pull a full spec body until you've decided you need it.** The delta summary + diff command tell you what changed at a fraction of the bytes.

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
2. `brackish invite <peer-name> --json` — mint a one-time connect token. The output's `connectCommand` field is a bash string like `brackish connect URL --token T --identity NAME`.
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
2. `brackish inbox` — see what's already in flight.
3. `brackish documents` — see what documents exist. Reuse or `brackish doc new <name>`.
4. Propose the convention first (`brackish convention propose ... --expected-new`), then the schemas, then the endpoints — pass `--expected-new` so a parallel agent can't silently stomp you.
5. When revising, pass `--expected-version <N>` (where N is the version you just read). On 409, re-read and reconcile.
6. Use `brackish visualize` to see the assembled state; use `brackish endpoint/schema diff` to see what's changed.
