#!/usr/bin/env python3
"""Parse a claude -p stream-json transcript and emit a token breakdown.

Reads one transcript file (JSON lines, one event per line) and sums
usage counters across every assistant message. Emits a JSON object with
the primary total plus the projections optimera uses in its breakdown
field (peak_context, output_total, cache_read_total, cache_create_total,
turns, cache_efficiency).

Supports pre-dispatch slicing via --slice-before-tool: when set, the
parser finds the first assistant message containing a tool_use whose
name is in the comma-separated list, and restricts one set of counters
to assistant messages strictly before that turn. The sliced counters
appear under the `pre_dispatch` key alongside the full-transcript
counters. Used by the realisera-token harness to compute the
pre-dispatch composite.

Stdlib-only. Used by the .optimera/harness orchestrator after each
condition run.

Usage:
    python3 parse_tokens.py <transcript.jsonl>
    python3 parse_tokens.py <transcript.jsonl> --slice-before-tool Task,Agent
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any


def load_events(path: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    with open(path) as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                events.append(json.loads(raw))
            except json.JSONDecodeError:
                continue
    return events


def find_dispatch_turn(
    assistant_events: list[dict[str, Any]], stop_tools: set[str]
) -> int | None:
    """Return the 0-based index (into assistant_events) of the first
    assistant message containing a tool_use whose name is in stop_tools.
    Returns None if no such message exists.
    """
    for idx, event in enumerate(assistant_events):
        message = event.get("message") or {}
        for block in (message.get("content") or []):
            if not isinstance(block, dict):
                continue
            if block.get("type") != "tool_use":
                continue
            name = str(block.get("name") or "").lower()
            if name in stop_tools:
                return idx
    return None


def compute_counters(assistant_events: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute token counters + peak context across a list of assistant events."""
    totals = {
        "input_tokens": 0,
        "cache_create_tokens": 0,
        "cache_read_tokens": 0,
        "output_tokens": 0,
    }
    peak_context = 0
    tool_use_count = 0

    for event in assistant_events:
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
        "turns": len(assistant_events),
        "tool_use_count": tool_use_count,
        "cache_efficiency": round(cache_efficiency, 4),
        **totals,
    }


def parse(path: str, stop_before_tools: list[str] | None = None) -> dict[str, Any]:
    events = load_events(path)
    assistant_events = [e for e in events if e.get("type") == "assistant"]

    full = compute_counters(assistant_events)
    result: dict[str, Any] = dict(full)

    if stop_before_tools:
        stop_set = {t.lower() for t in stop_before_tools}
        dispatch_idx = find_dispatch_turn(assistant_events, stop_set)
        if dispatch_idx is not None:
            pre_slice = assistant_events[:dispatch_idx]
            result["dispatch_turn_index"] = dispatch_idx
            result["dispatch_found"] = True
        else:
            pre_slice = assistant_events
            result["dispatch_turn_index"] = None
            result["dispatch_found"] = False

        pre = compute_counters(pre_slice)
        result["pre_dispatch"] = pre

    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="Parse claude -p stream-json transcript")
    ap.add_argument("transcript", help="Path to transcript.jsonl")
    ap.add_argument(
        "--slice-before-tool",
        default=None,
        help=(
            "Comma-separated tool names (e.g. Task,Agent). If set, compute "
            "pre-dispatch counters restricted to assistant messages strictly "
            "before the first matching tool_use. Sliced counters appear under "
            "the `pre_dispatch` key."
        ),
    )
    args = ap.parse_args()

    stop_tools: list[str] | None = None
    if args.slice_before_tool:
        stop_tools = [t.strip() for t in args.slice_before_tool.split(",") if t.strip()]

    result = parse(args.transcript, stop_before_tools=stop_tools)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
