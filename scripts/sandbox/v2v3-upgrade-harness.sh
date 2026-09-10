#!/usr/bin/env bash
# End-to-end v2→v3 sandbox harness for a fixture or P0 scenario.
set -euo pipefail

SCENARIO="${1:-happy-path-clean}"
TIER="${AGENTERA_SANDBOX_TIER:-L1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/agentera-v2v3.XXXXXX")"

cleanup() {
  if [[ -n "${AGENTERA_SANDBOX_EVIDENCE_DIR:-}" ]]; then
    mkdir -p "$AGENTERA_SANDBOX_EVIDENCE_DIR/$SCENARIO"
    cp "$SANDBOX/"*.json "$SANDBOX/"*.stderr "$AGENTERA_SANDBOX_EVIDENCE_DIR/$SCENARIO/"
  fi
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

export REPO_ROOT
export NPM_CONFIG_CACHE="$SANDBOX/npm-cache"
mkdir -p "$NPM_CONFIG_CACHE"
"$SCRIPT_DIR/seed-v2-fixture.sh" "$SANDBOX" "$SCENARIO" >/dev/null
export HOME="$SANDBOX/home"
export XDG_CONFIG_HOME="$SANDBOX/xdg-config"
APP_HOME="$HOME/.local/share/agentera"
if [[ "$SCENARIO" == "legacy-home-retirement" ]]; then
  APP_HOME="$HOME/.agents/agentera"
fi
PROJECT="$SANDBOX/project"

# Cross-major apply requires the complete v2 source tracked unchanged at HEAD.
git -C "$PROJECT" init -q
git -C "$PROJECT" add -f .
git -C "$PROJECT" \
  -c user.name=Agentera \
  -c user.email=agentera@example.invalid \
  -c commit.gpgsign=false \
  commit --allow-empty -qm "seed v2 fixture"

if [[ "$TIER" == "L2" ]]; then
  unset AGENTERA_BOOTSTRAP_SOURCE_ROOT
  unset NPM_TOKEN NODE_AUTH_TOKEN npm_config_userconfig npm_config_globalconfig npm_config_registry NPM_CONFIG_REGISTRY
  export NPM_CONFIG_USERCONFIG="$SANDBOX/npm-user.npmrc"
  export NPM_CONFIG_GLOBALCONFIG="$SANDBOX/npm-global.npmrc"
  printf 'registry=https://registry.npmjs.org/\n' >"$NPM_CONFIG_USERCONFIG"
  printf 'registry=https://registry.npmjs.org/\n' >"$NPM_CONFIG_GLOBALCONFIG"
  chmod 600 "$NPM_CONFIG_USERCONFIG" "$NPM_CONFIG_GLOBALCONFIG"
  PIN="${AGENTERA_NPM_PIN:-agentera@3.0.0-next.0}"
  CLI=(npx -y "$PIN")
else
  export AGENTERA_BOOTSTRAP_SOURCE_ROOT="$REPO_ROOT"
  CLI=(node "$REPO_ROOT/packages/cli/dist/bin/agentera.js")
  if [[ ! -f "$REPO_ROOT/packages/cli/dist/bin/agentera.js" ]]; then
    echo 'harness: build the checkout CLI with vp run build first' >&2
    exit 1
  fi
fi

CHANNEL=(--channel development)
if [[ "$SCENARIO" == "stable-safety" ]]; then CHANNEL=(--channel stable); fi
ONLY=()
if [[ "$SCENARIO" == "partial-only-runtime" ]]; then ONLY=(--only runtime); fi
FORCE=()
if [[ "$SCENARIO" == "noisy-app-home" ]]; then FORCE=(--force); fi

collect_manifest() {
  python3 - "$SANDBOX" "$1" <<'PY'
import hashlib, json, os, pathlib, sys
root, label = pathlib.Path(sys.argv[1]), sys.argv[2]
manifest = {}
for name in ('home', 'project', 'xdg-config'):
    for base, dirs, files in os.walk(root / name):
        dirs[:] = sorted(d for d in dirs if d != '.git')
        for entry in sorted(dirs + files):
            p = pathlib.Path(base) / entry
            key = p.relative_to(root).as_posix()
            if p.is_symlink():
                manifest[key] = 'link:' + os.readlink(p)
            elif p.is_file():
                manifest[key] = hashlib.sha256(p.read_bytes()).hexdigest()
            else:
                manifest[key] = 'directory'
json.dump(manifest, open(root / ('manifest-' + label + '.json'), 'w'), indent=2, sort_keys=True)
PY
}
collect_manifest before
preview_rc=0
"${CLI[@]}" upgrade --install-root "$APP_HOME" --project "$PROJECT" --home "$HOME" \
  "${CHANNEL[@]}" "${ONLY[@]}" --dry-run \
  >"$SANDBOX/preview.json" 2>"$SANDBOX/preview.stderr" || preview_rc=$?
collect_manifest preview

# Partial migration remains preview-only. Stable apply must reject without mutation.
apply_rc=skipped
if [[ "$SCENARIO" != "partial-only-runtime" ]]; then
  apply_rc=0
  "${CLI[@]}" upgrade --install-root "$APP_HOME" --project "$PROJECT" --home "$HOME" \
    "${CHANNEL[@]}" "${ONLY[@]}" "${FORCE[@]}" --yes \
    >"$SANDBOX/apply.json" 2>"$SANDBOX/apply.stderr" || apply_rc=$?
fi
collect_manifest after
python3 - "$SANDBOX/exit-codes.json" "$preview_rc" "$apply_rc" <<'PY'
import json, sys
json.dump({'preview': int(sys.argv[2]), 'apply': None if sys.argv[3] == 'skipped' else int(sys.argv[3])}, open(sys.argv[1], 'w'))
PY

overall=pass
"$SCRIPT_DIR/assert-v2v3-migration.sh" "$SANDBOX" "$SCENARIO" || overall=fail
cli_version=repo-dist
if [[ "$TIER" == "L2" ]]; then cli_version="$PIN"; fi
python3 - "$SANDBOX" "$SCENARIO" "$TIER" "$cli_version" "$overall" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
observations = root / 'observations.json'
payload = json.load(open(observations)) if observations.exists() else {}
payload.update(fixtureId=sys.argv[2], tier=sys.argv[3], cliVersion=sys.argv[4], overall=sys.argv[5])
json.dump(payload, open(root / 'sandbox-report.json', 'w'), indent=2, sort_keys=True)
print(json.dumps(payload, indent=2))
PY
cp "$SANDBOX/sandbox-report.json" "$REPO_ROOT/sandbox-report-$SCENARIO.json"
if [[ "$overall" != pass ]]; then
  echo "harness failed for $SCENARIO (preview_rc=$preview_rc apply_rc=$apply_rc)" >&2
  exit 1
fi
echo "harness passed: $SCENARIO (expected scenario outcome, not necessarily successful migration)"
