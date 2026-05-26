# Client-side workflow

Read this if you're consuming the API (cwd has React / Vue / Next / raw fetch / Swift / Kotlin client / equivalent).

Your job is to react to what the server side proposes — accept, reject with rationale, counter-propose when the shape doesn't fit your consumer's needs. Domain knowledge wins per side: you know what `EventSource` needs, what your codegen tool can/can't handle, what the UI actually renders.

## Step 1 — connect

**Cross-machine** (peer is on a different host): the human pastes a line they got from the server side:

```
/brackish connect http://1.2.3.4:11442 --token … --identity my-laptop
```

Run the bash equivalent (drop the `/`):

```
brackish connect http://1.2.3.4:11442 --token … --identity my-laptop
brackish whoami    # confirm identity is bound
brackish inbox     # pick up anything the server already sent
```

`brackish connect` writes `~/.brackish/config.toml` with the persistent token + identity + remote server URL. After this, every brackish command on your side transparently talks to the remote daemon. **Don't run `brackish up` on the client side** — the remote daemon is what you're talking to.

**Same-machine**: 
```
brackish up        # idempotent
brackish inbox     # see what the peer has dropped
```

## Step 2 — orient before responding

You're joining an in-progress negotiation. Lead with `brackish status <doc>` — it's a single bucketed view of awaiting-peer / awaiting-me / accepted, plus a "needs attention" bucket for rejected/withdrawn conventions. Don't start with `brackish read` (which dumps the full event log); start with `status` for the shape, then `read` only when you need *why* something changed.

If `status` shows the convention is rejected or withdrawn in "needs attention", **clear that before anything else**. Endpoints and schemas inherit doc-level defaults from the convention — accepting them on top of a stalled convention means re-accepting once it settles.

## Step 3 — accept the easy ones in batch

For schemas:
```
brackish accept schema --target User --target Order --target OrderItem --target Customer --target Address
```

Repeat `--target` per schema — the batch is **atomic**: the whole set is accepted in one transaction, or (if any target fails, or accepting them would leave the doc invalid) nothing is. So a mutually-referencing set accepts together, and a failure is safe to fix and re-run — there's no partial state. `--rev` (pin a specific revision) is only valid with a single `--target`; different schemas have different revision chains.

For endpoints (the colon separator is unambiguous; HTTP methods don't contain colons):
```
brackish accept endpoint \
  --target GET:/users \
  --target POST:/users \
  --target GET:/users/{id}
```

Same atomic all-or-nothing semantics. A single accept can take positional `<method> <path>` instead; mixing positional with `--target` is rejected — pick one form.

**Accept schemas before the endpoints that `$ref` them** — accepting an endpoint while its schema is still proposed leaves a dangling `$ref`, so brackish refuses it (`accept_orphans_ref`, naming the missing schema). Either accept the schemas first, or add **`--include-dependencies`** to the endpoint accept to pull the proposed `$ref`-closure into the same atomic batch:
```
brackish accept endpoint --target POST:/users --include-dependencies   # also accepts the proposed schemas POST /users references
```

**Don't accept everything blindly.** Reject anything that doesn't fit your consumer's needs (more on that in Step 4).

## Step 4 — reject + counter-propose

Reject with a reason — the reason is attached to the reject event and renders in the rationale, so a separate `brackish send` is usually redundant:

```
brackish reject endpoint POST /users --rationale "201 Created with Location header would let me skip a GET round-trip after create"
brackish reject schema   User --rationale "id should be UUID string, not integer — we use string IDs through the stack and codegen produces incompatible types otherwise"
```

If you have a concrete alternative in mind, that's a **counter**, not a plain reject — use `brackish counter` to reject the current proposal **and** propose your replacement in one atomic move:

```
brackish counter endpoint POST /users --file ./POST-users.v2.yaml --rationale "201 Created + Location header would save me a GET round-trip after create"
```

One transaction: either both land or neither does, so there's never a rejected-with-no-replacement window, and the move reads as a counter (not a refusal) in the log. The `--file` body is the full replacement spec (file-only — no inline `--response`/`--field` builders); `--rationale` is the reject reason. `--expected-rev <N>` means "I saw v<N>; refuse if state has drifted" — a 409 `version_mismatch` means the peer slipped in their own version, so re-read with `brackish read <doc>` and reconcile. (A plain `reject` with no `--file` is for when you just want it gone.)

## Step 5 — propose what the server doesn't know about

The server-side Claude sees its own emit/handler sites and proposes from there. You see things they don't:

- **The error envelope.** Servers often handwave error responses; you need a stable shape for your error-handling UI. Propose `Error` schema (and reject error responses that disagree).
- **Pagination + cursors.** What you actually need for an infinite-scroll UI vs what a backend might think is enough.
- **Idempotency keys.** If your client retries a POST, you need the server to dedupe — set `x-brackish.idempotent: true` in the endpoint's `--file` body (see [`patterns.md`](patterns.md)) and declare the idempotency-key header as a `parameters` entry in that body.

**If you're proposing 3 or more artifacts in a single turn, use `brackish propose --manifest manifest.yaml`** instead of N separate `propose` calls. One round-trip, atomic commit (all-or-nothing), mutual refs resolve within the set. See [`propose.md`](propose.md) for the propose flag reference + manifest shape (and [`patterns.md`](patterns.md) if SSE or WebSocket is in scope — those have canonical shapes you'll want to copy verbatim).

## Step 6 — wait between rounds

After you've reviewed everything in your inbox and responded:

```
brackish nap [--seconds 60]
```

Blocks for 60s, then snapshots the inbox. setTimeout-shape, not a recurring monitor — returns once. If `nap` returns empty twice in a row, ping the peer instead: `brackish send <doc> "I'm clear; what's blocking on your side?"`.

## Triaging a big drop

If `status` shows you holding ten or more incoming artifacts (server dumped a whole batch at once), don't power through. **Send a chat message proposing a review order**:

```
brackish send <doc> "I'll start with the convention + User/Auth schemas, then the auth endpoints, then come back for the rest. Reject any of those that need to ship sooner."
```

Gives the peer a chance to redirect (maybe `/health` matters more than auth schemas) and saves you re-running the same triage in your head each turn.

## Token-efficient catch-up

Use the compact paths in this order:

1. **`brackish status <doc>`** first. The "what am I blocked on?" view. Always start a turn here.
2. `brackish read <doc>` — events with `delta` summaries like `+responses.409`; reach for it after `status` when you need *why*, not just *what*.
3. `brackish show endpoint METHOD /path` — tagged accepted/proposed with body inline. Shows both when both exist (peer revising an already-accepted artifact), with a `delta vs accepted` annotation on the proposed.
4. `brackish diff <noun> <id> --from N --to M` — RFC 6902 JSON Patch between versions. For "I rejected v1, what's different in v2", this is the smallest possible context cost.
5. `brackish visualize <doc>` — table-of-contents view; `--format openapi` writes the assembled YAML; `--format markdown` is human-readable with rationale interleaved.

**Don't pull a full spec body until you've decided you need it.** The delta summary + diff tell you what changed at a fraction of the bytes.

## Respect a scope-freeze

If the server side sends a "we're settled at <milestone>; X/Y/Z out of scope" chat message after the core contract is accepted, **don't pile on**. New ideas after the freeze go in one of two buckets:

- **Genuinely needed for the client to function** — propose it, but acknowledge in the propose rationale (`brackish send`) that you saw the freeze and explain why this one is essential rather than nice-to-have.
- **Nice-to-have / "while we're here"** — hold for the next round. Don't propose now; jot it in `notes.md` (or a comment) for later.

If the server rejects your post-freeze proposal with an "out of scope" reason, accept it — withdraw your proposal (`brackish withdraw <noun> <selector>`) and move on. Don't argue.
