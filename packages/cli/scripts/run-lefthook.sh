#!/bin/sh
# Git starts pre-commit at the current worktree root. The standalone launcher
# supplies managed Node to Lefthook and all its existing local-tool commands.
if ! command -v vp >/dev/null 2>&1; then
  echo "Hooks require standalone Vite+ 0.3 on Git's PATH. Restore launcher discovery, then run vp env on and vp install --frozen-lockfile." >&2
  exit 1
fi
if [ ! -x ./node_modules/.bin/lefthook ] || [ ! -x ./node_modules/.bin/vp ]; then
  echo "Hooks require this worktree's dependencies. Run vp env on, vp install --frozen-lockfile, then vp exec lefthook install." >&2
  exit 1
fi
exec vp exec lefthook "$@"
