#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""CLI wrapper around hooks/compaction.compact_file.

Usage:
    python3 scripts/compact_artifact.py <spec-name> <path>

Spec names: progress, decisions, health, experiments, todo-resolved.

Prints a one-line status and exits 0 on success or no-change, 2 on
error (bad spec, missing file). Pure stdlib.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Allow running from the repo root without installing the package.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from hooks.compaction import SPECS, compact_file  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    """Parse args, invoke compact_file, print result."""
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 2:
        print(
            "usage: compact_artifact.py <spec-name> <path>",
            file=sys.stderr,
        )
        print(
            f"spec names: {', '.join(sorted(SPECS.keys()))}",
            file=sys.stderr,
        )
        return 2

    spec_name, raw_path = args
    if spec_name not in SPECS:
        print(
            f"error: unknown spec '{spec_name}'. "
            f"valid: {', '.join(sorted(SPECS.keys()))}",
            file=sys.stderr,
        )
        return 2

    path = Path(raw_path)
    if not path.exists():
        print(f"error: path does not exist: {path}", file=sys.stderr)
        return 2

    try:
        result = compact_file(path, spec_name)
    except (ValueError, FileNotFoundError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if result.changed:
        print(
            f"compacted: {path} "
            f"({result.full_before}->{result.full_after} full, "
            f"{result.oneline_before}->{result.oneline_after} oneline, "
            f"{result.dropped} dropped)"
        )
    else:
        print(
            f"no change: {path} "
            f"({result.full_before} full, {result.oneline_before} oneline, "
            f"under threshold)"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
