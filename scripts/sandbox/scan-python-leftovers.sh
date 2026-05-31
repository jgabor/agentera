#!/usr/bin/env bash
# Scan sandbox tree for forbidden Python-managed Agentera references.
set -euo pipefail

ROOT="${1:-}"
if [[ -z "$ROOT" || ! -d "$ROOT" ]]; then
  echo "usage: scan-python-leftovers.sh <sandbox-root>" >&2
  exit 2
fi

PATTERNS=(
  'validate_artifact\.py'
  'cursor_session_start\.py'
  'cursor_pre_tool_use\.py'
  'cursor_session_stop\.py'
  '/app/scripts/agentera'
  'uv run.*scripts/agentera'
)

hits=0
while IFS= read -r file; do
  case "$file" in
    *.json|*.toml|*.js|*.md|*.yaml|*.yml|*.sh) ;;
    *) continue ;;
  esac
  for pattern in "${PATTERNS[@]}"; do
    if grep -qE "$pattern" "$file" 2>/dev/null; then
      echo "leftover: $file matches /$pattern/"
      hits=$((hits + 1))
    fi
  done
done < <(find "$ROOT" -type f \
  ! -path '*/fixtures/*' \
  ! -path '*/node_modules/*' \
  ! -path '*/app/skills/*' \
  ! -path '*/app/scripts/agentera' \
  ! -path '*/backup/*' \
  ! -name 'notes.txt')

if [[ "$hits" -gt 0 ]]; then
  exit 1
fi

echo "scan-python-leftovers: ok"
