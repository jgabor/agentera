#!/bin/bash
# Vehicle entrypoint. Runs inside the Docker container as the non-root
# `claude` user (uid 1000) before claude -p.
#
# Copies OAuth credentials from the read-only /creds bind mount into a
# writable $HOME/.claude so the claude CLI can rotate its own state files
# without clobbering host credentials.
set -euo pipefail

mkdir -p "$HOME/.claude"

if [ -f /creds/.credentials.json ]; then
    cp /creds/.credentials.json "$HOME/.claude/.credentials.json"
    chmod 600 "$HOME/.claude/.credentials.json"
fi

if [ -f /creds/.claude.json ]; then
    cp /creds/.claude.json "$HOME/.claude/.claude.json"
    chmod 600 "$HOME/.claude/.claude.json"
fi

# Optional: PROFILE.md mount for realism. Hej reads it as part of briefing.
if [ -d /profile ]; then
    mkdir -p "$HOME/.claude/profile"
    cp /profile/PROFILE.md "$HOME/.claude/profile/PROFILE.md" 2>/dev/null || true
fi

# Ensure the reads log exists so the hook's append doesn't race.
if [ -n "${BENCH_READS_LOG:-}" ]; then
    mkdir -p "$(dirname "$BENCH_READS_LOG")"
    : > "$BENCH_READS_LOG"
fi

exec "$@"
