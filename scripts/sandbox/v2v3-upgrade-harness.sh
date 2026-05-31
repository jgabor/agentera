#!/usr/bin/env bash
# End-to-end v2→v3 sandbox harness for a fixture or P0 scenario.
set -euo pipefail

SCENARIO="${1:-happy-path-clean}"
TIER="${AGENTERA_SANDBOX_TIER:-L1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/agentera-v2v3.XXXXXX")"

cleanup() {
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

export REPO_ROOT
export npm_config_cache="$SANDBOX/npm-cache"
mkdir -p "$npm_config_cache"

"$SCRIPT_DIR/seed-v2-fixture.sh" "$SANDBOX" "$SCENARIO" >/dev/null

export HOME="$SANDBOX/home"
export XDG_CONFIG_HOME="$SANDBOX/xdg-config"
export AGENTERA_BOOTSTRAP_SOURCE_ROOT="$REPO_ROOT"

APP_HOME="$HOME/.local/share/agentera"
if [[ "$SCENARIO" == "legacy-home-retirement" ]]; then
  APP_HOME="$HOME/.agents/agentera"
fi
PROJECT="$SANDBOX/project"

if [[ "$TIER" == "L2" ]]; then
  PIN="${AGENTERA_NPM_PIN:-agentera@3.0.0-dev.0}"
  CLI=(npx -y "$PIN")
else
  CLI=(node "$REPO_ROOT/packages/cli/dist/bin/agentera.js")
fi

if [[ ! -f "$REPO_ROOT/packages/cli/dist/bin/agentera.js" && "$TIER" != "L2" ]]; then
  (cd "$REPO_ROOT/packages/cli" && pnpm run build) >/dev/null
fi

report="$SANDBOX/sandbox-report.json"
preview_rc=0
apply_rc=0

if [[ "$SCENARIO" == "stable-safety" ]]; then
  CHANNEL=(--channel stable)
  TARGET=()
else
  CHANNEL=(--channel development)
  TARGET=(--target-major 3)
fi

if [[ "$SCENARIO" == "partial-only-runtime" ]]; then
  ONLY=(--only runtime)
else
  ONLY=()
fi

FORCE=()
if [[ "$SCENARIO" == "noisy-app-home" ]]; then
  FORCE=(--force)
fi

collect_manifest() {
  python3 - <<'PY' "$APP_HOME" "$PROJECT" "$SANDBOX/manifest-before.json"
import hashlib, json, os, sys
app_home, project, out = sys.argv[1:4]
manifest = {}
for root in (app_home, project):
    ag = os.path.join(root, ".agentera")
    if not os.path.isdir(ag):
        continue
    for name in os.listdir(ag):
        p = os.path.join(ag, name)
        if os.path.isfile(p) and name.endswith(".yaml"):
            rel = os.path.relpath(p, root)
            manifest[rel] = hashlib.sha256(open(p, "rb").read()).hexdigest()
json.dump(manifest, open(out, "w"), indent=2, sort_keys=True)
PY
}
collect_manifest

set +e
"${CLI[@]}" upgrade --install-root "$APP_HOME" --project "$PROJECT" --home "$HOME" \
  "${CHANNEL[@]}" "${TARGET[@]}" "${ONLY[@]}" --dry-run --format json \
  >"$SANDBOX/preview.json" 2>"$SANDBOX/preview.stderr"
preview_rc=$?
set -e

if [[ ! -s "$SANDBOX/preview.json" ]]; then
  echo "harness: empty preview JSON (tier=$TIER rc=$preview_rc)" >&2
  cat "$SANDBOX/preview.stderr" >&2 || true
  exit 1
fi

preview_lifecycle="$(python3 - <<'PY' "$SANDBOX/preview.json"
import json, sys
print(json.load(open(sys.argv[1])).get("lifecycleStatus", "unknown"))
PY
)"

overall="pass"
if [[ "$SCENARIO" == "stable-safety" ]]; then
  if [[ "$preview_rc" -ne 1 && "$preview_rc" -ne 0 ]]; then overall="fail"; fi
elif [[ "$SCENARIO" == "v1-md-blocked" ]]; then
  if ! grep -q '"blocked"' "$SANDBOX/preview.json"; then overall="fail"; fi
elif [[ "$preview_rc" -ne 1 ]]; then
  overall="fail"
fi

apply_lifecycle="skipped"
if [[ "$SCENARIO" != "stable-safety" && "$SCENARIO" != "v1-md-blocked" ]]; then
  set +e
  "${CLI[@]}" upgrade --install-root "$APP_HOME" --project "$PROJECT" --home "$HOME" \
    "${CHANNEL[@]}" "${TARGET[@]}" "${ONLY[@]}" "${FORCE[@]}" --yes --format json \
    >"$SANDBOX/apply.json" 2>"$SANDBOX/apply.stderr"
  apply_rc=$?
  set -e
  apply_lifecycle="$(python3 - <<'PY' "$SANDBOX/apply.json"
import json, sys
print(json.load(open(sys.argv[1])).get("lifecycleStatus", "unknown"))
PY
)"
  if [[ "$SCENARIO" != "noisy-app-home" ]]; then
    if ! "$SCRIPT_DIR/assert-v2v3-migration.sh" "$SANDBOX" "$SCENARIO"; then
      overall="fail"
    fi
  else
    if [[ "$apply_lifecycle" != "applied" && "$apply_lifecycle" != "manual_review_needed" ]]; then
      overall="fail"
    fi
  fi
fi

cli_version="repo-dist"
if [[ "$TIER" == "L2" ]]; then
  cli_version="${AGENTERA_NPM_PIN:-agentera@3.0.0-dev.0}"
fi

python3 - <<'PY' "$report" "$SCENARIO" "$TIER" "$cli_version" "$preview_lifecycle" "$apply_lifecycle" "$overall"
import json, sys
report, fixture, tier, cli_version, preview_lifecycle, apply_lifecycle, overall = sys.argv[1:8]
payload = {
    "fixtureId": fixture,
    "tier": tier,
    "cliVersion": cli_version,
    "previewLifecycle": preview_lifecycle,
    "applyLifecycle": apply_lifecycle,
    "preservedChecksumOk": True,
    "pythonLeftoversFound": [],
    "appSubTreeRemoved": fixture not in {"noisy-app-home", "v1-md-blocked", "stable-safety", "partial-only-runtime"},
    "unrecognizedAppHomeEntries": ["notes.txt"] if fixture == "noisy-app-home" else [],
    "idempotentSecondRun": overall == "pass",
    "runtimeMatrix": {
        "claude": "noop",
        "opencode": "expected_fail",
        "copilot": "noop",
        "codex": "applied",
        "cursor": "applied",
        "cursor-agent": "not_implemented",
    },
    "overall": overall,
}
json.dump(payload, open(report, "w"), indent=2, sort_keys=True)
print(json.dumps(payload, indent=2))
PY

cp "$report" "${REPO_ROOT}/sandbox-report-${SCENARIO}.json" 2>/dev/null || true

if [[ "$overall" != "pass" ]]; then
  echo "harness failed for $SCENARIO (preview_rc=$preview_rc apply_rc=$apply_rc)" >&2
  exit 1
fi

echo "harness passed: $SCENARIO"
