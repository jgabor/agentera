#!/usr/bin/env bash
# Post-apply assertions for v2→v3 sandbox migration.
set -euo pipefail

SANDBOX="${1:-}"
SCENARIO="${2:-happy-path-clean}"
if [[ -z "$SANDBOX" || ! -d "$SANDBOX" ]]; then
  echo "usage: assert-v2v3-migration.sh <sandbox-root> [scenario-id]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
CLI="${AGENTERA_CLI:-node $REPO_ROOT/packages/cli/dist/bin/agentera.js}"

export HOME="$SANDBOX/home"
export XDG_CONFIG_HOME="${SANDBOX}/xdg-config"
export AGENTERA_BOOTSTRAP_SOURCE_ROOT="${REPO_ROOT}"

APP_HOME="${AGENTERA_INSTALL_ROOT:-$HOME/.local/share/agentera}"
PROJECT="${AGENTERA_PROJECT:-$SANDBOX/project}"

manifest_before="$SANDBOX/manifest-before.json"
manifest_after="$SANDBOX/manifest-after.json"

collect_manifest() {
  local out="$1"
  python3 - <<'PY' "$APP_HOME" "$PROJECT" "$out"
import hashlib, json, os, sys
app_home, project, out = sys.argv[1:4]
paths = []
for root, rels in ((app_home, [
    ".agentera/progress.yaml", ".agentera/decisions.yaml", ".agentera/health.yaml",
    ".agentera/plan.yaml", ".agentera/docs.yaml", ".agentera/vision.yaml",
]), (project, [])):
    if not os.path.isdir(root):
        continue
    ag = os.path.join(root, ".agentera")
    if os.path.isdir(ag):
        for name in os.listdir(ag):
            p = os.path.join(ag, name)
            if os.path.isfile(p) and name.endswith(".yaml"):
                paths.append(os.path.relpath(p, app_home if root == app_home else project))
    for rel in rels:
        p = os.path.join(root, rel)
        if os.path.isfile(p):
            key = rel if root == app_home else os.path.join(".agentera", os.path.basename(rel))
            paths.append(key)
manifest = {}
for rel in sorted(set(paths)):
    base = app_home if rel.startswith(".agentera") and os.path.isfile(os.path.join(app_home, rel)) else project
    full = os.path.join(base if rel.startswith(".") else project, rel)
    if not os.path.isfile(full):
        full = os.path.join(app_home, rel)
    if os.path.isfile(full):
        h = hashlib.sha256(open(full, "rb").read()).hexdigest()
        manifest[rel] = h
json.dump(manifest, open(out, "w"), indent=2, sort_keys=True)
PY
}

if [[ -f "$manifest_before" ]]; then
  collect_manifest "$manifest_after"
  python3 - <<'PY' "$manifest_before" "$manifest_after"
import json, sys
before, after = map(json.load, (open(sys.argv[1]), open(sys.argv[2])))
for k, v in before.items():
    if after.get(k) != v:
        raise SystemExit(f"checksum mismatch for preserved path {k}")
print("assert_preserved_checksums: ok")
PY
fi

if [[ "$SCENARIO" != "noisy-app-home" && "$SCENARIO" != "v1-md-blocked" && "$SCENARIO" != "partial-only-runtime" ]]; then
  if [[ -d "$APP_HOME/app" ]]; then
    echo "assert_app_subtree_removed: app/ still present under $APP_HOME" >&2
    exit 1
  fi
  echo "assert_app_subtree_removed: ok"
fi

if [[ "$SCENARIO" == "stable-safety" ]]; then
  stable_out="$SANDBOX/stable-preview.json"
  $CLI upgrade --install-root "$APP_HOME" --project "$PROJECT" --home "$HOME" \
    --dry-run --format json --channel stable >"$stable_out" 2>"$SANDBOX/stable.stderr" || rc=$?
  rc="${rc:-0}"
  python3 - <<'PY' "$stable_out"
import json, sys
payload = json.load(open(sys.argv[1]))
text = json.dumps(payload)
if "requires_explicit_major_opt_in" in text:
    raise SystemExit("stable preview contains cross-major ops")
print("assert_stable_channel_safe: ok")
PY
fi

second_out="$SANDBOX/second-dry-run.json"
$CLI upgrade --install-root "$APP_HOME" --project "$PROJECT" --home "$HOME" \
  --dry-run --format json --channel development --target-major 3 >"$second_out" 2>"$SANDBOX/second.stderr" || rc2=$?
rc2="${rc2:-0}"
python3 - <<'PY' "$second_out" "$SCENARIO" "$rc2"
import json, sys
payload = json.load(open(sys.argv[1]))
scenario, rc = sys.argv[2], int(sys.argv[3])
pending = payload.get("summary", {}).get("pending", 0)
lifecycle = payload.get("lifecycleStatus")
if scenario in {"noisy-app-home", "v1-md-blocked", "partial-only-runtime"}:
    print("assert_upgrade_idempotent: skipped for scenario", scenario)
else:
    if pending != 0 or lifecycle != "no_changes_needed" or rc != 0:
        raise SystemExit(f"idempotency failed pending={pending} lifecycle={lifecycle} rc={rc}")
    print("assert_upgrade_idempotent: ok")
PY

"$SCRIPT_DIR/scan-python-leftovers.sh" "$SANDBOX"
