#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${BEAM_OPENCLAW_REPO_URL:-https://github.com/Beam-directory/beam-protocol.git}"
REF="${BEAM_OPENCLAW_REF:-main}"
INSTALL_HOME="${BEAM_OPENCLAW_INSTALL_HOME:-$HOME/.beam/openclaw-host}"
REPO_DIR="${INSTALL_HOME}/beam-protocol"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[beam-openclaw-bootstrap] missing required command: $1" >&2
    exit 1
  fi
}

log() {
  printf '[beam-openclaw-bootstrap] %s\n' "$1"
}

need_cmd git
need_cmd node

mkdir -p "$INSTALL_HOME"

if [ -d "$REPO_DIR/.git" ]; then
  log "updating beam-protocol in $REPO_DIR"
  git -C "$REPO_DIR" fetch --depth 1 origin "$REF"
  git -C "$REPO_DIR" checkout --force FETCH_HEAD
else
  log "cloning beam-protocol into $REPO_DIR"
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$REPO_DIR"
fi

log "running guided OpenClaw onboarding"
exec node "$REPO_DIR/scripts/workspace/openclaw-onboarding.mjs" --skip-ui-smoke "$@"
