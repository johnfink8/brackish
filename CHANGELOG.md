# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-05-22

A security-and-correctness pass. Eleven targeted fixes covering XSS, prompt-injection of the local Claude, default-bind exposure, error-mapping holes, partial-commit semantics, capped diff resolution, plaintext token storage, missing per-document ACLs, query-string token leakage, missing rate limiting, and the absence of explicit "not production-hardened" framing. Each fix has a red test that demonstrates the targeted exploit/bug before the change and turns green after.

### Security

- XSS in `/ui/<doc>` (script-tag breakout): inlined spec/rationale/events JSON now escapes `<` and U+2028/U+2029 so peer-supplied strings can't close the outer `<script>` and execute as HTML.
- Prompt-injection of the local Claude via the UserPromptSubmit hook: inbox previews neutralize angle brackets in peer-supplied text (message bodies, rejection reasons, delta strings), and the hook moves peer content out of the `<system-reminder>` block into a labeled `<untrusted_user_content>` block.
- Tokens are stored hashed (sha256) at rest. Both persistent peer tokens and outstanding invite tokens migrate in place on first startup; the raw token only ever lives on the peer side. Malformed `expires_at` columns now fail-closed (treat as expired) instead of fail-open via `Date.parse() === NaN`.
- Per-document ACLs gate every doc-scoped TCP endpoint. Document creators are owners; other parties access docs only if explicitly granted (via `brackish doc grant` or `brackish invite --grant <doc>`). Socket peers retain peer-trust.
- Token-in-URL-query (`?token=`) auth fallback removed. Browser UI now uses a single-use OTT (`POST /ui-sessions`) exchanged at `GET /ui-login` for an `HttpOnly; SameSite=Strict` cookie. Tokens never appear in URLs, logs, browser history, or Referer headers.
- Rate limiting on `/connect` (10/min per source IP), failed bearer auth (20/min per IP), and OTT mint (30/min per identity). Socket peers bypass.

### Added

- `brackish doc grant <doc> <identity>` / `brackish doc revoke <doc> <identity>` / `brackish doc members <doc>` for managing per-document ACLs.
- `brackish invite --grant <doc>` (repeatable, also accepts comma-separated) — the redeeming peer automatically becomes a member of each named doc.
- `POST /ui-sessions` + `GET /ui-login?ott=…&doc=…` browser auth flow.
- README: new "Security model" section describing the trust boundary, transport assumptions, and what brackish is not.
- `serve` stderr banner: positive "loopback only — NOT externally reachable" line on `127.0.0.1` binds; warning banner naming the address on any non-loopback bind. Suppressible via `BRACKISH_QUIET_BIND_WARNING=1`.

### Changed

- Bare `brackish serve --bind` (and `brackish up --bind`) defaults to `127.0.0.1:11442`. Pass `--bind 0.0.0.0` explicitly to expose on the LAN. **Breaking** for cross-machine setups using the bare flag.
- `app.onError` maps `HttpError` (query-param validation) and `ZodError` (body / param zod validation) to 400 instead of 500. Surfaces the actual validation message instead of "internal server error".
- `propose-batch` is now truly atomic: a new `Store.batchPropose` wraps all per-artifact proposes in a single SQLite transaction with savepoints. Partial commit is impossible — a mid-batch failure rolls back every earlier propose. The response shape no longer carries a partial `succeeded` field on error.
- Diff endpoint resolves the default `--to` via `MAX(version)` instead of linearly probing versions 50→1, so artifacts with more than 50 versions diff correctly without an explicit `--to`.
- Skill `SKILL.md` and `server.md` teach the new bind default: agents now ask the human about connectivity intent (loopback vs LAN-reachable) before binding cross-machine.

### Breaking

- `--bind` default switched from `0.0.0.0` to `127.0.0.1`. Re-launch cross-machine daemons with `--bind 0.0.0.0` explicitly.
- TCP `?token=` query-string auth fallback removed. Browser callers must use the OTT/cookie flow; CLI callers must use the `Authorization: Bearer` header.
- Per-document ACL enforcement on TCP. Existing docs auto-grant their `created_by` as owner via migration; pre-0.6.0 TCP peers other than the doc creator must be added explicitly with `brackish doc grant`.
- Token-at-rest format change. The migration rehashes existing tokens in place on first startup; peers don't need to re-redeem. The raw `token` column is replaced by `token_hash`.
- `Store.createInvite` interface grew an optional `grantDocs` array; external Store implementations need to handle it (or ignore via default `[]`).
- The `propose-batch` HTTP response on failure no longer includes a `succeeded` list — the operation is all-or-nothing.

## [0.5.3] - 2026-05-22

### Added

- `--rationale "<text>"` on `accept` (schema/endpoint/convention; single and batch). The reason rides on the `artifact_accepted` event and renders in the sidebar.
- `--tail N` on `brackish read` — peek at the last N events without advancing the cursor; cheap end-of-log scan with no cursor math.
- `harness/extract-demo.ts` + `run-trial --demo-data <path>` for regenerating the `brackish demo` move log from a finished trial; demo data refreshed from a 6-round, fully-settled chat-app run (11 of 14 accepts carry rationale).

### Changed

- `skill/server.md` now teaches `<kind> diff --from N --to M` so backend Claudes find it; `skill/propose.md` reconciles the batch threshold (3+ artifacts of any mix, with convention bundled unless contentious).
- Hook reminder is informational rather than directive; surfaces `brackish deactivate` as the off-ramp once a negotiation has wrapped.
- `brackish demo` UI: sidebar is a single chronological timeline (one card per event, color-coded by kind), accepts surface their `--rationale` inline, both panes scroll independently within the viewport.
- README: added a demo screenshot.

## [0.5.2] - 2026-05-20

### Fixed

- Release workflow: setup-node@v6 + Node 24 + `package-manager-cache: false`, matching the npm provenance sample.

## [0.5.1] - 2026-05-20

### Fixed

- Release workflow: `npm install` instead of `npm ci` (lock omits cross-platform optional deps).

## [0.5.0] - 2026-05-20

### Added

- Authoritative OpenAPI 3.1 meta-schema validation on every propose and accept. The server runs `@seriousme/openapi-schema-validator` against the projected assembled doc and refuses to enter a state where it would be invalid: dangling `$ref`s, missing required fields (e.g. `info.version`, `securityScheme.scheme` on `type: http`), malformed parameter / response / requestBody shapes are rejected at the moment of writing instead of surfacing later as codegen failures.
- Atomic batch endpoint `POST /documents/:name/propose-batch`. Accepts a coordinated set of artifacts (convention + schemas + endpoints), assembles them into the projected wide doc, validates once, commits all-or-nothing. Mutual references and out-of-order forward refs work in a single request — order within a batch no longer matters.
- `spec_invalid` error code carrying a structured `issues` array (severity / field / message). Surfaced through the client recovery hint and CLI rendering so Claude knows exactly what to propose first when a ref doesn't resolve.
- Releases publish via GitHub Actions trusted publishing (OIDC). Published artifacts carry an npm Provenance badge linking back to the workflow run that built them; no long-lived `NPM_TOKEN` lives on the laptop or in GitHub secrets.

### Changed

- **Breaking**: propose-time and accept-time semantics. Each per-artifact propose validates the projected wide doc (accepted + currently-proposed + this propose); each per-artifact accept validates the projected accepted doc (accepted-only + this accept applied). Specs that 0.4.x accepted — e.g. an `http`-typed `securityScheme` missing the required `scheme` field, or a schema referencing another schema not yet in the doc — now return 400 `spec_invalid`. Pre-flight with `brackish <kind> lint <file>` to catch local shape mistakes; the cross-artifact ref check requires doc context and runs on the server.
- `proposeBatchFromManifest` now POSTs the whole manifest as a single atomic request rather than looping individual proposes. Failure semantics are stricter: a parse or lint error means *no* propose is sent (no partial success up to the failing item).
- `brackish visualize` and the accept-time validator share one assembly code path (`projectDocument(..., 'accepted')`). The doc rendered for downstream codegen and the doc the arbitrator validates against are structurally identical — no drift.
- `brackish <kind> lint` now runs zod parse + brackish-specific cross-field checks only (path placeholders ↔ parameters, security refs within a convention, `x-brackish.naming` enum). Full meta-schema validation moved to the server since it needs doc context for ref resolution. The lint output is best-effort pre-flight; the server is the arbitrator.

### Fixed

- The validator's `errors` field can be `ErrorObject[]` or `string` (the latter for unresolved-ref failures). The string path was being silently dropped to an empty array, so invalid specs with dangling refs slipped through. Both shapes now surface.
- The daemon's `/healthz` and `/whoami` endpoints reported a stale hardcoded version (`0.3.0`) regardless of the running package version. Same shape as 0.4.2's `CLI_VERSION` fix; now read from `package.json` at build time via the static JSON import so the two can't drift.

## [0.4.2] - 2026-05-19

### Fixed

- `brackish --version` reported a stale hardcoded string (`0.3.0`) regardless of the actual package version. Now read from `package.json` at build time via the static JSON import; esbuild inlines it, so the two can't drift.

## [0.4.1] - 2026-05-19

### Fixed

- `package.json` `bin` field had a leading `./` on the path, which npm 11 silently strips and then removes the entry entirely. The 0.4.0 publish landed without a `bin`, so `npm install -g brackish-cli@0.4.0` did not expose the `brackish` command. 0.4.1 publishes with the bin intact.
- `package.json` `repository.url` normalized to the canonical `git+https://github.com/johnfink8/brackish.git` form.

## [0.4.0] - 2026-05-19

Initial public release.

### The protocol

- OpenAPI 3.1 propose / accept / reject / withdraw lifecycle for three artifact kinds: `endpoint` (Operation Objects), `schema` (component schemas), and `convention` (the document-level info / servers / securitySchemes singleton).
- Optimistic concurrency on every propose: `--expected-new` for first proposals, `--expected-version <N>` for revisions, `--force` for explicit stacking. Race losers get a `version_in_flight` or `version_mismatch` 409, not silent overwrites.
- Compact JSON-Patch deltas (`+responses.409`, `~oneOf.6.properties.code.enum`) carried on each artifact version and surfaced in event summaries, so peers can reason about changes without re-pulling the full body.
- `x-brackish` extension namespace on Operations and Conventions: `idempotent`, `sideEffects`, `timing`, `streaming`, `frames`, `eventTypes`, `naming`. Consolidated under one key per object so it reads as a single metadata block and never collides with HTTP headers.
- Document-level convention inheritance: endpoints inherit `security` from the convention's `--global-security` automatically; per-endpoint `--no-inherit-security` emits `security: []` (the OpenAPI spelling for "no auth required").

### CLI

- Per-kind verbs: `propose`, `accept`, `reject`, `withdraw`, `show`, `list`, `diff`, `lint` for each of endpoint / schema / convention.
- Batch accept: `brackish schema accept <doc> A B C ...` (variadic), `brackish endpoint accept <doc> --target METHOD:PATH ...` (repeatable). Stop on first failure with a what-succeeded / remaining summary.
- Batch propose: `brackish propose-batch <doc> --manifest <file>` parses + lints every artifact locally before sending, in convention → schemas → endpoints order. `--dry-run` (alias `--lint-only`) runs the pipeline without contacting the daemon.
- Local lint pre-flight: `brackish endpoint lint <method> <path> <file>` (and `schema lint`, `convention lint`) validates a YAML or JSON file against the same zod schemas the server uses on propose, plus cross-field checks (path placeholder ↔ parameters consistency, security ↔ securitySchemes references, `x-brackish.naming` enum). Catches the cheap class of rejections without a network round-trip.
- `brackish status [doc]`: bucketed view by ownership (awaiting peer / awaiting me / accepted / needs attention). Doc argument is optional — a single active doc auto-resolves; multiple docs print a per-doc summary. Single-doc view appends a `next:` hint nudging the most likely verb.
- `brackish read` advances per-identity cursors automatically. `brackish wait <doc>` long-polls. `brackish nap [--seconds N]` blocks then snapshots the inbox once. `brackish watch [--all]` foreground-tails events. `brackish inbox` summarizes all docs with new activity for the caller; self-authored events are filtered.
- `brackish visualize <doc>` renders the assembled OpenAPI document in `text`, `markdown`, `html` (Swagger UI + rationale sidebar), `openapi` (YAML), or `json`. Warns when the convention is not accepted and a stub Info block is being substituted.
- `brackish demo` runs an end-to-end sample negotiation in an ephemeral sandbox and prints a ready-to-open browser URL.

### Transport and identity

- Unix-socket transport for same-machine use: peer-trust via an `X-Brackish-Identity` header. No tokens, no ceremony.
- TCP transport for cross-machine use: bearer-token auth. Bootstrap via `brackish invite <peer>` on the server side (mints a one-time token + prints a `/brackish connect URL --token T --identity N` line) and `brackish connect URL --token T --identity N` on the peer side (redeems the invite, writes persistent config). Dual-bound server detects per-connection auth mode automatically.

### Claude Code integration

- Bundled skill installed by `brackish install` into `~/.claude/skills/brackish/` (global) or `./.claude/skills/brackish/` (project). Split into a slim `SKILL.md` entry point plus role-specific subfiles (`server.md`, `client.md`, `propose.md`, `patterns.md`) loaded on demand.
- `UserPromptSubmit` hook surfaces pending inbox events at the start of each turn. `--permission` install flag adds a `Bash(brackish *)` allow-rule so Claude can run brackish commands without per-command prompts.
- `brackish activate` and `brackish deactivate` toggle the hook without uninstalling the skill, for switching between negotiating a contract and implementing it.
- `brackish install` / `uninstall` / `hook-snippet` for full skill + hook + permission management. Interactive scope prompt or explicit `--global` / `--local` / `--scope` flags.

### Server, storage, and infrastructure

- Single-binary architecture: `brackish serve` runs in the same Node process as the CLI; `brackish up` / `down` manage a backgrounded daemon via a PID file.
- SQLite via `better-sqlite3` with WAL mode. Events are append-only; documents + per-artifact state are projections.
- Long-poll wait endpoint for cross-process notification.
- Browser UI at `/ui/<doc>`: Swagger UI for the assembled OpenAPI document, plus a sidebar showing every artifact's negotiation history (proposed / accepted / rejected events with rationale).

### Output

- Compact text by default; `--json` for structured output on every verb.
- Instructive output: success lines for propose, reject, and `doc new` append a one-line `→` hint pointing at the next likely move. Error responses map known codes (`version_in_flight`, `version_mismatch`, `cannot_accept_own`, `artifact_not_pending`, `artifact_not_found`, `document_not_found`, `invite_*`) to actionable recovery suggestions.
- Exit codes: `0` for success (including a timed-out `wait`), `1` for operation errors (4xx), `2` for config / auth / connection errors.

### Requirements

- Node.js 22 or newer. `preinstall` script enforces this with an instructive message pointing at nvm.
