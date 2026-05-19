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
brackish: pending negotiations for your identity. Read and respond before continuing your current task.

${OUTPUT}

Next steps:
  brackish read <doc>            # see the full conversation
  brackish artifact get <doc> <name>            # fetch latest accepted content
  brackish artifact get <doc> <name> --proposed # fetch the in-flight proposal
  brackish artifact accept|reject <doc> <name>
  brackish send <doc> "<text>"   # chat
</system-reminder>
EOF
fi
