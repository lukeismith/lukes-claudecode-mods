#!/bin/sh
# Settings PreToolUse hook for every tool call in the session. Only repo-quiz's
# own agents are checked (by guard.py); everyone else's calls pass at once.
input=$(cat)
case "$input" in
  *'"agent_type":"repo-quiz:'* | *'"agent_type": "repo-quiz:'*) ;;
  *) exit 0 ;;
esac
# Fail closed for the mod's agents: if the check itself fails (no Python 3
# included), block the call (exit 2).
PYTHON=$(command -v python3 || echo /usr/bin/python3)
printf '%s' "$input" | "$PYTHON" "$(dirname "$0")/guard.py" || {
  echo 'repo-quiz guard failed, so the call is blocked' >&2
  exit 2
}
