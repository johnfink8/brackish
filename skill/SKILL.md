---
name: brackish
description: Use whenever you are about to commit to an API/type contract that another Claude Code instance is responsible for the other side of — typing a TS interface, pydantic model, OpenAPI fragment, JSON schema, or RPC signature at a boundary another component owns. Also triggers when the user mentions a paired Claude session ("the backend Claude", "frontend's in another window", "we're co-developing X"), or when you are about to assume the shape of an API response/request that you don't actually know. The point is to ask via `brackish` instead of guessing. NOT for internal types, single-developer projects, or boundaries where the other side has already shipped — only when there's a live other-Claude doing paired work.
---

# brackish — negotiate contracts with the other Claude

You are running in a session where the user is also running **another Claude Code instance** on a paired component. brackish is a small message bus + propose/accept artifact lifecycle that lets you two agree on contracts (API shapes, TS types, OpenAPI fragments, schemas) instead of each guessing.

## When to reach for brackish

Reach for brackish the moment you would otherwise:

- Type out a TS `interface`/`type`, pydantic model, OpenAPI fragment, JSON Schema, or RPC signature at a boundary the *other* Claude owns.
- Write "I'll assume the response shape is …", "the backend will probably return …", "the frontend will send …".
- Hand-roll a fixture/mock for a payload another component produces.
- Re-derive a shape from a sibling repo that's actively being changed by the other Claude.

Skip brackish if:
- The contract is purely internal to your component (the type lives behind a private function).
- You're maintaining a long-shipped API where the shape is locked.
- There's no other Claude — i.e. nothing on the other side to negotiate with.

## Inbox first

Before deciding what to do in a cross-component-contract session, run:

```
brackish inbox
```

If there are pending events on any document, **read those first**. Other-you may have already proposed something or asked a question that should change your next step.

## Workflow

A negotiation always has a `<doc>` (name it after the contract surface: `users-api`, `orders-schema`, `auth-flow`). For a new contract:

1. `brackish docs` — see existing documents. Reuse one if it fits.
2. `brackish doc new <name>` — create a document if needed.
3. `brackish send <doc> "<text>"` — say what you need. Plain English is fine; this is the discussion channel.
4. `brackish artifact propose <doc> <name> --kind <kind> --file path.yaml` — when you have a concrete spec to propose. Kind is a freeform label: `openapi`, `json-schema`, `ts-types`, `proto`, `text`.
5. `brackish wait <doc> --timeout 60` — block until the other side responds (max 60s; tune to whatever feels reasonable). Re-call if you want to keep waiting.

To respond to other-you:

- `brackish read <doc>` — see the conversation so far.
- `brackish artifact get <doc> <name>` — fetch the currently-accepted content (e.g. into a file: `brackish artifact get <doc> users-api > users.yaml`). Use `--proposed` for the latest still-pending version.
- `brackish artifact accept <doc> <name>` — lock in the latest proposal (you can't accept your own).
- `brackish artifact reject <doc> <name> "<reason>"` — push back with a reason.
- `brackish send <doc> "<text>"` — chat.

Once an artifact is `accepted`, that's the contract. Generate your code from it; check it in if it's a file. The next time the other side changes it, you'll get a new `artifact_proposed` event for the same name on the same document, with a bumped version.

## The hook

If the user installed brackish's `UserPromptSubmit` hook (via `brackish install`), at the start of every turn you may see a block like:

```
<system-reminder>
Pending brackish negotiations for your identity:
contracts                 2 new     2026-05-19T03:00:00Z  peer        looks good but rename createdAt -> created_at?
…
</system-reminder>
```

That's not magic — it's the hook calling `brackish inbox --quiet-if-empty` and surfacing the result. When you see it, treat it as a real interruption: don't continue your current task until you've looked at what the other side said. Use `brackish read <doc>` to get the full context, then respond before resuming.

If you don't see this block, either the hook isn't installed (suggest `brackish install` to the user when relevant) or there are no pending events.

## Output shapes worth knowing

- Most commands default to compact text on stdout; pass `--json` if you need structured output.
- `brackish artifact get` is special: artifact **content** goes to stdout, **metadata** goes to stderr. So `brackish artifact get t name > out.yaml` writes a clean file.
- Exit codes: `0` = success (including a timed-out `wait` with zero events), `1` = operation error (404/403/409), `2` = config/auth/connection error.

## When the user says "we should negotiate this"

Run `brackish whoami` to confirm you're configured (identity + server), then `brackish inbox` to see what's already in flight, then propose / send / wait as appropriate. If `whoami` fails with "no config", the user hasn't run `brackish init --identity <name>` yet — flag that.
