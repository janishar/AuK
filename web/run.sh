#!/usr/bin/env bash
# Launch AuK Studio from anywhere: bash web/run.sh [--port 8420] [--reload]
# Uses the repo's .venv if present, so no manual activation is needed.
set -euo pipefail
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$WEB_DIR")"

if [[ -x "$REPO_ROOT/.venv/bin/python" ]]; then
  PYTHON="$REPO_ROOT/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
else
  PYTHON="python"
fi

cd "$WEB_DIR"
exec "$PYTHON" server.py "$@"
