#!/bin/sh
# Compatibility for the already-installed common hook. No Lefthook dependency,
# config parsing, or hook activation. Resolve policy from the invoking worktree.
if [ "$1" != "run" ] || [ "$2" != "pre-commit" ]; then
  echo "Legacy hook bridge supports only run pre-commit." >&2
  exit 1
fi
exec sh .vite-hooks/pre-commit
