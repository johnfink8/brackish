#!/usr/bin/env bash
# brackish UserPromptSubmit hook.
# If there are pending brackish events for the configured identity, emit them as a
# system-reminder block so Claude sees them at the start of the turn. Silent otherwise.

set -e

BRACKISH=$(command -v brackish 2>/dev/null || true)
if [ -z "${BRACKISH}" ]; then
  # brackish not installed on PATH; nothing to do
  exit 0
fi

# Don't let an exception in brackish kill the user's turn.
OUTPUT=$("${BRACKISH}" inbox --quiet-if-empty 2>/dev/null || true)

if [ -n "${OUTPUT}" ]; then
  cat <<EOF
<system-reminder>
brackish: pending events on docs your identity is party to. If you're mid-negotiation
these may want a reply; if you've already concluded (post-mortem, switched to
implementing, etc.) they're safe to ignore — or run \`brackish deactivate\` to silence
this hook.

${OUTPUT}

If you want to respond:
  brackish read <doc>                                          # full conversation + propose events with delta summaries
  brackish read <doc> --tail N                                 # just the last N events, no cursor advance
  brackish endpoint show <doc> <METHOD> <PATH>                 # compact: status + version chain + latest delta
  brackish endpoint show <doc> <METHOD> <PATH> --full          # include the Operation body
  brackish endpoint diff <doc> <METHOD> <PATH> --from N --to M # compare two versions (RFC 6902 patch by default)
  brackish endpoint accept|reject <doc> <METHOD> <PATH> [reason]
  brackish schema     accept|reject <doc> <NAME>       [reason]    # same lifecycle (and \`schema diff\`)
  brackish convention accept|reject <doc>              [reason]    # same lifecycle (and \`convention diff\`)
  brackish send <doc> "<text>"                                 # standalone rationale (or use --rationale on accept/reject)
</system-reminder>
EOF
fi
