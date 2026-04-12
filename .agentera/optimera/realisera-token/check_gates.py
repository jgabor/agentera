#!/usr/bin/env python3
"""Apply causal and structural gates to a claude -p stream-json transcript
for the realisera-token optimera objective.

Two gates pre-registered in OBJECTIVE.md:

  causal:     realisera actually fired. Either a Skill(realisera) tool
              invocation appears, OR one of realisera's step markers
              appears in assistant text, OR a Task/Agent tool_use event
              proves that realisera reached step 5 (dispatch).

  structural: realisera reached Dispatch (step 5). Signals: a
              `── step 5/8:` marker in assistant text, OR at least one
              Task/Agent tool_use event (proves realisera attempted
              dispatch). Reaching step 5 is the pre-registered threshold
              because the pre-dispatch slice boundary is the first
              Task/Agent tool_use; if realisera never reaches that point,
              the slice is empty and the measurement is meaningless.

Both gates are deterministic. The additional composite floor check
(pre-dispatch composite >= 5000 tokens) is applied by the harness, not
this script, because it needs parse_tokens.py output with slicing.

Usage:
    python3 check_gates.py <transcript.jsonl>
"""
from __future__ import annotations

import json
import re
import sys
from typing import Any


REALISERA_STEP_MARKERS = [
    "─── ⧉ realisera",
    "── step 1/8",
    "── step 2/8",
    "── step 3/8",
    "── step 4/8",
    "── step 5/8",
    "── step 6/8",
    "── step 7/8",
    "── step 8/8",
]

STEP_5_MARKER_PATTERN = re.compile(r"──\s*step\s*5/8", re.IGNORECASE)

CANONICAL_ORIENT_ARTIFACTS = [
    "PROGRESS.md",
    "VISION.md",
    "TODO.md",
    "HEALTH.md",
    "DECISIONS.md",
]

DISPATCH_TOOL_NAMES = {"task", "agent"}


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


def collect_assistant_text(events: list[dict[str, Any]]) -> str:
    chunks: list[str] = []
    for event in events:
        if event.get("type") != "assistant":
            continue
        message = event.get("message") or {}
        for block in (message.get("content") or []):
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text") or ""
                if text:
                    chunks.append(text)
    return "\n".join(chunks)


def count_skill_invocations(events: list[dict[str, Any]], skill_name: str) -> int:
    count = 0
    target = skill_name.lower()
    for event in events:
        if event.get("type") != "assistant":
            continue
        message = event.get("message") or {}
        for block in (message.get("content") or []):
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            if block.get("name") != "Skill":
                continue
            inp = block.get("input") or {}
            raw = str(inp.get("skill", "")).lower()
            suffix = raw.rsplit(":", 1)[-1] if ":" in raw else raw
            if suffix == target or raw == target:
                count += 1
    return count


def count_dispatch_attempts(events: list[dict[str, Any]]) -> int:
    """Count tool_use events for Task or Agent (realisera's sub-agent
    dispatch). Proves realisera reached step 4."""
    count = 0
    for event in events:
        if event.get("type") != "assistant":
            continue
        message = event.get("message") or {}
        for block in (message.get("content") or []):
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            name = str(block.get("name") or "").lower()
            if name in DISPATCH_TOOL_NAMES:
                count += 1
    return count


def count_canonical_reads(events: list[dict[str, Any]]) -> dict[str, int]:
    """Count Read tool_use events per canonical Orient artifact."""
    counts: dict[str, int] = {name: 0 for name in CANONICAL_ORIENT_ARTIFACTS}
    for event in events:
        if event.get("type") != "assistant":
            continue
        message = event.get("message") or {}
        for block in (message.get("content") or []):
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            if block.get("name") != "Read":
                continue
            inp = block.get("input") or {}
            path = str(inp.get("file_path", "") or inp.get("path", ""))
            for artifact in CANONICAL_ORIENT_ARTIFACTS:
                if path.endswith("/" + artifact) or path == artifact or path.endswith(artifact):
                    counts[artifact] += 1
                    break
    return counts


def check(path: str) -> dict[str, Any]:
    events = load_events(path)
    text = collect_assistant_text(events)

    skill_invocations = count_skill_invocations(events, "realisera")
    step_markers_present = any(marker in text for marker in REALISERA_STEP_MARKERS)
    dispatch_attempts = count_dispatch_attempts(events)
    step_5_present = bool(STEP_5_MARKER_PATTERN.search(text))
    canonical_reads = count_canonical_reads(events)
    distinct_canonical_reads = sum(1 for c in canonical_reads.values() if c > 0)

    causal_pass = (
        skill_invocations >= 1
        or step_markers_present
        or dispatch_attempts >= 1
    )

    # Structural gate: realisera reached step 5 (dispatch). Either the
    # step marker appears in assistant text, or a Task/Agent tool_use
    # event is present (direct evidence of attempted dispatch).
    structural_pass = (
        step_5_present
        or dispatch_attempts >= 1
    )

    return {
        "causal_pass": causal_pass,
        "structural_pass": structural_pass,
        "both_pass": causal_pass and structural_pass,
        "signals": {
            "skill_invocations": skill_invocations,
            "step_markers_present": step_markers_present,
            "dispatch_attempts": dispatch_attempts,
            "step_5_marker_present": step_5_present,
            "canonical_reads": canonical_reads,
            "distinct_canonical_reads": distinct_canonical_reads,
        },
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: check_gates.py <transcript.jsonl>", file=sys.stderr)
        return 2

    report = check(sys.argv[1])
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
