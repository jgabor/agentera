#!/usr/bin/env python3
"""Apply causal and structural gates to a claude -p stream-json transcript.

The optimera brainstorm for the hej-token objective pre-registered two
gates that every experiment run must satisfy to be scoreable:

  causal:     hej actually fired. Either a Skill(hej) tool invocation
              appears in the transcript, OR the assistant output contains
              hej's signature markers (agentera logo, `─── status ───`,
              `─── attention ───`, `─── next ───`).

  structural: the final assistant message delivers a complete briefing:
              (a) a status-section marker, (b) at least one routing
              suggestion naming a known agentera skill, (c) non-trivial
              length (>= 50 words).

Both gates are deterministic; subtler quality regressions need manual
inspection of the transcript. This script emits a JSON report with a
pass/fail verdict and the individual signals, suitable for the harness
to fold into its final output.

Usage:
    python3 check_gates.py <transcript.jsonl>
"""
from __future__ import annotations

import json
import re
import sys
from typing import Any


SKILL_NAMES = [
    "visionera", "resonera", "inspirera", "planera", "realisera",
    "optimera", "inspektera", "dokumentera", "profilera", "visualisera",
    "orkestrera", "hej",
]

AGENTERA_LOGO_MARKERS = [
    "┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐",
    "├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤",
    "┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴",
]

STATUS_SECTION_MARKERS = [
    "─── status ───",
    "─── attention ───",
    "─── next ───",
    "─── ⎘ hej",
    "## status",
    "## attention",
]

ROUTING_PATTERN = re.compile(
    r"/(" + "|".join(SKILL_NAMES) + r")\b",
    re.IGNORECASE,
)


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
            # Marketplace invocations use the `<marketplace>:<skill>` form
            # (e.g. "agentera-hej:hej"); accept any suffix match after a
            # colon plus exact matches.
            suffix = raw.rsplit(":", 1)[-1] if ":" in raw else raw
            if suffix == target or raw == target:
                count += 1
    return count


def check(path: str) -> dict[str, Any]:
    events = load_events(path)
    text = collect_assistant_text(events)

    skill_invocations = count_skill_invocations(events, "hej")
    logo_present = any(marker in text for marker in AGENTERA_LOGO_MARKERS)
    status_present = any(marker in text.lower() or marker in text for marker in STATUS_SECTION_MARKERS)
    routing_match = ROUTING_PATTERN.search(text)
    word_count = len([w for w in text.split() if w.strip()])

    causal_pass = skill_invocations >= 1 or logo_present or status_present
    structural_pass = bool(status_present and routing_match and word_count >= 50)

    return {
        "causal_pass": causal_pass,
        "structural_pass": structural_pass,
        "both_pass": causal_pass and structural_pass,
        "signals": {
            "skill_invocations": skill_invocations,
            "logo_present": logo_present,
            "status_present": status_present,
            "routing_suggestion": routing_match.group(0) if routing_match else None,
            "word_count": word_count,
        },
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: check_gates.py <transcript.jsonl>", file=sys.stderr)
        return 2

    report = check(sys.argv[1])
    print(json.dumps(report))
    return 0 if report["both_pass"] else 0  # exit 0 regardless; harness decides


if __name__ == "__main__":
    sys.exit(main())
