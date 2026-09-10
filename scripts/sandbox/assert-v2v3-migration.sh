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

python3 - "$SANDBOX" "$SCENARIO" "$APP_HOME" <<'PY'
import json, pathlib, sys
root, scenario, app_home = pathlib.Path(sys.argv[1]), sys.argv[2], pathlib.Path(sys.argv[3])
def load(name):
    return json.load(open(root / (name + '.json')))
before, preview_files, after = (load('manifest-' + label) for label in ('before', 'preview', 'after'))
preview, codes = load('preview'), load('exit-codes')
apply = load('apply') if codes['apply'] is not None and (root / 'apply.json').stat().st_size else None
items = [item for phase in preview['phases'] for item in phase['items']]
runtime = next(phase for phase in preview['phases'] if phase['name'] == 'runtime')
app = app_home.relative_to(root).as_posix() + '/'
preserved = {p: digest for p, digest in before.items() if p.startswith(app) and not p.startswith(app + 'app')}
if scenario == 'codex-plugin-vs-copied':
    preserved['home/.codex/config.toml'] = before['home/.codex/config.toml']
observations = {
    'previewLifecycle': preview.get('lifecycleStatus'),
    'applyLifecycle': ('applied' if apply.get('phase') == 'complete' and apply.get('status') == 'success' else apply.get('lifecycleStatus') or apply.get('status')) if apply else ('skipped' if codes['apply'] is None else 'rejected'),
    'exitCodes': codes,
    'applyResult': apply,
    'previewUnchanged': before == preview_files,
    'noMutation': before == after,
    'preservedChecksumOk': all(after.get(p) == digest for p, digest in preserved.items()),
    'preservedPaths': sorted(preserved),
    'appSubTreeRemoved': app + 'app' not in after,
    'unrecognizedAppHomeEntries': sorted(p[len(app):] for p in after if p.startswith(app) and p not in {app + 'app'} and p[len(app):] in {'notes.txt', 'backup'}),
    'runtimeMatrix': {name: ','.join(sorted({i['status'] for i in runtime['items'] if i.get('runtime') == name})) for name in sorted({i['runtime'] for i in runtime['items'] if 'runtime' in i})},
    'runtimeMatrixPhase': 'preview',
    'runtimePreviewItems': runtime['items'],
    'pythonLeftoversFound': None,
    'idempotentSecondRun': None,
    'assertions': {},
}
checks = observations['assertions']
def check(name, value):
    checks[name] = bool(value)
check('preview_read_only', observations['previewUnchanged'])
check('preserved_checksums', observations['preservedChecksumOk'])
check('preview_exit', codes['preview'] == 1)
if scenario == 'stable-safety':
    check('stable_boundary', preview['channel']['channel'] == 'stable' and preview['crossMajorBoundary'] and any(i['action'] == 'major-boundary' and i['status'] == 'blocked' for i in items))
    check('no_cross_major_operations', 'requires_explicit_major_opt_in' not in json.dumps(items))
    check('stable_rejection', codes['apply'] == 1 and apply is None and (root / 'apply.stderr').read_text().strip() == 'upgrade error: v2-to-v3 apply requires the development channel; preview there, then retry with --yes.')
    check('no_mutation', observations['noMutation'])
elif scenario == 'partial-only-runtime':
    check('partial_pending', preview['lifecycleStatus'] == 'manual_review_needed' and runtime['status'] == 'pending' and runtime['summary']['pending'] > 0)
    check('full_cutover_required', any(i['action'] == 'entity-cutover-required' and i['status'] == 'blocked' for i in items))
    check('preview_only', codes['apply'] is None and observations['noMutation'])
else:
    check('forward_state_validation', apply is not None and apply.get('startup_validation', {}).get('status') == 'passed' and apply.get('state_validation', {}).get('status') == 'passed' and apply['state_validation']['entity_count'] > 0)
    check('entity_activation', any(p.startswith('project/.agentera/entities/') for p in after))
    if scenario == 'codex-plugin-vs-copied':
        check('manual_review_preview', preview['lifecycleStatus'] == 'manual_review_needed')
        check('expected_apply_failure', codes['apply'] == 1 and apply is not None and apply.get('phase') == 'apply' and apply.get('status') == 'failed')
        for resource in ('plugin', 'restorer'):
            check('unowned_' + resource, any(i.get('resourceId') == 'agentera.registration.' + resource + '.codex' and i['status'] == 'blocked' and i['action'] == 'review-declared-resource' and 'shared configuration lacks key-level ownership evidence' in i['message'] for i in items))
        check('copied_hook_removed', 'home/.codex/hooks/codex-hooks.json' in before and 'home/.codex/hooks/codex-hooks.json' not in after)
        check('registration_preserved', before['home/.codex/config.toml'] == after.get('home/.codex/config.toml'))
    else:
        check('successful_apply', codes['apply'] == 0 and apply is not None and apply.get('phase') == 'complete' and apply.get('status') == 'success')
        check('app_subtree_removed', observations['appSubTreeRemoved'])
        if scenario == 'happy-path-clean':
            check('clean_codex_fixture', 'home/.codex/config.toml' not in before)
            check('ready_preview', preview['lifecycleStatus'] == 'ready_to_apply')
        if scenario == 'noisy-app-home':
            check('foreign_noise_present_and_preserved', all(p in before and before[p] == after.get(p) for p in (app + 'notes.txt', app + 'backup/readme.txt')))
json.dump(observations, open(root / 'observations.json', 'w'), indent=2, sort_keys=True)
failed = [name for name, passed in checks.items() if not passed]
if failed:
    raise SystemExit('scenario assertions failed: ' + ', '.join(failed))
print('assert_scenario_outcomes: ok')
PY

if [[ "$SCENARIO" == stable-safety || "$SCENARIO" == partial-only-runtime ]]; then
  echo "assert-v2v3-migration: expected refusal/preview-only; no mutation"
  exit 0
fi

second_out="$SANDBOX/second-dry-run.json"
FORCE=()
if [[ "$SCENARIO" == noisy-app-home ]]; then FORCE=(--force); fi
"${CLI[@]}" upgrade --install-root "$APP_HOME" --project "$PROJECT" --home "$HOME" \
  --dry-run --channel development "${FORCE[@]}" >"$second_out" 2>"$SANDBOX/second.stderr" || rc2=$?
rc2="${rc2:-0}"
python3 - "$second_out" "$SCENARIO" "$rc2" "$SANDBOX/observations.json" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1]))
scenario, rc = sys.argv[2], int(sys.argv[3])
pending = payload.get("summary", {}).get("pending", 0)
lifecycle = payload.get("lifecycleStatus")
observations = json.load(open(sys.argv[4]))
idempotent = pending == 0 and lifecycle == 'no_changes_needed' and rc == 0
observations['idempotentSecondRun'] = idempotent
expected = lifecycle == 'manual_review_needed' and rc == 1 if scenario == 'codex-plugin-vs-copied' else idempotent
observations['assertions']['second_preview'] = expected
observations['secondPreviewLifecycle'] = lifecycle
json.dump(observations, open(sys.argv[4], 'w'), indent=2, sort_keys=True)
if not expected:
    raise SystemExit(f"second preview failed pending={pending} lifecycle={lifecycle} rc={rc}")
print('assert_second_preview: ok')
PY

# Scan installed runtime surfaces, not JSON evidence describing retired paths.
# The negative Codex case preserves its registration, not copied Python hooks.
scan_rc=0
for root in "$HOME" "$PROJECT" "$XDG_CONFIG_HOME"; do
  "$SCRIPT_DIR/scan-python-leftovers.sh" "$root" >>"$SANDBOX/python-scan.stderr" || scan_rc=$?
done
python3 - "$SANDBOX" "$scan_rc" <<'PY'
import json, pathlib, sys
root, rc = pathlib.Path(sys.argv[1]), int(sys.argv[2])
hits = [line for line in (root / 'python-scan.stderr').read_text().splitlines() if line.startswith('leftover:')]
expected = rc == 0 and not hits
observations = json.load(open(root / 'observations.json'))
observations['pythonLeftoversFound'] = hits
observations['assertions']['python_leftovers'] = expected
json.dump(observations, open(root / 'observations.json', 'w'), indent=2, sort_keys=True)
if not expected:
    raise SystemExit('unexpected Python leftovers: ' + repr(hits))
PY

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
  env -i "${prime_env[@]}" "${CLI[@]}" prime
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
python3 - "$prime_out" "$expected_install_track" <<'PY'
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
if profile.get("availability") != "deferred" or profile.get("detail_command") != "npx -y agentera@next report profile-grounding":
    raise SystemExit(f"assert_post_migration_prime: invalid profile seam {profile!r}")
print("assert_post_migration_prime: ok")
PY

set +e
(
  cd "$PROJECT"
  env -i "${prime_env[@]}" "${CLI[@]}" report profile-grounding
) >"$profile_out" 2>"$profile_stderr"
profile_rc=$?
set -e

if [[ "$profile_rc" -ne 0 ]]; then
  echo "assert_post_migration_profile: profile grounding exited $profile_rc" >&2
  cat "$profile_stderr" >&2 || true
  exit 1
fi

python3 - "$profile_out" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1]))
validity = payload.get("validity") or {}
if payload.get("status") != "ok" or validity.get("status") != "valid":
    raise SystemExit(f"assert_post_migration_profile: invalid grounding {payload!r}")
print("assert_post_migration_profile: ok")
PY

python3 - "$SANDBOX" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
observations = json.load(open(root / 'observations.json'))
startup = json.load(open(root / 'prime-post-migration.json'))['startup']
# Summarize observed outcomes, not the unrelated command-discovery capsule.
# The full startup response remains in the sandbox evidence file.
observations['startup'] = {key: startup[key] for key in ('outcome', 'state_cutover')}
observations['profileValidity'] = json.load(open(root / 'profile-post-migration.json'))['validity']
observations['assertions']['startup_and_profile'] = observations['startup']['outcome'] == 'ok' and observations['profileValidity']['status'] == 'valid'
json.dump(observations, open(root / 'observations.json', 'w'), indent=2, sort_keys=True)
PY

echo "assert-v2v3-migration: ok"
