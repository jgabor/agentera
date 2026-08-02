#!/usr/bin/env bash
# Staged-aware vitest runner for lefthook pre-commit on feat/v3.
# Routes ordinary checks through the source lane. Package construction remains
# an explicit CI/release gate rather than making every commit package-heavy.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"

# Git hook invocations can export repository-local variables such as GIT_DIR
# and GIT_WORK_TREE. The test suite creates independent Git fixture
# repositories; letting those variables cross that boundary could redirect a
# fixture commit or config write into this checkout. Use Git's own complete
# list before launching any test subprocesses.
unset $(git rev-parse --local-env-vars)

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
)

RUN_POLICY=""
TARGETS=()

add_target() {
  local t="$1"
  [[ " ${TARGETS[*]} " == *" $t "* ]] || TARGETS+=("$t")
}

select_local_policy() {
  # The JavaScript authority may already have selected conservative release.
  # Ordinary-path routing can broaden targeted checks, but never downgrade it.
  [[ -n "$RUN_POLICY" ]] || RUN_POLICY=local
}

if [[ ${#STAGED[@]} -eq 0 ]]; then
  RUN_POLICY=local
fi

if [[ ${#STAGED[@]} -gt 0 ]]; then
  ROUTED_POLICY="$(node scripts/verify-lane.mjs route --policy-only "${STAGED[@]}")"
  if [[ "$ROUTED_POLICY" == release ]]; then RUN_POLICY=release; fi
fi

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
        *)
          select_local_policy
          ;;
      esac
      ;;
    skills/*|references/*)
      ;;
    scripts/sandbox/*)
      select_local_policy
      ;;
    TODO.md|CHANGELOG.md|.agentera/*)
      for smoke in "${SMOKE[@]}"; do add_target "$smoke"; done
      ;;
    *)
      :
      ;;
  esac
done

if [[ -n "$RUN_POLICY" ]]; then
  TARGETS=()
fi

# This opt-in points only to an external candidate directory. The read-only
# check recomputes the normalized source identity from the current working tree;
# the path itself is never authority.
REUSED_SOURCE_RECEIPT=""
if [[ "$RUN_POLICY" == release && -n "${AGENTERA_PRECOMMIT_SOURCE_CANDIDATE_DIR:-}" ]]; then
  if node scripts/release-qualification.mjs source-check \
    --candidate-dir "$AGENTERA_PRECOMMIT_SOURCE_CANDIDATE_DIR" --json >/dev/null 2>&1; then
    REUSED_SOURCE_RECEIPT=1
  else
    echo "precommit-vitest: source receipt is not reusable; running release policy" >&2
  fi
fi
unset AGENTERA_PRECOMMIT_SOURCE_CANDIDATE_DIR

if [[ -z "$RUN_POLICY" && ${#TARGETS[@]} -eq 0 ]]; then
  for smoke in "${SMOKE[@]}"; do add_target "$smoke"; done
fi

if [[ -n "${PRECOMMIT_VITEST_PRINT_ROUTE:-}" ]]; then
  if [[ -n "$REUSED_SOURCE_RECEIPT" ]]; then
    echo reuse_source_receipt
  elif [[ -n "$RUN_POLICY" ]]; then
    echo "run_policy $RUN_POLICY"
  else
    echo run_targeted
    if [[ -n "${PRECOMMIT_VITEST_PRINT_TARGETS:-}" ]]; then
      printf 'target %s\n' "${TARGETS[@]}"
    fi
  fi
  exit 0
fi

# Lefthook exports these paths for its own repository. Test fixtures create
# nested repositories, so their Git commands must discover those repositories
# rather than inherit the parent hook's index and worktree.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR

if [[ -n "$REUSED_SOURCE_RECEIPT" ]]; then
  echo "precommit-vitest: reused validated source evidence; running no source policy tests"
  exit 0
fi

if [[ -n "$RUN_POLICY" ]]; then
  exec node scripts/verify-lane.mjs policy "$RUN_POLICY"
fi

echo "precommit-vitest: running ${#TARGETS[@]} file(s): ${TARGETS[*]}"
exec node scripts/verify-lane.mjs policy precommit -- "${TARGETS[@]}"
