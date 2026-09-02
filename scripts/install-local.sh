#!/bin/bash
set -euo pipefail

if [[ -z "${HOME:-}" || "$HOME" != /* ]]; then
  echo "RELEASE_HOME_REQUIRED" >&2
  exit 2
fi

DESTINATION=""
CANDIDATE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --destination) DESTINATION="${2:-}"; shift 2 ;;
    --candidate) CANDIDATE="${2:-}"; shift 2 ;;
    *) echo "UNKNOWN_ARGUMENT" >&2; exit 2 ;;
  esac
done

EXPECTED_DESTINATION="${HOME}/Desktop/聊天助手/bin"
if [[ "$DESTINATION" != "$EXPECTED_DESTINATION" ]]; then
  echo "DESTINATION_NOT_ALLOWED" >&2
  exit 2
fi

if [[ -z "$CANDIDATE" || "$CANDIDATE" != /* ]]; then
  echo "CANDIDATE_REQUIRED" >&2
  exit 2
fi

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_ROOT="${HOME}/Desktop/聊天助手"
unset NODE_PATH NODE_OPTIONS
exec node "$PROJECT_ROOT/scripts/release-cli.mjs" install \
  --runtime-root "$RUNTIME_ROOT" \
  --candidate "$CANDIDATE"
