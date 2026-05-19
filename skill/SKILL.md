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

## Inbox first

At the start of any session that might involve cross-component contracts:

```
brackish inbox
```

If there are pending events for your identity, deal with them before resuming. Other-you may have proposed/rejected something that should change your next move.

## The model: it's literally OpenAPI 3.1

Every brackish document assembles into a real OpenAPI 3.1 spec. There are exactly three kinds of negotiable artifact:

| Kind | What it is | Identity key | When to use |
|---|---|---|---|
| `endpoint` | OpenAPI Operation Object (method + path + requestBody + responses + security + x-brackish-*) | `<METHOD> <path>` | One per `(method, path)` |
| `schema` | JSON Schema (lives under `components.schemas[name]`) | `<Name>` | Reusable shapes (`User`, `OrderCreate`) |
| `convention` | `{ info, servers, securitySchemes }` (document-level header) | singleton | One per document |

Brackish-specific metadata uses OpenAPI's `x-` extension hatch:
- `x-brackish-idempotent: true` — declares intent (orthogonal to HTTP method)
- `x-brackish-side-effects: ["..."]`
- `x-brackish-timing: { p50, p99, timeout }`

These survive into rendered OpenAPI YAML; Swagger UI ignores them; brackish renders them.

## Workflow

```
brackish docs                    # list existing docs
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

## When the user says "let's negotiate the API"

1. `brackish whoami` — confirm you're configured. If it fails, `brackish init --identity <name>` and tell the user.
2. `brackish inbox` — see what's already in flight.
3. `brackish docs` — see what documents exist. Reuse or `brackish doc new`.
4. Propose the convention first (`brackish convention propose`), then the schemas, then the endpoints. The other side will accept/reject.
5. Use `brackish visualize` to see the assembled state; use `brackish endpoint/schema diff` to see what's changed.
