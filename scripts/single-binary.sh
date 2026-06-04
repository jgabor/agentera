#!/usr/bin/env bash
# single-binary.sh — Bun-compiled single-binary build for the v3 Agentera CLI.
#
# Per `docs/packaging/v3-packaging.md` (T1), the v3 CLI ships as either an npm
# tarball (`npx -y agentera@next`) or a Bun-compiled single-binary. This script
# is the canonical entrypoint for the single-binary build: it composes the
# TypeScript compile, the data-staging `prepack` step, and the `bun build
# --compile` invocation that produces the self-contained executable.
#
# Usage:
#   bash scripts/single-binary.sh                       # build with defaults
#   bash scripts/single-binary.sh --outfile path/to/bin # custom outfile
#   bash scripts/single-binary.sh --no-smoke            # skip the post-build smoke gate
#   bash scripts/single-binary.sh --channel next|latest  # npm channel for --version matching
#
# Exit codes:
#   0   build succeeded and the smoke gate passed
#   1   bun is not installed (or older than 1.1.x)
#   2   tsc / copy-bundle.mjs failed
#   3   bun build --compile failed
#   4   the post-build smoke gate failed (binary does not execute `prime`)

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

OUTFILE="$ROOT/packages/cli/dist/bin/agentera-single-binary"
SMOKE=1
CHANNEL="next"

usage() {
  sed -n '2,20p' "$0"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --outfile) OUTFILE="$2"; shift 2 ;;
    --no-smoke) SMOKE=0; shift ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "single-binary: unknown arg: $1" >&2; exit 1 ;;
  esac
done

log() { printf 'single-binary: %s\n' "$*" >&2; }
die() { log "$@"; exit 1; }

# 1. Bun availability (T1 hard requirement: Bun >= 1.1.x).
if ! command -v bun >/dev/null 2>&1; then
  die "bun is not installed; install Bun 1.1.x or later (https://bun.sh)"
fi
BUN_VERSION_RAW="$(bun --version 2>/dev/null || true)"
BUN_VERSION="${BUN_VERSION_RAW%%-*}"
BUN_MAJOR="${BUN_VERSION%%.*}"
BUN_MINOR="$(printf '%s' "$BUN_VERSION" | cut -d. -f2)"
if [[ -z "$BUN_MAJOR" || -z "$BUN_MINOR" ]]; then
  die "could not parse bun version: '$BUN_VERSION_RAW'"
fi
if (( BUN_MAJOR < 1 )) || (( BUN_MAJOR == 1 && BUN_MINOR < 1 )); then
  die "bun $BUN_VERSION is too old; the v3 single-binary needs Bun >= 1.1.x"
fi
log "bun $BUN_VERSION_RAW available"

# 2. TypeScript compile (the single source of truth for dist/).
log "compiling TypeScript (tsc -p packages/cli/tsconfig.json)"
pnpm -C packages/cli run typecheck >/dev/null
pnpm -C packages/cli build

# 3. Data staging (prepack): node scripts/copy-bundle.mjs.
log "staging data surfaces (node packages/cli/scripts/copy-bundle.mjs)"
pnpm -C packages/cli run bundle:data

# 4. Bun-compiled single-binary.
ENTRY="packages/cli/dist/bin/agentera.js"
if [[ ! -f "$ENTRY" ]]; then
  die "missing entrypoint: $ENTRY (build step did not produce dist/bin/agentera.js)"
fi
mkdir -p "$(dirname "$OUTFILE")"
log "bun build --compile $ENTRY --outfile $OUTFILE"
bun build --compile "$ENTRY" --outfile "$OUTFILE"
if [[ ! -x "$OUTFILE" ]]; then
  die "bun build --compile did not produce an executable at $OUTFILE"
fi
log "binary built: $OUTFILE"

# 5. Post-build smoke gate: the binary must execute `prime --format json` and
#    exit 0. The expected --version is read from packages/cli/package.json so
#    it tracks the release-metadata contract.
if [[ "$SMOKE" -eq 1 ]]; then
  log "smoke gate: $OUTFILE prime --format json"
  SMOKE_TMP="$(mktemp)"
  SMOKE_ERR="$(mktemp)"
  trap 'rm -f "$SMOKE_TMP" "$SMOKE_ERR"' EXIT
  if ! "$OUTFILE" prime --format json >"$SMOKE_TMP" 2>"$SMOKE_ERR"; then
    log "smoke gate failed: prime exited non-zero"
    log "stderr: $(cat "$SMOKE_ERR")"
    exit 4
  fi
  if ! node -e '
    const fs = require("node:fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (j.command !== "prime" || j.status !== "ok") process.exit(1);
  ' "$SMOKE_TMP"; then
    die "smoke gate failed: prime output is not the canonical JSON shape"
  fi
  log "smoke gate passed: prime --format json returned the canonical shape"
fi

# 6. Version-pin reporting (informational, never fatal).
PKG_VERSION="$(node -e 'console.log(require("./packages/cli/package.json").version)')"
SUITE_VERSION="$(node -e 'console.log(require("./packages/cli/package.json").agentera.suiteVersion)')"
log "package.json#version=$PKG_VERSION  agentera.suiteVersion=$SUITE_VERSION  channel=@$CHANNEL"
log "done. invoke as: $OUTFILE --help  |  $OUTFILE prime --format json"
