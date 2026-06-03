#!/usr/bin/env bash
# Staged-aware pytest runner for lefthook pre-commit on main.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

STAGED=()
for arg in "$@"; do
  case "$arg" in
    /*) STAGED+=("${arg#"$ROOT"/}") ;;
    *) STAGED+=("$arg") ;;
  esac
done

SMOKE=(
  tests/test_query_cli.py::TestTodo::test_github_checkbox_before_type_tag_json
  tests/test_next_major_doctor.py
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
    .github/workflows/*|pyproject.toml|uv.lock)
      RUN_FULL=true
      ;;
    .lefthook.yml|scripts/precommit-pytest.sh)
      for smoke in "${SMOKE[@]}"; do add_target "$smoke"; done
      ;;
    scripts/agentera)
      for smoke in "${SMOKE[@]}"; do add_target "$smoke"; done
      ;;
    scripts/*.py)
      base="$(basename "$f" .py)"
      if [[ -f "tests/test_${base}.py" ]]; then
        add_target "tests/test_${base}.py"
      fi
      for smoke in "${SMOKE[@]}"; do add_target "$smoke"; done
      ;;
    tests/test_*.py)
      add_target "$f"
      ;;
    tests/*)
      RUN_FULL=true
      ;;
    hooks/*|references/*|skills/*)
      add_target tests/test_validate_md_items.py
      for smoke in "${SMOKE[@]}"; do add_target "$smoke"; done
      ;;
    *)
      :
      ;;
  esac
done

if [[ "$RUN_FULL" == true ]]; then
  exec uv run --with pytest --with pyyaml --with pytest-xdist pytest tests/ -q -n auto
fi

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  for smoke in "${SMOKE[@]}"; do add_target "$smoke"; done
fi

echo "precommit-pytest: running ${#TARGETS[@]} target(s)"
exec uv run --with pytest --with pyyaml pytest "${TARGETS[@]}" -q
