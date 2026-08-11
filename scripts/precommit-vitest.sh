#!/usr/bin/env bash
# Staged-aware source verifier for lefthook pre-commit on feat/v3.
# Exit 0 means targeted source tests and typecheck passed. Exit 1 means a check
# or the wall-time budget failed. Exit 2 means routing or local prerequisites
# were invalid. Specialized owners remain authoritative in required CI.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"

# Git hook invocations can export repository-local variables such as GIT_DIR
# and GIT_WORK_TREE. The test suite creates independent Git fixture
# repositories; letting those variables cross that boundary could redirect a
# fixture commit or config write into this checkout. Use Git's own complete
# list before launching any test subprocesses.
mapfile -t GIT_LOCAL_ENV_VARS < <(git rev-parse --local-env-vars)
for git_local_env_var in "${GIT_LOCAL_ENV_VARS[@]}"; do unset "$git_local_env_var"; done

cd "$ROOT/packages/cli"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "precommit-vitest: pnpm not found" >&2
  exit 2
fi
if ! command -v timeout >/dev/null 2>&1; then
  echo "precommit-vitest: timeout not found; install GNU coreutils and retry" >&2
  exit 2
fi

STAGED=()
PRINT_ROUTE=""
PRINT_TARGETS=""
for arg in "$@"; do
  case "$arg" in
    --print-route) PRINT_ROUTE=1 ;;
    --print-targets) PRINT_TARGETS=1 ;;
    --) ;;
    -*)
      echo "precommit-vitest: unknown option '$arg'; expected --print-route, --print-targets, or staged paths" >&2
      exit 2
      ;;
    /*) STAGED+=("${arg#"$ROOT"/}") ;;
    *) STAGED+=("$arg") ;;
  esac
done

if [[ ${#STAGED[@]} -eq 0 ]]; then
  echo "precommit-vitest: at least one staged path is required" >&2
  exit 2
fi
if [[ -n "$PRINT_TARGETS" && -z "$PRINT_ROUTE" ]]; then
  echo "precommit-vitest: --print-targets requires --print-route" >&2
  exit 2
fi

SMOKE=(
  test/registries/evaluatorHandoffContract.test.ts
)
CI_GUARDS=(
  test/verification/laneOwnership.test.ts
  test/release/routineCiOwnership.test.ts
)

ROUTE="precommit"
CI_OWNERS=()
TARGETS=()

add_target() {
  local t="$1"
  [[ " ${TARGETS[*]} " == *" $t "* ]] || TARGETS+=("$t")
}

add_source_target() {
  local relative="${1#packages/cli/src/}"
  local directory="${relative%/*}"
  local filename="${relative##*/}"
  local stem="${filename%.ts}"
  local direct="test/${directory}/${stem}.test.ts"
  local area="${relative%%/*}"
  local area_target="test/${area}/${stem}.test.ts"
  local root_target="test/${stem}.test.ts"

  if [[ -f "$direct" ]]; then add_target "$direct"
  elif [[ -f "$area_target" ]]; then add_target "$area_target"
  elif [[ -f "$root_target" ]]; then add_target "$root_target"
  else
    for smoke in "${SMOKE[@]}"; do add_target "$smoke"; done
  fi
}

ROUTE="$(node scripts/verify-lane.mjs route --policy-only "${STAGED[@]}")"
case "$ROUTE" in
  precommit) ;;
  ci_owned)
    OWNER_OUTPUT="$(node scripts/verify-lane.mjs route --owners-only "${STAGED[@]}")"
    while IFS= read -r owner; do
      [[ -n "$owner" ]] && CI_OWNERS+=("$owner")
    done <<< "$OWNER_OUTPUT"
    if [[ ${#CI_OWNERS[@]} -eq 0 ]]; then
      echo "precommit-vitest: ci_owned route omitted its required CI owners" >&2
      exit 2
    fi
    ;;
  *)
    echo "precommit-vitest: invalid staged route '$ROUTE'; expected precommit or ci_owned" >&2
    exit 2
    ;;
esac

if [[ "$ROUTE" == "ci_owned" ]]; then
  for target in "${CI_GUARDS[@]}"; do add_target "$target"; done
else
  for f in "${STAGED[@]}"; do
    case "$f" in
    packages/cli/package.json|packages/cli/vite.config.ts|packages/cli/vite.package.config.ts|packages/cli/vitest.shared.ts|packages/cli/scripts/verify-lane.mjs|packages/cli/test/sourceSetup.ts|packages/cli/test/helpers/sourceSubprocess.ts|references/analysis/verification-policy.yaml|scripts/precommit-vitest.sh)
      ;;
    .github/workflows/*|.lefthook.yml|protocol.yaml|registry.json)
      ;;
    packages/cli/src/*|packages/cli/test/*)
      case "$f" in
        packages/cli/test/packaging/*)
          ;;
        *.test.ts) add_target "${f#packages/cli/}" ;;
        packages/cli/src/registries/evaluatorHandoffContract.ts)
          add_target test/registries/evaluatorHandoffContract.test.ts
          ;;
        packages/cli/src/cli/todoMarkdown.ts)
          add_target test/cli/todoMarkdown.test.ts
          add_target test/cli/state.test.ts
          add_target test/cli/orientation.test.ts
          ;;
        packages/cli/test/cli/fixtures/oracle/invalid-input-envelope.json)
          add_target test/cli/invalidInputEnvelope.test.ts
          ;;
        packages/cli/test/cli/fixtures/oracle/npm-cli-surface.json)
          add_target test/cli/npmParityMatrix.test.ts
          ;;
        packages/cli/test/cli/fixtures/oracle/parity-remaining-families.json)
          add_target test/cli/npmParityMatrix.test.ts
          add_target test/cli/validateParity.test.ts
          add_target test/cli/compactParity.test.ts
          add_target test/cli/doctorUpgradeParity.test.ts
          add_target test/scripts/pyTsParity.test.ts
          ;;
        packages/cli/test/cli/fixtures/oracle/source-contract.json)
          add_target test/cli/sourceContractOracles.test.ts
          ;;
        packages/cli/test/cli/fixtures/oracle/validate-family.json)
          add_target test/cli/validateVerifyOracles.test.ts
          add_target test/cli/validateParity.test.ts
          ;;
        packages/cli/test/cli/fixtures/oracle/verify-eval-family.json)
          add_target test/cli/validateVerifyOracles.test.ts
          ;;
        packages/cli/test/cli/fixtures/oracle/inspektera-evaluation-report.json|packages/cli/test/cli/fixtures/citation-anchor-todo.md)
          add_target test/registries/evaluatorHandoffContract.test.ts
          ;;
        packages/cli/test/cli/fixtures/oracle/*)
          select_local_policy
          ;;
        packages/cli/src/*.ts)
          add_source_target "$f"
          ;;
        *) for smoke in "${SMOKE[@]}"; do add_target "$smoke"; done ;;
      esac
      ;;
    skills/*|references/*)
      ;;
    scripts/sandbox/*) for smoke in "${SMOKE[@]}"; do add_target "$smoke"; done ;;
    TODO.md|CHANGELOG.md|.agentera/*)
      for smoke in "${SMOKE[@]}"; do add_target "$smoke"; done
      ;;
    *)
      :
      ;;
    esac
  done
fi

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  for smoke in "${SMOKE[@]}"; do add_target "$smoke"; done
fi
mapfile -t TARGETS < <(printf '%s\n' "${TARGETS[@]}" | LC_ALL=C sort -u)

if [[ -n "$PRINT_ROUTE" ]]; then
  if [[ "$ROUTE" == "ci_owned" ]]; then
    echo run_ci_owned
    printf 'ci_owner %s\n' "${CI_OWNERS[@]}"
  else
    echo run_targeted
  fi
  echo worker_limit 2
  echo budget_ms 60000
  echo typecheck true
  if [[ -n "$PRINT_TARGETS" ]]; then printf 'target %s\n' "${TARGETS[@]}"; fi
  exit 0
fi

# Lefthook exports these paths for its own repository. Test fixtures create
# nested repositories, so their Git commands must discover those repositories
# rather than inherit the parent hook's index and worktree.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR

export VITEST_MAX_WORKERS=2
export AGENTERA_VERIFICATION_WORKERS=2

BUDGET_MS=60000
START_MS="$(date +%s%3N)"
if [[ ! "$START_MS" =~ ^[0-9]+$ ]]; then
  echo "precommit-vitest: monotonic budget clock returned invalid milliseconds" >&2
  exit 2
fi

run_budgeted() {
  local label="$1"
  shift
  local now elapsed remaining seconds status
  now="$(date +%s%3N)"
  if [[ ! "$now" =~ ^[0-9]+$ ]]; then
    echo "precommit-vitest: monotonic budget clock returned invalid milliseconds" >&2
    return 2
  fi
  elapsed=$((now - START_MS))
  remaining=$((BUDGET_MS - elapsed))
  if (( remaining <= 0 )); then
    echo "precommit-vitest: ${label} did not start because the ${BUDGET_MS}ms staged-source budget was exhausted" >&2
    return 1
  fi
  seconds=$(((remaining + 999) / 1000))
  if timeout --foreground "${seconds}s" "$@"; then
    return 0
  else
    status=$?
    if [[ $status -eq 124 || $status -eq 137 ]]; then
      echo "precommit-vitest: ${label} exceeded the ${BUDGET_MS}ms staged-source budget; fix or narrow the staged change" >&2
      return 1
    fi
    echo "precommit-vitest: ${label} failed with exit ${status}" >&2
    return 1
  fi
}

if [[ "$ROUTE" == "ci_owned" ]]; then
  printf 'precommit-vitest: %s remain authoritative in required CI; running local route guards only\n' "${CI_OWNERS[*]}" >&2
fi

printf 'precommit-vitest: running %s source-owned file(s) with two workers: %s\n' "${#TARGETS[@]}" "${TARGETS[*]}" >&2
run_budgeted "targeted source tests" node scripts/verify-lane.mjs policy precommit -- "${TARGETS[@]}"
run_budgeted "typecheck" pnpm run typecheck

END_MS="$(date +%s%3N)"
if [[ ! "$END_MS" =~ ^[0-9]+$ ]]; then
  echo "precommit-vitest: monotonic budget clock returned invalid milliseconds" >&2
  exit 2
fi
ELAPSED_MS=$((END_MS - START_MS))
if (( ELAPSED_MS > BUDGET_MS )); then
  echo "precommit-vitest: staged-source verification exceeded ${BUDGET_MS}ms (${ELAPSED_MS}ms)" >&2
  exit 1
fi
printf 'precommit-vitest: passed in %sms; authoritative CI owners were not executed locally\n' "$ELAPSED_MS" >&2
