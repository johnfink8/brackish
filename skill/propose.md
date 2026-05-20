# Propose verb reference

Read this when you need flag syntax for `brackish endpoint propose`, `brackish schema propose`, `brackish convention propose`, or `brackish propose-batch`. Also covers race protection and lint pre-flight.

## The three artifact kinds

Every brackish document assembles into a real OpenAPI 3.1 spec. Three kinds of negotiable artifact:

| Kind | What it is | Identity key | When to use |
|---|---|---|---|
| `endpoint` | OpenAPI Operation Object (method + path + requestBody + responses + security + `x-brackish`) | `<METHOD> <path>` | One per `(method, path)` |
| `schema` | JSON Schema (under `components.schemas[name]`) | `<Name>` | Reusable shapes (`User`, `OrderCreate`) |
| `convention` | `{ info, servers, securitySchemes, security, x-brackish }` (doc-level header) | singleton | One per document |

## Pick the right verb up front

Two propose surfaces; the right one depends on how many artifacts you're about to drop:

- **1–2 artifacts** → per-kind: `brackish convention propose <doc>`, `brackish schema propose <doc> <name>`, `brackish endpoint propose <doc> <METHOD> <PATH>`. Sections below.
- **3 or more artifacts in one go** → **`brackish propose-batch <doc> --manifest <file>`**. Author a tiny manifest, run one command. Each artifact gets parsed + linted locally before *any* network call; on first failure you stop with a clear "what landed / what's left" summary. This is the single biggest token-saver for the opening drop of a new document — N per-kind `propose` turns become 1.

```
# manifest.yaml — block-style only ({placeholder} parens trap flow-mappings)
convention:
  file: convention.yaml
schemas:
  - name: User
    file: schemas/User.yaml
  - name: Order
    file: schemas/Order.yaml
endpoints:
  - method: POST
    path: /orders
    file: endpoints/POST-orders.yaml
  - method: GET
    path: /orders/{id}
    file: endpoints/GET-orders-id.yaml

# then:
brackish propose-batch <doc> --manifest manifest.yaml
```

Each `file:` in the manifest is a **complete spec** (same shape `<kind> propose --file` consumes), **not a diff** — for revisions, set `expected: <N>` and point at the new whole body. Order is forced: convention → schemas → endpoints, regardless of how the manifest is laid out. Full reference + revision/force semantics in the "Proposing many artifacts at once" section below.

## Convention propose

```
brackish convention propose <doc> --expected-new \
  --title "Orders API" --api-version 1.0.0 \
  --server-url https://api.example.com --server-description "production" \
  --security-scheme "bearer:http:bearerFormat=JWT" \
  --global-security bearer \
  --naming camelCase
```

- `--server-url` + `--server-description` are unambiguous. The older colon-form `--server "url:description"` still works but mis-parses on URLs containing a port colon (`http://host:8000:desc`); brackish warns when it sees that shape.
- `--global-security bearer` emits an OpenAPI doc-level `security: [{ bearer: [] }]`. Endpoints inherit it automatically (no `--security` per endpoint needed). Opt out per-endpoint with `--no-inherit-security` — emits `security: []` on that op, OpenAPI's spelling for "no auth required".
- `--naming camelCase` or `--naming snake_case` stamps the JSON-key policy onto `x-brackish.naming`. Document the casing decision once.

**If the convention gets rejected, hold off on proposing dependents.** Endpoints + schemas inherit doc-level defaults from it. `brackish status <doc>` shows a stalled convention in "needs attention" — clear it first.

## Schema propose

Two forms. **Prefer `--file` for anything beyond flat primitives.**

```
# Flat-primitives form (sugar):
brackish schema propose <doc> User --expected-new \
  --field 'id:string' --field 'email:string' --field 'displayName:string?'

# Full JSON Schema (preferred):
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
brackish schema propose <doc> User --expected-new --file /tmp/User.yaml
```

`--field` handles primitives + arrays + `$ref`s. As soon as you need **nullable, enum, nested objects, arrays of refs, additionalProperties, oneOf/anyOf, or per-field examples**, switch to `--file`.

## Endpoint propose

```
brackish endpoint propose <doc> POST /users/{id}/posts --expected-new \
  --summary "Create a post for a user" \
  --request-content 'application/json=PostCreate' \
  --response '201:application/json:Post:created' \
  --response '409:application/json:Error:duplicate'
```

- `{id}` placeholders auto-become a `parameters` entry (`name: id, in: path, required: true, schema: { type: string }`).
- The convention's `--global-security` flows in as the operation's `security` — only set `--security` per-endpoint to override, or `--no-inherit-security` to make an endpoint explicitly public (emits `security: []`).
- For brackish metadata, dedicated flags:
  ```
  brackish endpoint propose <doc> POST /orders \
    --idempotent \
    --side-effect "writes orders row" --side-effect "publishes order.created" \
    --timing-p50 20ms --timing-p99 150ms
  ```
  These land at `x-brackish: { idempotent, sideEffects, timing }` per the canonical shape.

## Lint your `--file` locally first

Before sending, `brackish <kind> lint` runs the same structural checks the server runs, plus path-placeholder ↔ parameters consistency and a few other cheap ones. Catches missing `parameters` entries for `{user_id}` or `--global-security` referencing an undeclared scheme — no round-trip needed:

```
brackish endpoint   lint POST /users/{user_id} ./op.yaml
brackish schema     lint User ./User.yaml
brackish convention lint ./convention.yaml
```

Exit 0 = clean. Exit 1 = errors (the message names the field and the fix). `--strict` promotes warnings to errors.

## `--file` clobbers other CLI flags

If you pass `--file convention.yaml --global-security bearer`, the `--global-security` is silently dropped (brackish 0.3.1+ warns to stderr, but the file still wins). **Bake every field into the file**; flags don't merge.

Same rule for `endpoint propose --file` and `schema propose --file`.

## Block-style YAML when text contains `:`, `,`, `(`, `{`

Flow-mappings with embedded colons parse confusingly:

```yaml
# Foot-gun (flow-style with embedded colon):
description: "salience: interrupt; barge over current speech"

# Safer (block-style):
description: |
  salience: interrupt; barge over current speech
```

## Avoid races: declare what version you expect

Two agents can independently decide to propose the same identity at roughly the same time. Three opt-in flags guard every `propose`:

- **`--expected-new`** — use for any first proposal. Refuses if any version exists. On 409: the other side already proposed; read with `brackish <kind> show <id> --proposed` and react.
- **`--expected-version <N>`** — use for revisions. Refuses unless latest is exactly N (any status). On 409 `version_mismatch`: the peer slipped in their own N+1; re-read and reconcile.
- **`--force`** — only meaningful without `--expected-*`. Lets you stack a counter-proposal on top of an unresolved `proposed` version. Normal counter-proposal recipe is **reject first, then propose** with `--expected-new`; `--force` is for the rare case where you want both versions visible side-by-side.

**Default behavior** (no flags): brackish refuses a new propose when the latest is still `proposed`. You'll see `version_in_flight` with the in-flight proposer named. Recovery: read it, then accept / reject / counter-propose explicitly.

The 409s are your friend — they catch the race window. Prefer explicit assertions (`--expected-new` / `--expected-version`) over default behavior.

## Proposing many artifacts at once: `propose-batch --manifest`

For >5 artifacts (typical opening dump for a non-trivial API), write a manifest:

```yaml
# manifest.yaml — block-style, not flow-style (the {placeholder} traps flow-mapping parsers)
convention:
  file: convention.yaml
schemas:
  - name: User
    file: schemas/User.yaml
  - name: Order
    file: schemas/Order.yaml
endpoints:
  - method: POST
    path: /orders
    file: endpoints/POST-orders.yaml
  - method: GET
    path: /orders/{id}
    file: endpoints/GET-orders-id.yaml
```

```
brackish propose-batch <doc> --manifest manifest.yaml
```

- Order is forced: convention → schemas → endpoints, regardless of manifest layout.
- Each file is parsed + linted **locally** before sending. Parse errors surface with line/col; lint errors include the field path. Round-trip cost only on real disagreements with the peer.
- `expected: new` is the default per item. Override per-item with `expected: <N>` for revisions or `expected: force` to stack.
- Stop-on-first-failure: prints what landed, names the failing item, lists what was never attempted.
- `--lint-only` (alias `--dry-run`) runs the pipeline without sending — useful for CI or sanity-checking before a big drop.

## Ground in code, not docs

If the repo has prior API docs (`API.md`, an older `openapi.yaml`, a README schema block), treat them as a prior-negotiation snapshot, not ground truth. Stale docstrings are common; the actual emit/handler sites win. Before proposing a schema for a payload the peer produces, grep the emit site in their codebase (`response.json(...)`, `return jsonify(...)`, `WebSocket.send(...)`) and reconcile.

## Reject inline; don't double-message

`<kind> reject <doc> <selector> "<reason>"` attaches the reason to the reject event — it renders in the rationale. A separate `brackish send` alongside is usually redundant. Use `brackish send` only when the rationale wouldn't fit (proposing an alternative spec sketch, for example).
