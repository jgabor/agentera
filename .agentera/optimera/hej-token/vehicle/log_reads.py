#!/usr/bin/env python3
"""PostToolUse hook that logs every Read tool invocation inside the vehicle.

Receives the Claude Code hook payload on stdin and appends one JSON-lines
record per read to the path in the BENCH_READS_LOG environment variable.
Runs inside the Docker container; stdlib-only so no pip install is needed.

The aggregator script on the host parses the log afterwards to rank which
artifacts dominate a session's token footprint.
"""
from __future__ import annotations

import json
import os
import sys


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    tool_input = payload.get("tool_input") or {}
    file_path = tool_input.get("file_path") or ""
    if not file_path:
        return 0

    try:
        size = os.path.getsize(file_path) if os.path.isfile(file_path) else 0
    except OSError:
        size = 0

    record = {
        "path": file_path,
        "bytes": size,
        "offset": tool_input.get("offset"),
        "limit": tool_input.get("limit"),
    }

    log_path = os.environ.get("BENCH_READS_LOG")
    if not log_path:
        return 0

    try:
        os.makedirs(os.path.dirname(log_path) or ".", exist_ok=True)
        with open(log_path, "a") as fh:
            fh.write(json.dumps(record) + "\n")
    except OSError:
        pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
