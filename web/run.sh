#!/usr/bin/env bash
# Launch AuK studio on its own, from anywhere: under `helm dev`, which keeps
# everything AuK studio keeps in ./.helm through helmstudio's runtime SDK.
#
#   [AUK_MODELS=<checkpoint dir>] [HELM=<helm>] bash web/run.sh [helm dev flags]
#   bash web/run.sh stop
#
# helm comes from helmstudio's installer, and helm-runtime-sdk from PyPI
# (web/requirements.txt). AUK_MODELS points at the directory holding AuK,
# AuK-Flash and Qwen2.5-Omni-3B, and each that exists is linked as a weight;
# without it, `helm dev` downloads them. What the script makes itself stays in
# .cache/auk-studio, beside the .helm that helm dev keeps.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

RUN="$PWD/.cache/auk-studio"
HELM="${HELM:-helm}"
PIDFILE="$RUN/auk-studio.pid"

# Ends the helm dev this script last started, which stops the studio before it
# exits. A run starts by doing the same, so starting again is a restart.
stop() {
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$pid" ] && ps -p "$pid" -o command= 2>/dev/null | grep -q " dev -f helmstudio.yaml"; then
    echo "helm dev: stopping the AuK studio started before ($pid)"
    kill -TERM "$pid" 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
  fi
  rm -f "$PIDFILE"
}
if [ "${1:-}" = "stop" ]; then
  stop
  exit 0
fi

if ! command -v "$HELM" >/dev/null; then
  echo "helm is not installed. Install it with helmstudio's installer, or set HELM to its path:" >&2
  echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/janishar/helmstudio/main/installer/install.sh)"' >&2
  exit 1
fi
if [ ! -x .venv/bin/python ]; then
  echo "no .venv: create it with 'uv venv --python 3.12' and install this repo and web/requirements.txt" >&2
  exit 1
fi
if ! .venv/bin/python -c "import helm_runtime_sdk" 2>/dev/null; then
  echo "helm-runtime-sdk is not installed in .venv: run 'uv pip install -r web/requirements.txt'" >&2
  exit 1
fi

# Each weight the manifest declares, linked from AUK_MODELS when it is there.
# AuK and AuK-Flash are selectable, so exactly one runs: AUK_CHECKPOINT picks it
# (auk or auk_flash), and without it the one that is actually on disk is chosen,
# since `helm dev` refuses to launch with nothing selected rather than guess.
if [ -n "${AUK_MODELS:-}" ]; then
  models="${AUK_MODELS%/}"
  selected="${AUK_CHECKPOINT:-}"
  if [ -d "$models/AuK" ]; then
    set -- -link "auk=$models/AuK" "$@"
    selected="${selected:-auk}"
  fi
  if [ -d "$models/AuK-Flash" ]; then
    set -- -link "auk_flash=$models/AuK-Flash" "$@"
    selected="${selected:-auk_flash}"
  fi
  [ -d "$models/Qwen2.5-Omni-3B" ] && set -- -link "qwen=$models/Qwen2.5-Omni-3B" "$@"
  [ -n "$selected" ] && set -- -select "$selected" "$@"
  echo "weights: linking what is under $models${selected:+, running $selected}"
fi

VENV=.venv
# AUK_DEBUGPY=<port> runs the studio under a debugger (.vscode/launch.json
# attaches to it). helm dev hands the studio a restricted environment, so the
# request cannot reach it as a variable; it is given an environment of links to
# .venv's own commands instead, whose `python` runs .venv's interpreter under
# debugpy.
if [ -n "${AUK_DEBUGPY:-}" ]; then
  if ! .venv/bin/python -c "import debugpy" 2>/dev/null; then
    echo "debugpy: installing into .venv"
    uv pip install --quiet --python .venv/bin/python debugpy
  fi
  VENV="$RUN/auk-studio-debugpy"
  rm -rf "$VENV" && mkdir -p "$VENV/bin"
  cp .venv/pyvenv.cfg "$VENV/"
  for entry in "$PWD"/.venv/bin/*; do ln -s "$entry" "$VENV/bin/"; done
  rm "$VENV/bin/python"
  printf '#!/bin/sh\nexec "%s" -Xfrozen_modules=off -m debugpy --listen "127.0.0.1:%s" "$@"\n' \
    "$PWD/.venv/bin/python" "$AUK_DEBUGPY" >"$VENV/bin/python"
  chmod +x "$VENV/bin/python"
  echo "debugpy: the studio listens for a debugger on 127.0.0.1:$AUK_DEBUGPY"
fi

stop
mkdir -p "$RUN"
echo $$ >"$PIDFILE"
exec "$HELM" dev -f helmstudio.yaml -venv "$VENV" "$@"
