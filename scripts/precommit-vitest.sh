#!/usr/bin/env bash
# Staged-aware vitest runner for lefthook pre-commit on feat/v3.
# Routes ordinary checks through the source lane. Package construction remains
# an explicit CI/release gate rather than making every commit package-heavy.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT/packages/cli"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "precommit-vitest: pnpm not found" >&2
  exit 1
fi

STAGED=()
for arg in "$@"; do
  case "$arg" in
    /*) STAGED+=("${arg#"$ROOT"/}") ;;
    *) STAGED+=("$arg") ;;
  esac
done

SMOKE=(
  test/registries/evaluatorHandoffContract.test.ts
  test/cli/inspekteraEvaluationReport.test.ts
)

RUN_FULL=false
TARGETS=()

add_target() {
  local t="$1"
  [[ " ${TARGETS[*]} " == *" $t "* ]] || TARGETS+=("$t")
}

if [[ ${#STAGED[@]} -eq 0 ]]; then
  RUN_FULL=true
fi

for f in "${STAGED[@]}"; do
  case "$f" in
    packages/cli/package.json|packages/cli/vite.config.ts|packages/cli/vite.package.config.ts|packages/cli/vitest.shared.ts|packages/cli/scripts/verify-lane.mjs|packages/cli/test/sourceSetup.ts|packages/cli/test/helpers/sourceSubprocess.ts|scripts/precommit-vitest.sh)
      add_target test/verification/laneOwnership.test.ts
      ;;
    .github/workflows/*|.lefthook.yml|protocol.yaml|registry.json)
      RUN_FULL=true
      ;;
    packages/cli/src/*|packages/cli/test/*)
      case "$f" in
        packages/cli/test/packaging/*)
          add_target test/verification/laneOwnership.test.ts
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
        packages/cli/test/cli/fixtures/oracle/*|packages/cli/test/cli/fixtures/citation-anchor-todo.md)
          add_target test/registries/evaluatorHandoffContract.test.ts
          add_target test/cli/inspekteraEvaluationReport.test.ts
          ;;
        *)
          RUN_FULL=true
          ;;
      esac
      ;;
    skills/*|references/*)
      RUN_FULL=true
      ;;
    scripts/sandbox/*)
      RUN_FULL=true
      ;;
    TODO.md|CHANGELOG.md|.agentera/*)
      for smoke in "${SMOKE[@]}"; do add_target "$smoke"; done
      ;;
    *)
      :
      ;;
  esac
done

if [[ "$RUN_FULL" != true && ${#TARGETS[@]} -eq 0 ]]; then
  for smoke in "${SMOKE[@]}"; do add_target "$smoke"; done
fi

if [[ -n "${PRECOMMIT_VITEST_PRINT_ROUTE:-}" ]]; then
  if [[ "$RUN_FULL" == true ]]; then
    echo run_full
  else
    echo run_targeted
    if [[ -n "${PRECOMMIT_VITEST_PRINT_TARGETS:-}" ]]; then
      printf 'target %s\n' "${TARGETS[@]}"
    fi
  fi
  exit 0
fi

if [[ "$RUN_FULL" == true ]]; then
  # full source suite → packages/cli#scripts.test
  exec pnpm test
fi

echo "precommit-vitest: running ${#TARGETS[@]} file(s): ${TARGETS[*]}"
exec vp test run --config vite.config.ts "${TARGETS[@]}"
