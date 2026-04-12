#!/usr/bin/env python3
"""Aggregate the reads.jsonl log from a harness run into a ranked table.

The in-container PostToolUse hook (log_reads.py) emits one JSONL record
per Read tool invocation with the file path and size in bytes. This
script:

  - bins the reads into three classes: `.agentera/ artifact`, `hej skill
    asset`, `other` (source code, root files, etc.)
  - ranks the top-N contributors by total bytes consumed
  - computes a rough token estimate via bytes/4
  - emits a JSON object suitable for folding into the optimera harness
    breakdown field

This is the diagnostic signal the brainstorm demands: does the hej
session's footprint come from bloated `.agentera/` artifacts (source-
side problem for profilera/inspektera/realisera to solve) or from the
hej skill reading too much (consumer-side problem for hej to solve)?

Usage:
    python3 aggregate_reads.py <reads.jsonl> [top_n]
"""
from __future__ import annotations

import collections
import json
import os
import sys
from typing import Any


def classify(path: str) -> str:
    norm = os.path.normpath(path)
    if "/.agentera/" in norm or norm.endswith("/.agentera") or "/.agentera" in norm:
        return "agentera_artifact"
    if "/skills/realisera/" in norm or norm.endswith("/skills/realisera"):
        return "realisera_asset"
    if "/skills/hej/" in norm or norm.endswith("/skills/hej"):
        return "hej_asset"
    if ".claude/profile/" in norm:
        return "profile"
    basename = os.path.basename(norm)
    if basename in ("VISION.md", "TODO.md", "CHANGELOG.md", "README.md", "CLAUDE.md", "AGENTS.md"):
        return "root_artifact"
    return "other"


AVG_BYTES_PER_LINE = 80  # rough prose-markdown assumption for effective reads


def effective_bytes(record: dict[str, Any]) -> int:
    """Approximate how many bytes the Read tool actually returned.

    The raw file size is what the on-disk artifact weighs. If the tool call
    used `limit` or `offset`, the actual payload is smaller. We estimate
    min(file_size, limit * AVG_BYTES_PER_LINE) so the ranking reflects
    what the agent's context window actually absorbed, not just how fat
    the file happens to be.
    """
    size = record.get("bytes") or 0
    limit = record.get("limit")
    offset = record.get("offset") or 0
    if limit is None:
        # Full read (modulo offset, which is usually None).
        return max(0, size - offset * AVG_BYTES_PER_LINE)
    est = int(limit) * AVG_BYTES_PER_LINE
    return min(size, est)


def aggregate(reads_path: str, top_n: int = 10) -> dict[str, Any]:
    file_bytes: collections.Counter[str] = collections.Counter()       # raw on-disk size (last seen)
    effective_by_path: collections.Counter[str] = collections.Counter()  # estimated bytes delivered
    reads_by_path: collections.Counter[str] = collections.Counter()

    try:
        with open(reads_path) as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    record = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                path = record.get("path") or ""
                if not path:
                    continue
                file_bytes[path] = record.get("bytes") or 0
                effective_by_path[path] += effective_bytes(record)
                reads_by_path[path] += 1
    except FileNotFoundError:
        return {
            "total_reads": 0,
            "total_bytes": 0,
            "total_effective_bytes": 0,
            "total_token_est": 0,
            "by_class": {},
            "top_contributors": [],
        }

    total_raw_bytes = sum(file_bytes.values())
    total_effective_bytes = sum(effective_by_path.values())
    total_reads = sum(reads_by_path.values())

    by_class: dict[str, dict[str, int]] = {}
    for path, raw_size in file_bytes.items():
        cls = classify(path)
        bucket = by_class.setdefault(cls, {
            "bytes": 0,
            "effective_bytes": 0,
            "reads": 0,
            "files": 0,
            "token_est": 0,
        })
        bucket["bytes"] += raw_size
        bucket["effective_bytes"] += effective_by_path[path]
        bucket["reads"] += reads_by_path[path]
        bucket["files"] += 1
        bucket["token_est"] += effective_by_path[path] // 4

    top_contributors: list[dict[str, Any]] = []
    for path, eff_size in effective_by_path.most_common(top_n):
        top_contributors.append({
            "path": path,
            "bytes": file_bytes[path],
            "effective_bytes": eff_size,
            "reads": reads_by_path[path],
            "token_est": eff_size // 4,
            "class": classify(path),
        })

    return {
        "total_reads": total_reads,
        "total_bytes": total_raw_bytes,
        "total_effective_bytes": total_effective_bytes,
        "total_token_est": total_effective_bytes // 4,
        "by_class": by_class,
        "top_contributors": top_contributors,
    }


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: aggregate_reads.py <reads.jsonl> [top_n]", file=sys.stderr)
        return 2

    reads_path = sys.argv[1]
    top_n = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    result = aggregate(reads_path, top_n)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
