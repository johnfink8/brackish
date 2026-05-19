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
