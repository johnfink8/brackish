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
  brackish read <doc>                                  # full conversation + propose events with delta summaries
  brackish endpoint show <doc> <METHOD> <PATH>         # compact: status + version chain + latest delta
  brackish endpoint show <doc> <METHOD> <PATH> --full  # include the Operation body
  brackish endpoint accept|reject <doc> <METHOD> <PATH> [reason]
  brackish schema     accept|reject <doc> <NAME>       [reason]   # same lifecycle for schemas
  brackish convention accept|reject <doc>              [reason]   # same lifecycle for the document-level convention
  brackish send <doc> "<text>"                         # rationale alongside an action
</system-reminder>
EOF
fi
