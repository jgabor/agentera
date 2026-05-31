#!/usr/bin/env bash
# Seed v2 fixtures or P0 scenarios into an isolated sandbox root.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: seed-v2-fixture.sh <sandbox-root> <fixture-or-scenario-id>

Environment (optional):
  REPO_ROOT  Repository root (default: two levels above this script)

Never run against a real user home.
EOF
}

if [[ $# -lt 2 ]]; then
  usage
  exit 2
fi

SANDBOX="$1"
SCENARIO="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
FIXTURES="$REPO_ROOT/packages/cli/test/upgrade/fixtures"

mkdir -p "$SANDBOX/home" "$SANDBOX/project" "$SANDBOX/xdg-config"
export HOME="$SANDBOX/home"
export XDG_CONFIG_HOME="$SANDBOX/xdg-config"

copy_fixture() {
  local id="$1"
  local dest="$2"
  if [[ ! -d "$FIXTURES/$id" ]]; then
    echo "unknown fixture: $id" >&2
    exit 2
  fi
  mkdir -p "$(dirname "$dest")"
  cp -a "$FIXTURES/$id/." "$dest/"
}

seed_happy_path() {
  copy_fixture v2-app-home "$HOME/.local/share/agentera"
  copy_fixture v2-yaml-project "$SANDBOX/project"
  copy_fixture v2-runtime-python "$HOME"
}

case "$SCENARIO" in
  v2-yaml-project|v2-app-home|v2-runtime-python|v2-app-home-noisy|v2-legacy-agents-home|v2-runtime-codex-full|v2-full-artifacts|v2-v1-md-project|v2-runtime-opencode|v2-v1-stale-surfaces)
    case "$SCENARIO" in
      v2-yaml-project) copy_fixture "$SCENARIO" "$SANDBOX/project" ;;
      v2-app-home|v2-app-home-noisy|v2-legacy-agents-home)
        copy_fixture "$SCENARIO" "$HOME/.local/share/agentera"
        ;;
      v2-runtime-python|v2-runtime-codex-full|v2-runtime-opencode|v2-v1-stale-surfaces)
        copy_fixture "$SCENARIO" "$HOME"
        if [[ "$SCENARIO" == v2-runtime-opencode || "$SCENARIO" == v2-v1-stale-surfaces ]]; then
          mkdir -p "$XDG_CONFIG_HOME"
          cp -a "$HOME/xdg/opencode/." "$XDG_CONFIG_HOME/opencode/" 2>/dev/null || true
        fi
        ;;
      v2-full-artifacts) copy_fixture "$SCENARIO" "$SANDBOX/project" ;;
      v2-v1-md-project) copy_fixture "$SCENARIO" "$SANDBOX/project" ;;
    esac
    ;;
  v2-runtime-cursor-full)
    copy_fixture v2-runtime-cursor-full/home "$HOME"
    copy_fixture v2-runtime-cursor-full/project "$SANDBOX/project"
    ;;
  happy-path-clean|stable-safety|partial-only-runtime|v2-python-control)
    seed_happy_path
    ;;
  v1-md-blocked)
    copy_fixture v2-v1-md-project "$SANDBOX/project"
    copy_fixture v2-app-home "$HOME/.local/share/agentera"
    ;;
  noisy-app-home)
    copy_fixture v2-app-home-noisy "$HOME/.local/share/agentera"
    copy_fixture v2-yaml-project "$SANDBOX/project"
    ;;
  legacy-home-retirement)
    copy_fixture v2-legacy-agents-home "$HOME/.agents/agentera"
    ;;
  codex-plugin-vs-copied)
    copy_fixture v2-runtime-codex-full "$HOME"
    copy_fixture v2-app-home "$HOME/.local/share/agentera"
    copy_fixture v2-yaml-project "$SANDBOX/project"
    ;;
  *)
    echo "unknown scenario or fixture: $SCENARIO" >&2
    exit 2
    ;;
esac

echo "$SANDBOX"
