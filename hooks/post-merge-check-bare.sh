#!/usr/bin/env bash
# Guard against worktrunk merge/remove leaving core.bare=true on the main checkout.
# Wired via lefthook post-merge (fires after git merge, including wt merge fast-forwards).
set -euo pipefail

# Use git-common-dir so this still works when core.bare=true has already broken
# show-toplevel (the failure mode we are recovering from).
common_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"
if [[ -z "${common_dir}" ]]; then
  exit 0
fi

bare="$(git --git-dir="${common_dir}" config --bool core.bare 2>/dev/null || echo false)"
if [[ "${bare}" == "true" ]]; then
  echo "post-merge-check-bare: core.bare=true; resetting to false in ${common_dir}" >&2
  git --git-dir="${common_dir}" config core.bare false
fi
