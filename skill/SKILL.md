---
name: brackish
description: Two Claude Code instances co-developing a REST API contract — frontend ↔ backend, producer ↔ consumer, Python server ↔ TS client. Triggers — "the backend Claude", "frontend's in another window", "we're co-developing X", "let's negotiate the X API", `/brackish invite <peer>`, `/brackish connect URL --token T --identity N`. Use whenever you're about to commit to a contract another Claude implements the other side of (TS interface, pydantic model, JSON Schema, OpenAPI fragment, response-shape assumption). NOT for internal types, single-developer projects, or where the API has already shipped. Negotiates a real OpenAPI 3.1 document via propose/accept/reject lifecycle with diff-based churn. **READ THE SUBFILES** before running commands — server.md (you implement the API) or client.md (you consume it). They contain non-obvious ordering and flag requirements. Critical points the body teaches that you WILL get wrong without reading: cross-machine bind defaults to loopback, you must pass `brackish up --bind 0.0.0.0` explicitly; per-document ACLs gate every doc-scoped TCP endpoint, so the server's invite MUST include `--grant <doc>` AND the doc MUST be created BEFORE the invite is minted, else the peer redeems successfully but is locked out with `forbidden: not a member of "<doc>"` on every read. Verb-first grammar (`brackish <verb> <noun> [identity]`, doc-scoped via `--doc`, defaulting to the sole doc); batch via repeated `--target` (`brackish accept schema --target A --target B`, `brackish accept endpoint --target GET:/a --target POST:/b`), or `brackish propose --manifest manifest.yaml` for the atomic initial drop. Every command is atomic (all-or-nothing) — batch accept and `propose --manifest` commit as one unit or not at all. Role-specific workflow lives in subfiles: server.md (you implement the API), client.md (you consume it), propose.md (flag reference + manifest), patterns.md (WS/SSE/x-brackish canonical shapes).
---

# brackish — negotiate an OpenAPI document with the other Claude

You're paired with **another Claude Code instance** building the other half of a REST API. brackish is a message bus + structured propose/accept lifecycle for OpenAPI 3.1: endpoints, schemas, and a document-level convention. Use it to *agree on the contract* rather than each guessing.

**Every command is atomic — all-or-nothing.** A command either fully succeeds or changes nothing on the shared doc; there is no partial state to reconcile. A multi-artifact `propose --manifest` or a batch `accept --target X --target Y` commits as one unit: if any item fails — or the assembled doc wouldn't validate as OpenAPI 3.1 — the whole command is rejected and **nothing is written**. So failures are always safe to fix and re-run the same command; you never inherit a half-applied move.

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
- **[`propose.md`](propose.md)** — propose-verb flag reference (endpoint / schema / convention), `--file` vs flags, lint pre-flight, race-protection, `propose --manifest`.
- **[`patterns.md`](patterns.md)** — WebSocket handshake, SSE stream, `x-brackish.*` canonical shapes. Read this if WS or SSE is in scope.

## Verb cheat sheet

**Grammar: artifact commands are VERB-FIRST — `brackish <verb> <noun> [identity]`.** It's `brackish show schema User`, **not** `brackish schema show User`; `brackish accept endpoint GET /users`, **not** `brackish endpoint accept`. Verbs: `propose accept reject counter withdraw show diff list lint`. Nouns: `endpoint schema convention retraction`. The document is the **`--doc <name>` option** (defaults to the sole doc) — never a positional, so it's `propose --manifest m.yaml --doc X`, **not** `propose X --manifest m.yaml`. (The standalone doc-level commands — `status` / `read` / `send` / `validate` / `visualize` / `nap` / `deliver` / `wait` — are the exception: they take the doc as a positional `<doc>`.)

One-liner + sample per verb. Subfiles have the deeper flag reference and worked examples.

### Daemon + identity

```
brackish up                                           # start daemon, loopback only (same-machine)
brackish up --bind 0.0.0.0                            # start daemon, LAN-reachable (cross-machine, trusted networks only)
brackish down                                         # stop daemon
brackish whoami                                       # show your identity + the server you're pointing at
brackish documents                                    # list docs you can access (alias: docs)
```

### Documents + ACL

```
brackish doc new <name>                               # create doc (you become owner)
brackish doc grant <doc> <identity> [--owner]         # add a peer as member (or owner) of an existing doc
brackish doc revoke <doc> <identity>                  # remove a peer's membership
brackish doc members <doc>                            # list current members
```

### Cross-machine bootstrap

```
brackish invite <peer> --grant <doc> --ttl 86400 --json   # mint invite; --grant binds peer to doc on redeem
brackish connect <url> --token <T> --identity <peer>      # redeem invite (peer side)
```

`--grant <doc>` is **required for cross-machine** — without it the peer redeems but is locked out by ACL. Repeat `--grant` per doc.

### Orient — start every turn here

```
brackish status <doc>                                 # awaiting-peer / awaiting-me / accepted / needs-attention; rows annotated with (blocked on: X) when a $ref isn't accepted yet
brackish inbox [--quiet-if-empty] [--json]            # cross-doc summary of peer events newer than your cursor
```

### Read events

```
brackish read <doc>                                   # events since cursor (advances cursor)
brackish read <doc> --tail N                          # peek last N events (does NOT advance cursor)
```

**Grammar:** artifact commands are `brackish <verb> <noun> [identity] [flags]` (e.g. `accept endpoint GET /users`). They act on the **sole document by default** — pass `--doc <name>` only when several exist. (The doc-level verbs — `status`/`read`/`send`/`validate`/`visualize` — still take the document as a positional.)

### Show artifact body

`show` always returns whatever's live, tagged by status. If both an accepted version AND a newer proposed version exist (rare: peer revising an already-accepted artifact), both are shown with a `delta vs accepted` annotation on the proposed one. For walking historical versions, use `diff <noun> --from N --to M`.

```
brackish show endpoint <METHOD> <PATH>     # tagged accepted and/or proposed, with body
brackish show schema   <Name>
brackish show convention
```

### Propose — from a spec file

**Propose is file-only.** Write the artifact (an OpenAPI Operation / JSON Schema / Convention block) to a YAML or JSON file, then propose it with `--file` (lint the file first — see below). **First proposal: `--expected-new`. Revision: `--expected-rev <N>`. Both protect against races (409 on mismatch).**

```
brackish propose endpoint   <METHOD> <PATH> --file <file> --expected-new
brackish propose schema     <Name>          --file <file> --expected-new
brackish propose convention                 --file <file> --expected-new
brackish propose --manifest manifest.yaml [--lint-only]              # initial drop: convention + schemas + endpoints, atomically
```

**If you're proposing 3+ artifacts in a turn, use `propose --manifest` — one round-trip, atomic commit, mutual `$ref`s resolve within the set.** It's all-or-nothing: on any validation failure **nothing is written**, so a rejected drop never leaves partial state on the shared doc. See [`propose.md`](propose.md) for the manifest shape.

### Validate (dry-run — writes nothing)

```
brackish validate <doc>                          # is the current accepted doc valid OpenAPI 3.1? lists every problem
brackish validate <doc> --manifest manifest.yaml # would proposing this whole set leave the doc valid? (same assembly as propose --manifest)
```

The real assembled-doc check — `--lint-only` on `propose --manifest` only runs *local* lint, which passes specs the server's full 3.1 validation then rejects. Run `validate` before a big drop, and run bare `validate <doc>` if a propose fails citing field-paths that aren't yours (the doc may already be invalid).

### Accept / reject / withdraw

```
brackish accept   endpoint <METHOD> <PATH> [--rationale "<why>"]   # peer-only
brackish accept   schema   <Name>          [--rationale "<why>"]
brackish accept   convention               [--rationale "<why>"]
brackish accept   schema   --target User --target Order           # batch: repeat --target (schema/endpoint)
brackish accept   endpoint --target GET:/a --target POST:/b       # endpoint refs are METHOD:PATH
brackish accept   endpoint --target POST:/x --include-dependencies # also accept the proposed schemas POST /x $refs, same atomic batch
brackish reject   <noun> <identity> --rationale "<reason>"        # peer-only; a reason is required
brackish counter  <noun> <identity> --file <f> --rationale "<why>" # peer-only: ONE atomic move — reject current + propose your replacement
brackish withdraw <noun> <identity>                               # take back your own still-proposed version (proposer only)
```

**Countering?** Use `counter`, not reject-then-propose. It rejects the peer's current proposal **and** proposes your `--file` replacement in one transaction — no rejected-with-no-replacement window, and the log reads it as a counter, not a refusal. (`--expected-rev <N>` guards the race; `--force`/manual reject+propose only if you want both versions visible side-by-side.)

`--rationale "<text>"` rides on the `artifact_accepted` / `artifact_rejected` event, so the peer sees the reason without a separate `brackish send`. Single accept names the artifact; batch accept repeats `--target <ref>` and is **atomic** — the whole set is accepted in one transaction, or (if any target fails, or accepting them would leave the doc invalid) nothing is, so a mutually-referencing set accepts together and a failure is safe to re-run. `--rev <N>` pins a specific version (single target only). **Accepting an endpoint whose schemas aren't accepted yet?** Either accept the schemas first, or add `--include-dependencies` to pull the proposed `$ref`-closure into the same atomic accept (it reports what it auto-included).

### Retract — negotiated removal of ACCEPTED artifacts

```
brackish propose  retraction --endpoint "GET /a" --schema Foo [--convention] --rationale "<why>"
brackish list     retraction [--all]                          # pending retractions (awaiting you/peer)
brackish accept   retraction <id>                             # peer-only: removes the set
brackish reject   retraction <id> --rationale "<reason>"      # peer-only: artifacts stay
brackish withdraw retraction <id>                             # proposer takes it back
```

Removing an accepted artifact is **negotiated**, just like adding one: `propose retraction` opens a grouped removal (a coordinated set named by `--endpoint`/`--schema`/`--convention`), and the **peer** accepts (the whole set is tombstoned, validated fully-valid-after) or rejects — nothing leaves the shared contract unilaterally. The artifacts stay live until the retraction is accepted. Name a set that references each other **together** so the post-removal doc stays valid; that's also the escape hatch for a wedged doc (accepted-but-invalid, e.g. validated under an older OpenAPI checker) — propose retracting the whole invalid set, the peer accepts, then re-propose clean.

### List the roster

```
brackish list endpoint                                # accepted + proposed endpoints in the doc
brackish list schema
brackish list retraction [--all]
```

### Diff between versions

```
brackish diff endpoint <METHOD> <PATH> [--from N] [--to M]
brackish diff schema   <Name>          [--from N] [--to M]
brackish diff convention               [--from N] [--to M]
```

Defaults: `--to` is latest version (any status), `--from` is `to-1`. Add `--format rendered` for a unified YAML diff, `--format yaml|json` for the full body of v<to>.

### Free-text chat

```
brackish send <doc> "<text>"                          # chat message — scope claims, clarifications, "settled" notes
```

### Deliver / wait / nap

**Your moves are HELD until you deliver them — the peer sees nothing of your turn until then.** Make all your moves (propose/accept/reject/retract/send), then hand off. This keeps the peer from reacting to a half-formed turn.

```
brackish deliver <doc>                                # hand off: make your held moves visible to the peer, as one batch
brackish wait <doc> --timeout 60                      # long-poll for peer activity (delivers your held moves first)
brackish nap [--seconds 60]                           # sleep + snapshot inbox (delivers first); preferred between rounds
```

`wait` and `nap` imply `deliver`, so ending a turn with either hands off automatically — you only need explicit `deliver` if you're stopping without napping/waiting. Delivering nothing is a no-op (won't ping the peer). Your own moves' effects show in `status` immediately; it's the *event feed* to the peer that's held.

### Lint locally (no server round-trip)

```
brackish lint endpoint <METHOD> <PATH> <file>       # validates your --file body before propose (local; no daemon)
brackish lint schema   <Name> <file>
```

### Visualize / export

```
brackish visualize <doc> --format openapi --out spec.yaml    # feeds openapi-typescript, oapi-codegen, etc.
brackish visualize <doc> --format markdown                   # full doc + interleaved negotiation history
brackish visualize <doc> --format html                       # Swagger UI + rationale sidebar (loopback only)
```

### Rules of thumb

- **Start every turn with `brackish status <doc>`.** It's the cheapest orientation call, and annotates rows with `(blocked on: X)` so you don't try to accept something whose `$ref` isn't ready.
- **`show` returns whatever's live — accepted, proposed, or both, tagged.** No flag needed to pick which; you'll see what exists.
- **Three of the same verb in a row means wrong verb.** Switch to batch (`propose --manifest` for the initial drop, or `accept <noun> --target X --target Y` to accept a set).
- **`--expected-new` and `--expected-rev <N>` aren't optional ceremony** — they're how you find out the peer raced you (409) instead of silently overwriting.
- **Deferring is fine — you don't have to resolve every pending item each turn.** If a proposal's correctness depends on another artifact that isn't settled yet, leave it `proposed`; it persists until you act, and accept/reject when the dependency lands. Drop a one-line `send` so the peer knows it's deferred, not forgotten (e.g. "holding my accept on the endpoint until the schema it `$ref`s is settled"). This is normal staged evolution, not an escape hatch.

## Once an artifact is accepted

That's the contract. Render and use it:

- Frontend: `brackish visualize <doc> --format openapi --out openapi.yaml` → feed to `openapi-typescript`, `orval`, etc.
- Backend: same YAML → `oapi-codegen`, `fastapi-codegen`, equivalents.
- Human eyes: open `http://localhost:<port>/ui/<doc>` (if `brackish serve` is running) for Swagger UI + the brackish rationale sidebar.

If the other side later changes an accepted artifact, you'll get an `artifact_proposed` event with a bumped version and a compact delta showing exactly what shifted. Accept, reject, or leave it pending if it hinges on something still in flight; regenerate once it's accepted.

## Staying in sync (foreground loop — no background hook)

brackish doesn't install a background hook right now; you drive the loop in the foreground. Two moves keep you in sync:

- **`brackish status <doc>`** at the top of any turn — the bucketed "what's awaiting me / what changed?" view.
- **`brackish nap [--seconds 60]`** after you've acted — blocks briefly, then snapshots the inbox so you see what landed.

Check in when it's your move; you needn't respond to everything in one turn (see "Deferring is fine" above). When the peer revises an accepted artifact you'll see it next time you `status`/`nap`, with a compact delta of what shifted.

**When you're done negotiating and switching to implementing** the agreed contract, run `brackish down` to stop the daemon. The skill stays installed (Claude still loads it on demand).

## Output conventions

- Compact text by default; `--json` for structured output.
- `brackish show endpoint METHOD PATH > endpoint.yaml` writes a clean file (metadata goes to stderr).
- Exit codes: `0` = success (incl. timed-out `wait`); `1` = operation error (4xx); `2` = config/auth/connection error.
