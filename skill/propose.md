# Propose reference

Read this for proposing artifacts — `brackish propose <noun> … --file` for one, or the whole-set form
`brackish propose --manifest <file>` for a coordinated drop. Also covers race protection and lint
pre-flight. (All artifact commands are verb-first and doc-scoped via `--doc`, which defaults to the
sole document. Every command is atomic — a `propose --manifest` commits all-or-nothing.)

## The three artifact kinds

Every brackish document assembles into a real OpenAPI 3.1 spec. Three kinds of negotiable artifact:

| Kind | What it is | Identity key |
|---|---|---|
| `endpoint` | OpenAPI Operation Object (method + path + requestBody + responses + security + `x-brackish`) | `<METHOD> <path>` |
| `schema` | JSON Schema (under `components.schemas[name]`) | `<Name>` |
| `convention` | `{ info, servers, securitySchemes, security, x-brackish }` (doc-level header) | singleton |

## Pick the right surface

- **1–2 artifacts** → per-kind `propose <noun> … --file`:
  ```
  brackish propose convention               --file convention.yaml --expected-new
  brackish propose schema   <Name>          --file schema.yaml     --expected-new
  brackish propose endpoint <METHOD> <PATH> --file op.yaml          --expected-new
  ```
- **3+ artifacts in one go** (any mix of kinds — five schemas counts; two schemas + an endpoint counts) → **`brackish propose --manifest <file>`**. Author a tiny manifest, run one command; each artifact is parsed + linted locally before any network call, then committed **atomically (all-or-nothing)**. This is the single biggest token-saver for the opening drop of a new document — N per-kind turns become 1.

**Fold the convention into the same batch** when you'd otherwise propose it standalone. If your naming/auth/server-url is non-contentious (sniffed from your framework), bundling it in saves a propose/accept cycle. Only split the convention out when you genuinely expect a debate on it (e.g. snake_case vs camelCase is a known team disagreement) — then a standalone propose-then-accept clears it before the schemas/endpoints that depend on it.

## Propose from a spec file

Propose is **file-only**: write the artifact's full body to a YAML/JSON file, lint it, then propose with `--file`. The file is a *complete* spec (not a diff) — for a revision, point `--file` at the new whole body and pass `--expected-rev <N>`.

```
# schema — the file IS the JSON Schema for components.schemas[Name]
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
brackish lint    schema User /tmp/User.yaml          # validate locally first (below)
brackish propose schema User --file /tmp/User.yaml --expected-new

# endpoint — the file IS the OpenAPI Operation Object
brackish propose endpoint POST /users/{id}/posts --file /tmp/op.yaml --expected-new

# convention — the file IS { info, servers, securitySchemes, security, x-brackish }
brackish propose convention --file /tmp/convention.yaml --expected-new
```

- **Endpoints:** `{id}` path placeholders need matching `parameters` entries (lint flags a mismatch). The convention's doc-level `security` is inherited unless the operation sets its own `security` (use `security: []` for an explicitly public op). Put brackish metadata at `x-brackish: { idempotent, sideEffects, timing }` (see [`patterns.md`](patterns.md)).
- **Convention:** `x-brackish.naming` (`camelCase` | `snake_case`) stamps the JSON-key policy — document it once. Endpoints + schemas inherit doc-level defaults; if the convention is rejected, hold dependents until it settles (`brackish status <doc>` shows a stalled convention under "needs attention").

## Lint your file locally first

`brackish lint <noun> <identity> <file>` runs the structural checks the server runs, plus path-placeholder ↔ parameters consistency — no round-trip needed:

```
brackish lint endpoint POST /users/{user_id} ./op.yaml
brackish lint schema   User ./User.yaml
```

Exit 0 = clean. Exit 1 = errors (the message names the field + the fix). `--strict` promotes warnings to errors. (There's no standalone convention lint — `propose --manifest`'s pre-flight lints a convention file, and `validate` checks the assembled doc.)

**`lint` (and `propose --manifest --lint-only`) is LOCAL only — it does not run the server's full OpenAPI 3.1 meta-schema validation against the assembled doc.** Green lint can still be rejected on propose. For the real check without writing anything, use `brackish validate <doc> --manifest manifest.yaml`: the server assembles accepted + your overlay exactly as `propose --manifest` would and validates the whole doc, committing nothing. Bare `brackish validate <doc>` checks the current accepted doc — run it when a propose fails citing field-paths you didn't touch (the doc itself may already be invalid).

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

- **`--expected-new`** — use for any first proposal. Refuses if any version exists. On 409: the other side already proposed; read with `brackish show <noun> <identity>` and react.
- **`--expected-rev <N>`** — use for revisions. Refuses unless the latest revision is exactly N (any status). On 409 `version_mismatch`: the peer slipped in their own N+1; re-read and reconcile.
- **`--force`** — only meaningful without `--expected-*`. Lets you stack a proposal on top of an unresolved `proposed` version. To counter a proposal, prefer **`brackish counter <noun> <id> --file <f> --rationale "<why>"`** — it rejects the current version and proposes your replacement in one atomic move. `--force` (or a manual reject + propose) is only for the rare case where you want both versions visible side-by-side.

**Default behavior** (no flags): brackish refuses a new propose when the latest is still `proposed`. You'll see `version_in_flight` with the in-flight proposer named. Recovery: read it, then accept / reject / counter-propose explicitly. Prefer explicit assertions (`--expected-new` / `--expected-rev`) over default behavior — the 409s catch the race window.

## Proposing many artifacts at once: `propose --manifest`

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
brackish propose --manifest manifest.yaml   # --doc defaults to the sole document
```

- Order is forced: convention → schemas → endpoints, regardless of manifest layout.
- Each `file:` is a **complete spec** (the same body `propose --file` consumes), parsed + linted **locally** first; the pre-flight is sequential and stops on the first parse/lint error, naming what was never reached.
- **The server commit is atomic.** Once pre-flight passes, the whole bundle is assembled + validated as one doc, then committed all-or-nothing. On a validation failure **nothing is written** — a rejected batch is safe to fix and re-run.
- `expected: new` is the default per item. Override per-item with `expected: <N>` for revisions or `expected: force` to stack.
- `--lint-only` (alias `--dry-run`) runs only the *local* pre-flight. For real server-side validation without committing, use `brackish validate <doc> --manifest <file>`.

## Ground in code, not docs

If the repo has prior API docs (`API.md`, an older `openapi.yaml`, a README schema block), treat them as a prior-negotiation snapshot, not ground truth. Stale docstrings are common; the actual emit/handler sites win. Before proposing a schema for a payload the peer produces, grep the emit site in their codebase (`response.json(...)`, `return jsonify(...)`, `WebSocket.send(...)`) and reconcile.

## Reject inline; don't double-message

`brackish reject <noun> <identity> --rationale "<reason>"` attaches the reason to the reject event — it renders in the rationale. A separate `brackish send` alongside is usually redundant. Use `brackish send` only when the rationale wouldn't fit (proposing an alternative spec sketch, for example).
