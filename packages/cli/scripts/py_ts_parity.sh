#!/usr/bin/env bash
# py_ts_parity.sh — Python CLI parity oracle pin policy and drift check.
#
# The parity oracle fixture
# `packages/cli/test/cli/fixtures/oracle/parity-remaining-families.json` pins
# the Python CLI source to one commit on the agentera `main` branch: the
# top-level `python_commit`, mirrored by every per-family `python_commit`.
# This script reports whether that pin lags the main branch. It needs only the
# fixture, `git`, `python3`, and a main branch reference; it never needs a
# predecessor pin or history outside the main branch.
#
# Usage:
#   bash packages/cli/scripts/py_ts_parity.sh                # print re-pin policy
#   bash packages/cli/scripts/py_ts_parity.sh --check        # report drift
#   bash packages/cli/scripts/py_ts_parity.sh --check --json # machine-readable
#
# Main branch reference: the first of these full refnames that names a commit.
#   1. refs/remotes/origin/main (present in a fresh clone of any branch)
#   2. refs/heads/main
# No other ref, including HEAD, stands in for main.
#
# Exit codes:
#   0   drift: none (`python_commit` equals the main commit)
#   1   drift: detected (`python_commit` differs from the main commit;
#       diff_paths lists files under the Python CLI paths that changed
#       between the pin and main)
#   2   configuration error (python3 missing, fixture missing,
#       python_commit invalid, no git checkout, or no main reference)
#
# Re-pin procedure, when --check reports drift:
#   1. Inspect the Python-side change:
#      git diff <pinned> <main> -- scripts src/agentera
#   2. Set the top-level `python_commit` and every per-family
#      `python_commit` in the fixture to the main commit --check reports.
#   3. Re-run the parity matrix with the source suite: vp run test
#   4. If a family intentionally diverges, set `version_break: true` on that
#      matrix row and document the divergence in `CHANGELOG.md` under a
#      `### Changed` bullet.
#
# The Python CLI is the parity reference, not the port target. The matrix
# MUST NOT auto-update the Python side from TS; this script manages only the
# pin, not the Python source.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CLI_ROOT/../.." && pwd)"
FIXTURE="${PY_TS_PARITY_FIXTURE:-$CLI_ROOT/test/cli/fixtures/oracle/parity-remaining-families.json}"

# Path arguments to `git diff` for the Python CLI source on main.
PYTHON_CLI_PATHS=("scripts" "src/agentera")
MAIN_REFS=("refs/remotes/origin/main" "refs/heads/main")
MAIN_RECOVERY="git -C $REPO_ROOT fetch origin refs/heads/main:refs/remotes/origin/main"

JSON_MODE=0
CHECK_MODE=0

for arg in "$@"; do
  case "$arg" in
  --check) CHECK_MODE=1 ;;
  --json) JSON_MODE=1 ;;
  -h | --help)
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
    exit 0
    ;;
  *)
    echo "py_ts_parity.sh: unknown argument '$arg'" >&2
    exit 2
    ;;
  esac
done

log() {
  if [ "$JSON_MODE" -eq 0 ]; then
    printf '%s\n' "$*"
  fi
}

# Print one compact JSON object from alternating key/value arguments. Values
# for list keys are newline-separated; an empty value is an empty list.
emit_json() {
  python3 -c '
import json
import sys

args = sys.argv[1:]
lists = {"paths", "diff_paths", "checked_refs"}
out = {}
for key, value in zip(args[::2], args[1::2]):
    out[key] = (value.split("\n") if value else []) if key in lists else value
print(json.dumps(out, separators=(",", ":")))
' "$@"
}

join_lines() {
  local IFS=$'\n'
  printf '%s' "$*"
}

if ! command -v python3 >/dev/null 2>&1; then
  echo "py_ts_parity.sh: python3 is required to read $FIXTURE; install python3 and re-run." >&2
  exit 2
fi

if [ ! -f "$FIXTURE" ]; then
  if [ "$JSON_MODE" -eq 1 ]; then
    emit_json drift error reason fixture_missing path "$FIXTURE"
  else
    log "py_ts_parity.sh: fixture not found at $FIXTURE"
  fi
  exit 2
fi

# Extract the top-level pin without depending on fixture line layout or jq.
PINNED="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get("python_commit", ""))' "$FIXTURE" 2>/dev/null || true)"

if ! [[ "$PINNED" =~ ^[0-9a-f]{40}$ ]]; then
  if [ "$JSON_MODE" -eq 1 ]; then
    emit_json drift error reason python_commit_invalid value "$PINNED"
  else
    log "py_ts_parity.sh: python_commit missing or not a 40-character lowercase SHA in $FIXTURE"
  fi
  exit 2
fi

if [ "$CHECK_MODE" -eq 0 ]; then
  log "py_ts_parity.sh — Python CLI parity oracle pin policy"
  log ""
  log "Pinned commit: $PINNED"
  log "Fixture:       $FIXTURE"
  log "Repo root:     $REPO_ROOT"
  log ""
  log "Run with --check to compare the pin with the main branch (${MAIN_REFS[*]})."
  log "Run with --json for machine-readable output."
  log ""
  log "Re-pin policy (summary):"
  log "  1. Re-pin when --check reports drift."
  log "  2. Set the top-level and every per-family python_commit to the main commit."
  log "  3. Re-run the parity matrix with the source suite: vp run test"
  log "  4. Document intentional divergences with version_break: true."
  log ""
  log "The matrix MUST NOT auto-update the Python side from TS."
  exit 0
fi

if ! { [ -d "$REPO_ROOT/.git" ] || [ -f "$REPO_ROOT/.git" ]; } ||
  ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  if [ "$JSON_MODE" -eq 1 ]; then
    emit_json drift error reason no_git_checkout pinned "$PINNED" path "$REPO_ROOT"
  else
    log "py_ts_parity.sh: $REPO_ROOT is not a git checkout; run the check from a clone of the agentera repository."
  fi
  exit 2
fi

MAIN_HEAD=""
MAIN_REF=""
for ref in "${MAIN_REFS[@]}"; do
  if commit="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "${ref}^{commit}" 2>/dev/null)"; then
    MAIN_HEAD="$commit"
    MAIN_REF="$ref"
    break
  fi
done

if [ -z "$MAIN_HEAD" ]; then
  if [ "$JSON_MODE" -eq 1 ]; then
    emit_json drift error reason main_ref_missing pinned "$PINNED" \
      checked_refs "$(join_lines "${MAIN_REFS[@]}")" recovery "$MAIN_RECOVERY"
  else
    log "py_ts_parity.sh: configuration error: no main branch reference in $REPO_ROOT."
    log "  checked: ${MAIN_REFS[*]}"
    log "  This is not drift; the pin cannot be compared without main."
    log "Recovery: fetch main from the canonical remote, then re-run the check:"
    log "  $MAIN_RECOVERY"
  fi
  exit 2
fi

if [ "$PINNED" = "$MAIN_HEAD" ]; then
  if [ "$JSON_MODE" -eq 1 ]; then
    emit_json drift none pinned "$PINNED" main "$MAIN_HEAD" main_ref "$MAIN_REF" \
      paths "$(join_lines "${PYTHON_CLI_PATHS[@]}")"
  else
    log "drift: none"
    log "  pinned: $PINNED"
    log "  main:   $MAIN_HEAD ($MAIN_REF)"
    log "  paths:  ${PYTHON_CLI_PATHS[*]}"
  fi
  exit 0
fi

DIFF_PATHS=()
DIFF_ERROR=""
if git -C "$REPO_ROOT" cat-file -e "${PINNED}^{commit}" 2>/dev/null; then
  mapfile -t DIFF_PATHS < <(git -C "$REPO_ROOT" diff --name-only "$PINNED" "$MAIN_HEAD" -- "${PYTHON_CLI_PATHS[@]}")
else
  DIFF_ERROR="pinned_commit_unavailable"
fi

if [ "$JSON_MODE" -eq 1 ]; then
  fields=(drift detected pinned "$PINNED" main "$MAIN_HEAD" main_ref "$MAIN_REF"
    diff_paths "$(join_lines "${DIFF_PATHS[@]}")")
  if [ -n "$DIFF_ERROR" ]; then
    fields+=(diff_error "$DIFF_ERROR" recovery "$MAIN_RECOVERY")
  fi
  emit_json "${fields[@]}"
else
  log "drift: detected"
  log "  pinned: $PINNED"
  log "  main:   $MAIN_HEAD ($MAIN_REF)"
  if [ -n "$DIFF_ERROR" ]; then
    log "  changed Python paths: unavailable; pinned commit $PINNED is not in this clone."
    log "  Fetch main history to list them: $MAIN_RECOVERY"
  elif [ "${#DIFF_PATHS[@]}" -eq 0 ]; then
    log "  changed Python paths: none under ${PYTHON_CLI_PATHS[*]}"
  else
    log "  changed Python paths:"
    for p in "${DIFF_PATHS[@]}"; do
      log "    - $p"
    done
  fi
  log ""
  log "Re-pin procedure:"
  log "  1. Inspect the Python-side change:"
  log "     git -C $REPO_ROOT diff $PINNED $MAIN_HEAD -- ${PYTHON_CLI_PATHS[*]}"
  log "  2. Set the top-level python_commit and every per-family python_commit in"
  log "     $FIXTURE to $MAIN_HEAD."
  log "  3. Re-run the parity matrix with the source suite: vp run test"
  log "  4. If a family intentionally diverges, set version_break: true on that matrix row"
  log "     and document the divergence in CHANGELOG.md under ### Changed."
fi
exit 1
