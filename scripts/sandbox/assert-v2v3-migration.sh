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
TIER="${AGENTERA_SANDBOX_TIER:-L1}"

export HOME="$SANDBOX/home"
export XDG_CONFIG_HOME="${SANDBOX}/xdg-config"
if [[ "$TIER" == "L2" ]]; then
  PIN="${AGENTERA_NPM_PIN:?npm package assertions require AGENTERA_NPM_PIN}"
  CLI=(npx -y "$PIN")
  unset AGENTERA_BOOTSTRAP_SOURCE_ROOT
else
  CLI=(node "$REPO_ROOT/packages/cli/dist/bin/agentera.js")
  export AGENTERA_BOOTSTRAP_SOURCE_ROOT="${REPO_ROOT}"
fi

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

if [[ "$SCENARIO" != "noisy-app-home" && "$SCENARIO" != "partial-only-runtime" ]]; then
  if [[ -d "$APP_HOME/app" ]]; then
    echo "assert_app_subtree_removed: app/ still present under $APP_HOME" >&2
    exit 1
  fi
  echo "assert_app_subtree_removed: ok"
fi

if [[ "$SCENARIO" == "stable-safety" ]]; then
  stable_out="$SANDBOX/stable-preview.json"
  "${CLI[@]}" upgrade --install-root "$APP_HOME" --project "$PROJECT" --home "$HOME" \
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
"${CLI[@]}" upgrade --install-root "$APP_HOME" --project "$PROJECT" --home "$HOME" \
  --dry-run --format json --channel development >"$second_out" 2>"$SANDBOX/second.stderr" || rc2=$?
rc2="${rc2:-0}"
python3 - <<'PY' "$second_out" "$SCENARIO" "$rc2"
import json, sys
payload = json.load(open(sys.argv[1]))
scenario, rc = sys.argv[2], int(sys.argv[3])
pending = payload.get("summary", {}).get("pending", 0)
lifecycle = payload.get("lifecycleStatus")
if scenario in {"noisy-app-home", "partial-only-runtime"}:
    print("assert_upgrade_idempotent: skipped for scenario", scenario)
else:
    if pending != 0 or lifecycle != "no_changes_needed" or rc != 0:
        raise SystemExit(f"idempotency failed pending={pending} lifecycle={lifecycle} rc={rc}")
    print("assert_upgrade_idempotent: ok")
PY

"$SCRIPT_DIR/scan-python-leftovers.sh" "$SANDBOX"

# Post-migration startup smoke: prime must start cleanly and advertise the
# deferred profile seam; the exact profile command must then validate it.
prime_out="$SANDBOX/prime-post-migration.json"
prime_stderr="$SANDBOX/prime-post-migration.stderr"
profile_out="$SANDBOX/profile-post-migration.json"
profile_stderr="$SANDBOX/profile-post-migration.stderr"
if [[ ! -f "$APP_HOME/PROFILE.md" ]]; then
  printf '%s\n' '<!-- Generated: 2026-06-26 -->' >"$APP_HOME/PROFILE.md"
fi
set +e
prime_env=(
  "HOME=$HOME"
  "XDG_CONFIG_HOME=$XDG_CONFIG_HOME"
  "PATH=${PATH:-/usr/bin:/bin}"
  "USER=${USER:-sandbox}"
)
if [[ "$TIER" == "L2" ]]; then
  prime_env+=(
    "NPM_CONFIG_CACHE=${NPM_CONFIG_CACHE:?}"
    "NPM_CONFIG_USERCONFIG=${NPM_CONFIG_USERCONFIG:?}"
    "NPM_CONFIG_GLOBALCONFIG=${NPM_CONFIG_GLOBALCONFIG:?}"
  )
else
  prime_env+=("AGENTERA_BOOTSTRAP_SOURCE_ROOT=$REPO_ROOT")
fi
(
  cd "$PROJECT"
  env -i "${prime_env[@]}" "${CLI[@]}" prime --format json
) >"$prime_out" 2>"$prime_stderr"
prime_rc=$?
set -e

if [[ "$prime_rc" -ne 0 ]]; then
  echo "assert_post_migration_prime: prime exited $prime_rc" >&2
  cat "$prime_stderr" >&2 || true
  exit 1
fi

expected_install_track="source"
if [[ "$TIER" == "L2" ]]; then
  expected_install_track="v3"
fi
python3 - <<'PY' "$prime_out" "$expected_install_track"
import json, sys
payload = json.load(open(sys.argv[1]))
expected_install_track = sys.argv[2]
if payload.get("outcome") != "ok":
    raise SystemExit(f"assert_post_migration_prime: outcome is {payload.get('outcome')!r}")
app_home = payload.get("app_home") or {}
if app_home.get("status") != "up_to_date" or app_home.get("install_track") != expected_install_track:
    raise SystemExit(f"assert_post_migration_prime: invalid app home {app_home!r}")
startup = payload.get("startup") or {}
cutover = startup.get("state_cutover") or {}
if startup.get("outcome") != "ok" or cutover.get("status") != "complete" or cutover.get("project_state") != "v3":
    raise SystemExit(f"assert_post_migration_prime: invalid startup {startup!r}")
profile = next((row for row in startup.get("availability", []) if row.get("family") == "profile"), {})
if profile.get("availability") != "deferred" or profile.get("detail_command") != "npx -y agentera@next report profile-grounding --format json":
    raise SystemExit(f"assert_post_migration_prime: invalid profile seam {profile!r}")
print("assert_post_migration_prime: ok")
PY

set +e
(
  cd "$PROJECT"
  env -i "${prime_env[@]}" "${CLI[@]}" report profile-grounding --format json
) >"$profile_out" 2>"$profile_stderr"
profile_rc=$?
set -e

if [[ "$profile_rc" -ne 0 ]]; then
  echo "assert_post_migration_profile: profile grounding exited $profile_rc" >&2
  cat "$profile_stderr" >&2 || true
  exit 1
fi

python3 - <<'PY' "$profile_out"
import json, sys
payload = json.load(open(sys.argv[1]))
validity = payload.get("validity") or {}
if payload.get("status") != "ok" or validity.get("status") != "valid":
    raise SystemExit(f"assert_post_migration_profile: invalid grounding {payload!r}")
print("assert_post_migration_profile: ok")
PY

echo "assert-v2v3-migration: ok"
