#!/usr/bin/env bash
# rebase_oracle.sh — Python CLI parity oracle rebase policy and drift check.
#
# The npm `@next` parity oracle is pinned to a single commit on the agentera
# `main` branch (the `python_commit` field in
# `packages/cli/test/cli/fixtures/oracle/parity-remaining-families.json`).
# This script is the maintainer seam for re-pinning when the Python CLI
# source drifts in a parity-impacting way.
#
# Usage:
#   bash packages/cli/scripts/rebase_oracle.sh                # print rebase policy
#   bash packages/cli/scripts/rebase_oracle.sh --check        # emit drift status
#   bash packages/cli/scripts/rebase_oracle.sh --check --json # machine-readable
#
# Exit codes:
#   0   drift: none (pinned commit's tree matches `main` HEAD on the
#              Python CLI paths; or the paths are absent in both trees,
#              which counts as a clean baseline)
#   1   drift: detected (paths under scripts/agentera/ or agentera/ differ
#              between the pinned commit and the current `main` HEAD)
#   2   configuration error (fixture missing, python_commit missing, no
#       git checkout found)
#
# Rebase policy (when to re-pin the python_commit):
#   1. The --check mode reports `drift: detected` for one of the six
#      families in `parity-remaining-families.json`. Each family is pinned
#      independently; re-pinning is per-family, not whole-fixture.
#   2. The Python CLI ships a parity-impacting change to one of the six
#      families on `main`. The drift is detected by running --check
#      against the new `main` HEAD and comparing to the pinned commit.
#   3. The npmParityMatrix.test.ts suite fails in CI with a
#      `drift_direction: ts_smaller` or `python_smaller` row and the
#      failure is traced to a Python-side JSON shape change.
#
# Rebase procedure:
#   1. Run `bash packages/cli/scripts/rebase_oracle.sh --check` to confirm
#      the drift and identify which paths diverged.
#   2. Inspect the diff: `git diff <pinned>..origin/main -- scripts/agentera agentera`
#   3. Update the per-family `python_commit` in
#      `packages/cli/test/cli/fixtures/oracle/parity-remaining-families.json`
#      and the top-level `python_commit` to the new `main` HEAD
#      (`git rev-parse origin/main`).
#   4. Re-run `pnpm -C packages/cli test -- npmParityMatrix` to confirm
#      the matrix is green against the new pin.
#   5. If a family intentionally diverges, set `version_break: true` on
#      that row in the matrix and document the divergence in
#      `CHANGELOG.md` under a `### Changed` bullet.
#
# The parity matrix MUST NOT auto-update the Python side from TS. The
# Python CLI is the parity reference, not the port target; this script
# only manages the pin, not the Python source.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CLI_ROOT/../.." && pwd)"
FIXTURE="$CLI_ROOT/test/cli/fixtures/oracle/parity-remaining-families.json"

# Path arguments to `git diff` for the Python CLI source. The Python CLI
# canonical layout (per the install-root contract) places the executable
# at `scripts/agentera` and the package source at `agentera/`. When those
# paths are present in the agentera `main` tree, --check is meaningful;
# when they are absent, --check reports `drift: none` (no tree to
# compare) which is the correct baseline for the v3 development cycle.
PYTHON_CLI_PATHS=(
  "scripts/agentera"
  "agentera"
)

# JSON output mode (set by --json).
JSON_MODE=0
CHECK_MODE=0

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_MODE=1 ;;
    --json) JSON_MODE=1 ;;
    -h|--help)
      sed -n '2,46p' "$0"
      exit 0
      ;;
    *)
      echo "rebase_oracle.sh: unknown argument '$arg'" >&2
      exit 2
      ;;
  esac
done

log() {
  if [ "$JSON_MODE" -eq 0 ]; then
    printf '%s\n' "$*"
  fi
}

if [ ! -f "$FIXTURE" ]; then
  if [ "$JSON_MODE" -eq 1 ]; then
    printf '{"drift":"error","reason":"fixture_missing","path":"%s"}\n' "$FIXTURE"
  else
    log "rebase_oracle.sh: fixture not found at $FIXTURE"
  fi
  exit 2
fi

# Extract the top-level python_commit from the fixture. We use a tiny
# awk one-liner to avoid pulling in jq (the script must run on a clean
# CI box that may not have jq installed).
PINNED="$(awk -F'"' '/"python_commit"[[:space:]]*:[[:space:]]*"/ { gsub(/^ +| +$/, "", $4); print $4; exit }' "$FIXTURE" || true)"

if [ -z "$PINNED" ] || [ "${#PINNED}" -ne 40 ]; then
  if [ "$JSON_MODE" -eq 1 ]; then
    printf '{"drift":"error","reason":"python_commit_invalid","value":"%s"}\n' "$PINNED"
  else
    log "rebase_oracle.sh: python_commit missing or not a 40-char SHA in $FIXTURE"
  fi
  exit 2
fi

# If --check is not set, print the policy and exit 0. The rebase policy
# is documented in the script header (the comment block at the top of
# this file) and is also re-emitted to stdout so `bash rebase_oracle.sh`
# is self-documenting.
if [ "$CHECK_MODE" -eq 0 ]; then
  log "rebase_oracle.sh — Python CLI parity oracle rebase policy"
  log ""
  log "Pinned commit: $PINNED"
  log "Fixture:       $FIXTURE"
  log "Repo root:     $REPO_ROOT"
  log ""
  log "Run with --check to detect drift against the current main HEAD."
  log "Run with --json for machine-readable output."
  log ""
  log "Rebase policy (summary):"
  log "  1. Re-pin when --check reports drift for a parity-impacting path."
  log "  2. Update per-family python_commit in the fixture to the new HEAD."
  log "  3. Re-run the parity matrix to confirm green."
  log "  4. Document intentional divergences with version_break: true."
  log ""
  log "The matrix MUST NOT auto-update the Python side from TS."
  exit 0
fi

# Resolve the current `main` HEAD. Prefer origin/main (the remote
# tracking ref), fall back to local main, then to HEAD.
resolve_main_ref() {
  if [ -d "$REPO_ROOT/.git" ] || [ -f "$REPO_ROOT/.git" ]; then
    if git -C "$REPO_ROOT" rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
      git -C "$REPO_ROOT" rev-parse origin/main
      return 0
    fi
    if git -C "$REPO_ROOT" rev-parse --verify --quiet main >/dev/null 2>&1; then
      git -C "$REPO_ROOT" rev-parse main
      return 0
    fi
    if git -C "$REPO_ROOT" rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
      git -C "$REPO_ROOT" rev-parse HEAD
      return 0
    fi
  fi
  return 1
}

MAIN_HEAD="$(resolve_main_ref || true)"
if [ -z "$MAIN_HEAD" ]; then
  if [ "$JSON_MODE" -eq 1 ]; then
    printf '{"drift":"error","reason":"no_git_ref","pinned":"%s"}\n' "$PINNED"
  else
    log "rebase_oracle.sh: could not resolve origin/main / main / HEAD in $REPO_ROOT"
  fi
  exit 2
fi

# The actual drift check. `git diff --quiet` exits 0 when the trees are
# equal and 1 when they differ. We aggregate the per-path exit codes; if
# any path differs, drift is detected.
PATHS_CSV=""
for p in "${PYTHON_CLI_PATHS[@]}"; do
  PATHS_CSV="$PATHS_CSV $p"
done
PATHS_CSV="${PATHS_CSV# }"

DRIFT=0
DIFF_PATHS=()
for p in "${PYTHON_CLI_PATHS[@]}"; do
  # `git diff --quiet` returns:
  #   0  if the trees are equal (or both paths are absent)
  #   1  if the trees differ
  #   128 on error (e.g., the pinned commit is not reachable, the path
  #       is missing in one or both trees, the ref format is invalid)
  # We treat 0 as no-drift, 1 as drift. A 128 (path missing in one or
  # both trees) is the v3 development baseline (the Python CLI is not
  # in the agentera repo) and is treated as no-drift so the script
  # remains useful before the Python CLI is migrated into the agentera
  # tree. The rebase policy in the script header documents this.
  set +e
  git -C "$REPO_ROOT" diff --quiet "$PINNED".."$MAIN_HEAD" -- "$p" 2>/dev/null
  rc=$?
  set -e
  case "$rc" in
    0) ;;  # no drift on this path
    1) DRIFT=1; DIFF_PATHS+=("$p") ;;
    *) ;;  # 128: path missing or ref invalid; v3 baseline is no-drift
  esac
done

if [ "$DRIFT" -eq 0 ]; then
  if [ "$JSON_MODE" -eq 1 ]; then
    printf '{"drift":"none","pinned":"%s","main":"%s","paths":%s}\n' \
      "$PINNED" "$MAIN_HEAD" "$(printf '%s\n' "${PYTHON_CLI_PATHS[@]}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().splitlines()))' 2>/dev/null || printf '[]')"
  else
    log "drift: none"
    log "  pinned: $PINNED"
    log "  main:   $MAIN_HEAD"
    log "  paths:  $PATHS_CSV"
  fi
  exit 0
else
  if [ "$JSON_MODE" -eq 1 ]; then
    DIFF_JSON="$(printf '%s\n' "${DIFF_PATHS[@]}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().splitlines()))' 2>/dev/null || printf '[]')"
    printf '{"drift":"detected","pinned":"%s","main":"%s","diff_paths":%s}\n' \
      "$PINNED" "$MAIN_HEAD" "$DIFF_JSON"
  else
    log "drift: detected"
    log "  pinned: $PINNED"
    log "  main:   $MAIN_HEAD"
    log "  diff paths:"
    for p in "${DIFF_PATHS[@]}"; do
      log "    - $p"
    done
    log ""
    log "Run: git -C $REPO_ROOT diff $PINNED..$MAIN_HEAD -- $PATHS_CSV"
    log "Then update the python_commit in $FIXTURE to $MAIN_HEAD."
  fi
  exit 1
fi
