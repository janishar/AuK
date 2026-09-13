#!/usr/bin/env bash
# Launch AuK Studio from the repo root: bash web/run.sh [--port 8420] [--reload]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec python server.py "$@"
