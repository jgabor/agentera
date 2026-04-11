#!/usr/bin/env python3
"""Parse a claude -p stream-json transcript and emit a token breakdown.

Reads one transcript file (JSON lines, one event per line) and sums
usage counters across every assistant message. Emits a JSON object with
the primary total plus the projections optimera uses in its breakdown
field (peak_context, output_total, cache_read_total, cache_create_total,
turns, cache_efficiency).

Stdlib-only. Used by the .optimera/harness orchestrator after each
condition run.

Usage:
    python3 parse_tokens.py <transcript.jsonl>
"""
from __future__ import annotations

import json
import sys
from typing import Any


def parse(path: str) -> dict[str, Any]:
    totals = {
        "input_tokens": 0,
        "cache_create_tokens": 0,
        "cache_read_tokens": 0,
        "output_tokens": 0,
    }
    peak_context = 0
    turn_count = 0
    tool_use_count = 0

    with open(path) as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if event.get("type") != "assistant":
                continue

            turn_count += 1
            message = event.get("message") or {}
            usage = message.get("usage") or {}

            totals["input_tokens"]        += usage.get("input_tokens", 0) or 0
            totals["cache_create_tokens"] += usage.get("cache_creation_input_tokens", 0) or 0
            totals["cache_read_tokens"]   += usage.get("cache_read_input_tokens", 0) or 0
            totals["output_tokens"]       += usage.get("output_tokens", 0) or 0

            ctx = (usage.get("cache_read_input_tokens", 0) or 0) + \
                  (usage.get("cache_creation_input_tokens", 0) or 0)
            if ctx > peak_context:
                peak_context = ctx

            for block in (message.get("content") or []):
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    tool_use_count += 1

    total = sum(totals.values())
    cache_denom = totals["cache_read_tokens"] + totals["cache_create_tokens"]
    cache_efficiency = (
        totals["cache_read_tokens"] / cache_denom if cache_denom > 0 else 0.0
    )

    return {
        "total": total,
        "peak_context": peak_context,
        "turns": turn_count,
        "tool_use_count": tool_use_count,
        "cache_efficiency": round(cache_efficiency, 4),
        **totals,
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: parse_tokens.py <transcript.jsonl>", file=sys.stderr)
        return 2

    result = parse(sys.argv[1])
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
