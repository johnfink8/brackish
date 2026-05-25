# Renegotiation & import — phase 2 roadmap

> Planning doc. Captures the design direction for making contract *evolution* (not just
> greenfield negotiation) a first-class brackish process. **Re-scoped 2026-05-25** after the
> first renegotiated-doc e2e trial — see "What the trial changed" below; the priority order
> there supersedes the original speculative list.

## The three lifecycle situations

brackish supports exactly one of these well today:

| # | Situation | Starting state | Status |
|---|-----------|----------------|--------|
| 1 | **New from scratch** | empty doc | ✅ first-class (the happy path the tool was built for) |
| 2 | **Renegotiate** | an agreed, in-use, possibly-shipped contract | ⛔ phase 2 — treated like #1 today |
| 3 | **Import** | an existing external spec, often *invalid* | ⛔ phase 2 — no path in today |

#1 converges from nothing. #2 and #3 both **start from a populated (and possibly broken) state and must converge without a full manual rebuild.** That shared shape — "begin from existing artifacts" — is what's missing.

0.6.1 shipped the *don't-get-stuck* primitives (`retract`, `validate`, atomic-batch legibility, self-diagnosis hint). Those make a wedged doc *recoverable*; they do not make #2 or #3 *first-class*.

## Evidence: the clyde-api v1→v2 renegotiation (real session)

Pulled from a live `.brackish` db. Two acts:

- **Act 1 (greenfield, ~15 min):** 1 convention + 38 schemas + 14 endpoints proposed/reviewed/accepted cleanly. The tool worked.
- **Act 2 (renegotiation, 5 days later):** server re-architected `/converse`; reopened the contract for a real evolution (SV gate removed, long-running session, barge-in). It **wedged**, then forced a full rebuild on a fresh doc.

Confirmed by running our own validator on the stored doc — the wedge was **exactly 2 errors**, both `must NOT have unevaluated properties`:
- `/converse` responses keys: `101, 401, 1000, 1008, 1011`
- `/events` responses keys: `101, 401, 1001`

The `1xxx` are **WebSocket close codes used as HTTP response keys** — invalid in 3.1. Two independently-invalid endpoints ⇒ every propose tripped on the *other* one ⇒ unfixable in place.

### What it cost (the headline numbers)

- Wedge size: **2 endpoints.** Escape: recreate the **entire** contract on `clyde-api-v2` — **108 events in ~16 minutes.**
- By their own words: *"the 29 carryover schemas were extracted from v1's rendered spec and re-proposed with ZERO content edits."* ⇒ **~80% of the rebuild was mechanically re-proposing unchanged artifacts.** The actual renegotiation delta was ~7 changed schemas + 2 removed.
- The recovery path (render → re-propose) hit the path-param drop bug: *"for the three path-param ops … the renderer had DROPPED the path `parameters` entry, so I re-synthesized the standard block."*

### Every renegotiation primitive was hand-rolled in chat

| Improvised via `brackish send` | Missing capability |
|---|---|
| *"Re-opening clyde-api for a full re-review. Context: … Key changes: (1)…(4)…"* | reopen-with-scope |
| *"clyde-api-v2 SUPERSEDES clyde-api … Retire v1 on your side"* (asked **twice**) | `doc supersede` / `doc retire` |
| *"29 carryover schemas extracted from v1's rendered spec and re-proposed"* | `doc fork` |
| *"HOLD review on [5 schemas]"* → reversed 1 min later → *"NEXT ROUND: utterance_id"* | milestone / deferred-round scoping |
| *"it'll be a breaking change server-side"*, *"ConverseHeardEvent is dead"* | breaking-change classification |

**Takeaway:** the validation wedge was the *visible* failure, but the *larger* cost was that brackish treats a 5-day-old, 53-artifact, re-architected contract exactly like an empty doc — no fork, no supersession, no diff-sized expression of change.

## What the renegotiated-doc trial changed (2026-05-25)

We ran the in-place renegotiation as an e2e trial (`trials/renegotiation-20260525-120231/`, chat-api poll→SSE-push, retire `GET /messages`). It **succeeded in 4 rounds** using only 0.6.1's `retract` + `validate` — and the result reordered this whole plan. The speculative priority list above (fork #1, breaking-classification #2, supersede #3) did **not** match what actually bit.

Two findings drive the revision:

**A. The pains we feared belong to the *fork-to-new-doc* path, not in-place evolution.**
- **No carryover cost in-place.** They left every unchanged artifact alone (zero re-proposes). The ~80% carryover tax was specific to clyde *forking to a fresh doc* and re-proposing everything. Routine in-place reneg doesn't pay it → `doc fork`'s value is the new-doc / wedged-doc escape only, **not** routine evolution.
- **Supersede/retire not missed** — `retract` + an inlined `--reason` covered the removal; neither side wanted a `supersede` verb.
- **Breaking-change classification not demanded** — "breaking" appeared 23× in prose and was communicated fine; no felt need for structured metadata.

**B. The real gaps are about *negotiation symmetry* and *delivery timing*, and they split across two layers we'd been conflating:**
- **Atomic *data*** (already shipped): `propose-batch` — all-or-nothing validation; the doc never lands half-valid.
- **Atomic *delivery*** (missing): the peer shouldn't be pressured to judge a half-formed turn. Different layer; forcing `propose-batch` to solve it nickel-and-dimes the agents.

The trial exposed: (1) `retract` is **unilateral** — one side removed part of the shared contract without the peer agreeing, breaking brackish's propose/accept invariant; the peer's only recourse was a prose plea. (2) In production (unlike the turn-atomic harness) events are delivered eagerly per-command, so a multi-step move *dribbles* — the peer sees "retract X" before "propose Y replaces it" and is pressured to judge the incomplete state.

## Revised build order (validated)

1. **Negotiated `retract`** — a `retract_proposed` status, sister to `proposed` but pointing the opposite way: propose a removal → peer **accepts** (→ `retracted`) or **rejects** (→ stays `accepted`). Restores symmetry (nothing leaves the contract unilaterally) and reuses accept/reject + the version chain. Per-artifact (drop the unilateral atomic-set; ordering + `deliver` provide coherence — set-grouping was for coherence, not strict validity, since an unused schema is valid). The "no-delivery-window" worry resolves through the existing rail: the peer *rejects* a premature retraction. **Replaces** shipped unilateral `retract`.

2. **`deliver`** (atomic-delivery layer) — a turn/flush boundary. Moves accumulate privately; the peer's inbox surfaces only *delivered* events ("don't show them your internal monologue"). `nap` implies `deliver`; delivery is content-gated (no-op when nothing's pending → no spurious wake, cleaner mutual-standdown). Designed on paper before code (inbox/cursor semantics shift). Composes with #1: multiple retraction-proposals in a turn arrive as one coherent set.

3. **Harness: deliver-driven handoff** — hand off when a side `deliver`s/`nap`s/exits, never interrupting mid-edit. Surfaces the real production failure mode (forgot to deliver → peer starves), which the current turn-atomic harness hides.

**Deferred to the still-untested paths** (don't build until their trials run):
- **`doc fork`** — for the fork-to-new-doc and wedged-doc-recovery paths (where carryover actually costs). Copies stored specs (dodges the path-param render bug).
- **Breaking-change classification**, **`doc supersede`/`retire`**, **`deprecate`**, **milestone scoping**, **renegotiation playbook** — revisit after the import + fork trials; in-place reneg didn't need them.
- **`import <spec.yaml>`** (situation #3) — gated on its own trial (below).
- **Fix `visualize → propose` path-param drop** — only matters once fork/export-round-trip is in scope.

## Open design questions (for negotiated retract, #1)

- **Accept/reject surface for a pending retraction.** A version is either a pending revision (`proposed`) or a pending removal (`retract_proposed`) — never both, so `accept`/`reject` can target "the latest in-flight version" and `status` clarifies its kind. Accepting a `retract_proposed` = remove; rejecting = keep. (Consistent at the proposal level, even if "accept made it disappear" reads oddly — `status` wording carries it.)
- **Mutual-ref cycles.** Per-artifact retraction + ordering handles the common case (remove referencer, then the now-unused referenced). True mutual `$ref` cycles (X↔Y, both removed) can't be retracted one at a time — rare; document the limitation, revisit if it bites.
- **Version bump.** Shipped 0.6.1 has unilateral `retract`. Replacing it pre-publish (fold into 0.6.1) vs after (0.6.2) depends on whether 0.6.1 is released — check before branching.

## The three e2e trials (situation coverage)

We do **#1 (new from scratch)** well; it has a harness scenario (`chat-app`).

- **Renegotiated-doc trial** — ✅ **done** (`trials/renegotiation-20260525-120231/`, `harness/scenarios/renegotiation.ts`). Seeds a settled v1 via `seedDemo` + `seedingMoves`, drives poll→push. Reordered this roadmap (see "What the trial changed"). The seeding + delta-success-criterion harness machinery is reusable for the import trial.
- **Imported-doc trial** — still to run. A new user with an existing *invalid* spec (seed: an anonymized clyde-v1-style doc with the WS-close-code-as-response-key invalidity baked in) wants to formalize + update it. Map "what's my path" and where it breaks. This is where `import` (and possibly `fork`) earn their place.

Both seed from "populated existing state," which the greenfield `chat-app` harness doesn't exercise; the renegotiation scenario added that machinery.
