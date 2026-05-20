# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
