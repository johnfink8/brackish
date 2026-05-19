# brackish

Claude-to-Claude contract negotiation. A small message bus + propose/accept artifact lifecycle for two (or more) [Claude Code](https://claude.ai/code) instances co-developing paired components — a frontend and a backend, a producer and a consumer, etc.

Same machine: Unix-socket transport, peer-trust, zero ceremony.
Cross-machine: TCP transport with invite/connect token bootstrap.

## Install

```sh
npm install -g brackish-cli           # one binary: `brackish`
brackish install                       # interactive: drops the Claude skill + UserPromptSubmit hook
```

## First use (same-machine, two Claudes)

Each Claude runs:

```sh
brackish init --identity host          # identity is a self-declared label; pick whatever
```

One side starts the daemon (anyone can, exactly once on the machine):

```sh
brackish serve &
```

Then talk:

```sh
# host:
brackish doc new contracts
brackish send contracts "Need shape of GET /users/me response."
brackish artifact propose contracts users-api --kind openapi --file users.yaml

# peer (other Claude):
brackish inbox                                  # see what's pending
brackish read contracts                          # see the discussion + proposals
brackish artifact get contracts users-api --proposed > /tmp/proposal.yaml
brackish artifact accept contracts users-api    # or `reject <reason>`
```

## Cross-machine

```sh
# server side (could be one of the Claudes or a third host):
brackish serve --bind 0.0.0.0:11442 &
brackish invite peer                            # prints a `brackish connect ...` command

# peer side:
brackish connect http://1.2.3.4:11442 --token <invite> --identity peer
# config written; subsequent commands work the same as same-machine
```

## What's an artifact?

An artifact has a name (`users-api`), a kind (`openapi`/`ts-types`/`json-schema`/etc. — freeform label), and a chain of versions. Each version is `proposed` → `accepted` or `rejected`. You can't accept your own proposal; the other side does. The "current contract" is the latest accepted version.

```sh
brackish artifact list <doc>                  # see all artifacts and their states
brackish artifact get <doc> <name>            # latest accepted, content to stdout
brackish artifact get <doc> <name> --proposed # latest in-flight
brackish artifact get <doc> <name> --version 3
```

## Demo

```sh
npm install -g brackish-cli
brackish demo                                # one shot — open the URL it prints
```

That's it. `brackish demo` starts an ephemeral daemon in a sandbox dir, seeds the negotiated document, mints a browser-friendly token, prints a ready-to-open URL, and stays in the foreground until you Ctrl-C (at which point the sandbox is wiped). No `init` or `serve` required; doesn't touch any existing brackish state.

Other formats (while the demo daemon is running, from another shell):
```sh
brackish visualize chatter-api --format markdown | less    # via the printed BRACKISH_HOME
brackish visualize chatter-api --format openapi > spec.yaml
```

The demo is a "Hello-world realtime chat" API negotiated between two identities (`alice` proposes, `bob` accepts/rejects). It exercises everything brackish does:

- **Convention re-negotiation** — v1 bearer-only; v2 adds a cookie-session scheme once an HTML page enters the picture.
- **Schema rejection cycles** — `User` v1 (snake_case) gets rejected, v2 (camelCase) accepted; `Message` v1 (`from: string`) gets rejected, v2 (`from: $ref User`) accepted.
- **Endpoint rejection cycles, including a two-sided fight** — `POST /messages` v1 (`200 OK`) rejected by bob, v2 (`201 Created`) accepted. `GET /messages/stream` is the contested one: alice proposes v1 (SSE), bob rejects and counter-proposes v2 (long-poll over JSON), alice rejects bob's counter, alice re-proposes v3 (SSE), bob accepts. Frontend domain knowledge wins; backend gets a deploy-note about disabling proxy buffering.
- **Multiple content types** — `application/json`, `application/octet-stream` (file upload + download), `text/event-stream` (SSE), `text/html` (the chat page).
- **WebSocket handshake** documented as `GET /ws` with `x-brackish-protocol: websocket` plus `x-brackish-frames` enumerating both directions.
- **Brackish extensions** — `x-brackish-timing`, `x-brackish-side-effects` annotate the operations.
- **Chat transcript** — `alice` and `bob` send rationale messages alongside the artifact moves.

The seed is implemented in `src/demo.ts` and uses the socket transport's peer-trust to impersonate both identities from one process. Reading that file is a good way to see the typed client surface in action.

## The skill + hook

`brackish install` puts a [Claude skill](https://docs.claude.com/en/docs/claude-code/skills) at `~/.claude/skills/brackish/` so your Claudes know when to reach for brackish. It also offers to wire a `UserPromptSubmit` hook into `~/.claude/settings.json` that calls `brackish inbox --quiet-if-empty` at the start of every turn — when there's pending traffic, it's auto-surfaced into Claude's context. Reversible with `brackish uninstall`.

## Long-poll

`brackish wait <doc> --timeout 60` blocks for up to 60 seconds and returns the moment a new event arrives (or empty + exit 0 on timeout). Cursors are server-tracked per (identity, document) so a bare `brackish wait <doc>` means "since I last looked."

## Anatomy

- **CLI + daemon = one Node binary.** `brackish serve` is just a subcommand.
- **Storage:** append-only events table; documents + artifact state are projections. SQLite via `better-sqlite3`.
- **Transport detection:** the server is dual-bound (Unix socket + optional TCP) and decides auth mode by inspecting the underlying connection — `X-Brackish-Identity` header for socket peers, `Authorization: Bearer <token>` for TCP.
- **Stack:** Node 20+, Hono, better-sqlite3, zod, commander, undici, smol-toml.
- **Tests:** vitest, ~110 unit + integration across store, server, client, install.
