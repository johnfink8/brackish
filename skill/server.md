# Server-side workflow

Read this if you're implementing the API (cwd has FastAPI / Express / Hono / Rails / actix / equivalent).

You're the source of truth for what the API actually emits. Your job is to drop a high-confidence initial artifact set on the peer's inbox so they have something concrete to react to instead of a blank page.

## Step 1 — start the daemon

**Cross-machine** (peer is on a different host):
```
brackish up --bind 0.0.0.0
```
Idempotent. If the daemon was already up without TCP, run `brackish down && brackish up --bind 0.0.0.0`. Bare `--bind` (no address) resolves to `127.0.0.1` — loopback-only, the peer on another host can't reach it, so for cross-machine you want `0.0.0.0` explicitly. The daemon prints a security warning banner on non-loopback binds — surface that to the human along with the connect URL.

**Same-machine** (peer Claude is on the same host):
```
brackish up
```
Unix-socket transport; no invite needed. Skip step 3 below.

## Step 2 — create the document + claim scope

```
brackish documents                  # list existing docs (alias: brackish docs)
brackish doc new <doc-name>         # use the name the human gave you in Step 0
brackish send <doc-name> "<scope claim>"
```

The scope claim is the human's answer to Step 0's question 1, paraphrased into one chat message. Example:

```
brackish send orders-api "I'm the API server. Scope: /v2/orders/* — the order CRUD + line-item operations. Auth via bearer JWT. I'll propose convention + schemas + endpoints for that surface; reject anything that drifts outside."
```

This is the single highest-leverage move for avoiding duplicate-name collisions and out-of-scope churn.

## Step 3 — mint the invite (cross-machine only)

**Prerequisite: Step 2 must already be done.** The doc has to exist before the invite is minted, because the invite carries a `--grant` that binds the peer's membership at redeem time. Skip Step 2 and the peer will redeem successfully but get `forbidden: not a member of "<doc>"` on every read.

```
brackish invite <peer-name> --grant <doc-name> --ttl 86400 --json
```

`--grant <doc-name>` is **required** for cross-machine. Per-document ACLs gate every doc-scoped TCP endpoint, so without the grant the redeeming peer authenticates but is locked out of the doc. Pass `--grant` once per doc you want the peer to access (repeatable).

The output's `connectCommand` field is a bash string. **Replace the leading `brackish ` with `/brackish `** and print the result on its own line — the human pastes it verbatim into the peer Claude:

```
/brackish connect <URL> --token <T> --identity <peer-name>
```

`--ttl 86400` (24h) avoids invites expiring mid-session.

## Step 4 — drop the initial artifact set

Don't wait for the peer to ask "what are we negotiating?". Sniff your own cwd briefly (≤30s) and drop a high-confidence starter set.

**Use `brackish propose-batch` for the initial drop, not N separate `propose` calls.** A starter set is almost always 3+ artifacts (convention + 2-4 schemas + 2-4 endpoints). Write one manifest, run one batch — single round-trip, single atomic commit, mutual refs resolve in any order within the bundle. See [`propose.md`](propose.md) for the manifest shape.

What to include in the initial bundle:

1. **Convention first.** Bake in document-level defaults — JSON-key naming policy (sniff from your framework: snake_case for FastAPI/Django, camelCase for Express/Hono), auth scheme, server URL.
2. **Schemas next.** The 2–4 highest-confidence request/response shapes from your source code (typically `User`, the primary entity, and an error envelope).
3. **Endpoints last.** The 2–4 endpoints whose shapes are settled in code. Skip anything ambiguous — the peer should reject those, not accept-then-revise.

**Don't propose the whole API surface upfront.** Give the peer a concrete starting point and let the negotiation guide what comes next.

## Step 5 — respond to peer reactions

After the peer connects (`/brackish connect` runs on their side), you'll see their acceptances/rejections appear in your inbox. Workflow on a turn:

1. **Start with `brackish status <doc>`** — bucketed view of awaiting-peer / awaiting-me / accepted / needs-attention. This is your "what changed?" view.
2. For things awaiting your review (peer counter-proposed or proposed something new), use `brackish endpoint show <doc> ... --proposed` to read what they sent.
3. **When the peer revises after a rejection** — `brackish <kind> diff <doc> <selector> --from N --to M` shows the RFC 6902 patch between two versions (defaults: previous and latest). Cheapest possible context for "what actually changed in v2"; skip re-reading both bodies. `--format rendered` gives side-by-side YAML if you want to see the change in context, `--format yaml` / `--format json` gives the new body wrapped in an envelope.
4. Accept (`brackish <kind> accept`), reject with a reason (`brackish <kind> reject <doc> <selector> "<reason>"`), or counter-propose (reject first, then propose your alternative with `--expected-new`). Both accept and reject take `--rationale "<text>"` so your reasoning rides on the event itself — no separate `brackish send` needed.
5. When you've responded to everything, `brackish nap [--seconds 60]` blocks for a minute then snapshots the inbox. If `nap` returns empty twice, `brackish send <doc> "<status>"` to ping the peer instead of napping a third time.

See [`propose.md`](propose.md) for the propose flag reference and race-protection (`--expected-version`, `--force`).

## Common race recovery

- **`version_in_flight`** (409): the peer proposed a new version while you were also proposing. Read `brackish <kind> show <doc> <selector> --proposed`, decide accept / reject / counter, then re-propose with `--expected-version <N>` where N is the latest you've seen.
- **`version_mismatch`** (409): you passed `--expected-version 3` but the latest is `4`. Re-read with `brackish read <doc>` and reconcile.
- **`cannot_accept_own`** (403): you tried to accept something you proposed. Wrong side; the peer accepts your proposals, you accept theirs.
- **Rejected convention blocks dependents.** If `status` shows the convention in "needs attention" (rejected/withdrawn), endpoints and schemas inherit doc-level defaults from it — proposing them on top of a stalled convention means re-proposing once it settles. Clear the convention first.

## Scope-freezing the current milestone

When the current milestone's contract is accepted and you don't want the peer to keep piling on out-of-scope additions, **send a chat boundary message** — no new CLI verb needed:

```
brackish send <doc> "<doc> is settled at <whatever you're calling this milestone — info.version, 'MVP', 'first cut', etc.>: <list the accepted endpoints/schemas>. <X, Y, Z> are out of scope here — please hold them for the next round."
```

Then **reject any proposal that crosses the line**, citing scope: `brackish endpoint reject <doc> <METHOD> <PATH> "out of scope for the current milestone per the boundary message; hold for next round"`. The reject reason is attached to the artifact and renders in the rationale, so the peer Claude has the boundary in writing.

`brackish status <doc>` will also nudge you toward this once everything's accepted + nothing's awaiting either side — read its `→ next:` line.

## Tear down later

```
brackish down
```

Stops the daemon. Cross-machine state in `~/.brackish/` persists.
