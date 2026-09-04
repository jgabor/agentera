#!/usr/bin/env bash
# py_ts_parity.sh — Python CLI parity oracle rebase policy and drift check.
#
# The npm `@next` parity oracle is pinned to a single commit on the agentera
# `main` branch (the `python_commit` field in
# `packages/cli/test/cli/fixtures/oracle/parity-remaining-families.json`).
# This script is the maintainer seam for re-pinning when the Python CLI
# source drifts in a parity-impacting way.
#
# Usage:
#   bash packages/cli/scripts/py_ts_parity.sh                # print rebase policy
#   bash packages/cli/scripts/py_ts_parity.sh --check        # emit drift status
#   bash packages/cli/scripts/py_ts_parity.sh --check --json # machine-readable
#
# Exit codes:
#   0   drift: none (`python_commit` equals `origin/main` HEAD and any
#       recorded re-pin has owner-valid source-equivalence evidence)
#   1   drift: detected (`python_commit` differs from `origin/main` HEAD;
#              diff_paths lists Python CLI paths that changed between the
#              pinned commit and main)
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
#   1. Run `bash packages/cli/scripts/py_ts_parity.sh --check` to confirm
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
FIXTURE="${PY_TS_PARITY_FIXTURE:-$CLI_ROOT/test/cli/fixtures/oracle/parity-remaining-families.json}"

# Path arguments to `git diff` for the Python CLI source.
PYTHON_CLI_PATHS=(
  "scripts/agentera"
  "scripts"
  "src/agentera"
)

# JSON output mode (set by --json).
JSON_MODE=0
CHECK_MODE=0

for arg in "$@"; do
  case "$arg" in
  --check) CHECK_MODE=1 ;;
  --json) JSON_MODE=1 ;;
  -h | --help)
    sed -n '2,46p' "$0"
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

if [ ! -f "$FIXTURE" ]; then
  if [ "$JSON_MODE" -eq 1 ]; then
    printf '{"drift":"error","reason":"fixture_missing","path":"%s"}\n' "$FIXTURE"
  else
    log "py_ts_parity.sh: fixture not found at $FIXTURE"
  fi
  exit 2
fi

# Extract the top-level pin without depending on fixture line layout or jq.
PINNED="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get("python_commit", ""))' "$FIXTURE" 2>/dev/null || true)"

if [ -z "$PINNED" ] || [ "${#PINNED}" -ne 40 ]; then
  if [ "$JSON_MODE" -eq 1 ]; then
    printf '{"drift":"error","reason":"python_commit_invalid","value":"%s"}\n' "$PINNED"
  else
    log "py_ts_parity.sh: python_commit missing or not a 40-char SHA in $FIXTURE"
  fi
  exit 2
fi

# If --check is not set, print the policy and exit 0. The rebase policy
# is documented in the script header (the comment block at the top of
# this file) and is also re-emitted to stdout so `bash py_ts_parity.sh`
# is self-documenting.
if [ "$CHECK_MODE" -eq 0 ]; then
  log "py_ts_parity.sh — Python CLI parity oracle rebase policy"
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
    log "py_ts_parity.sh: could not resolve origin/main / main / HEAD in $REPO_ROOT"
  fi
  exit 2
fi

# A re-pin is valid only when the canonical fixture records the exact old and
# target commits and the full tracked source trees hash to the recorded SHA-256.
# Hashing framed, sorted archive members ignores commit timestamps while binding
# every tracked path, mode, type, link target, and byte.
mapfile -t PIN_EVIDENCE < <(
  python3 - "$FIXTURE" <<'PY'
import json
import sys

try:
    evidence = json.load(open(sys.argv[1], encoding="utf-8"))["pinEvidence"]
    source = evidence["sourceEquivalence"]
    fields = [
        evidence["schemaVersion"],
        evidence["owner"],
        evidence["ownerTest"],
        evidence["previous_python_commit"],
        evidence["target_python_commit"],
        evidence["target_ref"],
        source["method"],
        source["scope"],
        source["previousSha256"],
        source["targetSha256"],
    ]
    print("\n".join(fields))
except (KeyError, TypeError, ValueError, OSError):
    pass
PY
)

source_tree_sha256() {
  python3 - "$REPO_ROOT" "$1" <<'PY'
import hashlib
import io
import subprocess
import sys
import tarfile

root, commit = sys.argv[1:]
archive = subprocess.check_output(["git", "-C", root, "archive", "--format=tar", commit])
digest = hashlib.sha256()
with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as handle:
    for member in sorted(handle.getmembers(), key=lambda entry: entry.name):
        body = handle.extractfile(member).read() if member.isfile() else member.linkname.encode()
        for field in (member.name.encode(), str(member.mode).encode(), member.type, body):
            digest.update(str(len(field)).encode() + b":" + field)
print(digest.hexdigest())
PY
}

if [ "$PINNED" = "$MAIN_HEAD" ]; then
  if [ "${#PIN_EVIDENCE[@]}" -ne 10 ]; then
    REASON="pin_evidence_missing"
  elif [ "${PIN_EVIDENCE[0]}" != "agentera.pythonTypescriptParityPin.v1" ] ||
    [ "${PIN_EVIDENCE[1]}" != "packages/cli/scripts/py_ts_parity.sh" ] ||
    [ "${PIN_EVIDENCE[2]}" != "packages/cli/test/scripts/pyTsParity.test.ts" ] ||
    [ "${PIN_EVIDENCE[4]}" != "$PINNED" ] ||
    [ "${PIN_EVIDENCE[5]}" != "origin/main" ] ||
    [ "${PIN_EVIDENCE[6]}" != "sha256-framed-sorted-git-archive-members-v1" ] ||
    [ "${PIN_EVIDENCE[7]}" != "full tracked tree" ]; then
    REASON="pin_evidence_contract"
  else
    PREVIOUS_SHA="$(source_tree_sha256 "${PIN_EVIDENCE[3]}" 2>/dev/null || true)"
    TARGET_SHA="$(source_tree_sha256 "${PIN_EVIDENCE[4]}" 2>/dev/null || true)"
    PREVIOUS_TREE="$(git -C "$REPO_ROOT" rev-parse "${PIN_EVIDENCE[3]}^{tree}" 2>/dev/null || true)"
    TARGET_TREE="$(git -C "$REPO_ROOT" rev-parse "${PIN_EVIDENCE[4]}^{tree}" 2>/dev/null || true)"
    if [ -z "$PREVIOUS_SHA" ] || [ "$PREVIOUS_SHA" != "${PIN_EVIDENCE[8]}" ] ||
      [ "$TARGET_SHA" != "${PIN_EVIDENCE[9]}" ] || [ "$PREVIOUS_SHA" != "$TARGET_SHA" ] ||
      [ -z "$PREVIOUS_TREE" ] || [ "$PREVIOUS_TREE" != "$TARGET_TREE" ]; then
      REASON="pin_evidence_source_mismatch"
    else
      REASON=""
    fi
  fi
  if [ -n "$REASON" ]; then
    if [ "$JSON_MODE" -eq 1 ]; then
      printf '{"drift":"error","reason":"%s","pinned":"%s","main":"%s"}\n' "$REASON" "$PINNED" "$MAIN_HEAD"
    else
      log "py_ts_parity.sh: owner evidence failed: $REASON"
    fi
    exit 2
  fi
fi

# Primary drift check: the oracle pin must equal `origin/main` HEAD so the
# fixture cannot silently lag behind main (#34).
PATHS_CSV=""
for p in "${PYTHON_CLI_PATHS[@]}"; do
  PATHS_CSV="$PATHS_CSV $p"
done
PATHS_CSV="${PATHS_CSV# }"

DRIFT=0
DIFF_PATHS=()
if [ "$PINNED" != "$MAIN_HEAD" ]; then
  DRIFT=1
  for p in "${PYTHON_CLI_PATHS[@]}"; do
    set +e
    git -C "$REPO_ROOT" diff --quiet "$PINNED".."$MAIN_HEAD" -- "$p" 2>/dev/null
    rc=$?
    set -e
    case "$rc" in
    1) DIFF_PATHS+=("$p") ;;
    esac
  done
fi

print_rebase_procedure() {
  log "Rebase procedure:"
  log "  1. Update per-family python_commit in $FIXTURE to $MAIN_HEAD."
  log "  2. Re-run: pnpm -C packages/cli test -- npmParityMatrix"
  log "  3. If a family intentionally diverges, set version_break: true on that row."
  log "  4. Inspect Python-side changes:"
  log "     git -C $REPO_ROOT diff $PINNED..$MAIN_HEAD -- $PATHS_CSV"
}

if [ "$DRIFT" -eq 0 ]; then
  if [ "$JSON_MODE" -eq 1 ]; then
    python3 - "$PINNED" "$MAIN_HEAD" "${PIN_EVIDENCE[3]}" "$PREVIOUS_SHA" "$TARGET_SHA" "${PYTHON_CLI_PATHS[@]}" <<'PY'
import json
import sys

pinned, main, previous, previous_sha, target_sha, *paths = sys.argv[1:]
print(json.dumps({
    "drift": "none",
    "pinned": pinned,
    "main": main,
    "paths": paths,
    "owner_evidence": {
        "previous": previous,
        "target": pinned,
        "source_equivalent": previous_sha == target_sha,
        "previous_sha256": previous_sha,
        "target_sha256": target_sha,
    },
}, separators=(",", ":")))
PY
  else
    log "drift: none"
    log "  pinned: $PINNED"
    log "  main:   $MAIN_HEAD"
    log "  paths:  $PATHS_CSV"
    log "  owner evidence: ${PIN_EVIDENCE[3]} -> $PINNED; full tracked source SHA-256 $TARGET_SHA"
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
    print_rebase_procedure
  fi
  exit 1
fi
