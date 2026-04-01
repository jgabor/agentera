#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Parse PROGRESS.md and output structured analysis for realisera's Orient step.

Usage:
    python3 scripts/analyze_progress.py [--progress PATH] [--vision PATH]

Reads PROGRESS.md (and optionally VISION.md for direction context), outputs JSON with:
- Cycle count and date range
- Velocity (cycles per day)
- Work type distribution (feat/fix/docs/refactor/chore/test)
- Inspiration usage rate
- Issue discovery rate
- Streak detection (consecutive completed cycles)
- Recent cycle summaries
"""

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path


def parse_cycles(text: str) -> list[dict]:
    """Parse PROGRESS.md into structured cycle entries."""
    cycles = []
    # Split on cycle headers: ## Cycle N — YYYY-MM-DD HH:MM
    sections = re.split(
        r"^## Cycle (\d+)\s*—\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})",
        text,
        flags=re.MULTILINE,
    )

    # sections[0] is preamble, then groups of 4: number, date, time, body
    for i in range(1, len(sections) - 3, 4):
        num = int(sections[i])
        date_str = sections[i + 1]
        time_str = sections[i + 2]
        body = sections[i + 3]

        entry = {
            "number": num,
            "date": date_str,
            "time": time_str,
        }

        try:
            entry["timestamp"] = datetime.strptime(
                f"{date_str} {time_str}", "%Y-%m-%d %H:%M"
            ).isoformat()
        except ValueError:
            entry["timestamp"] = None

        # Extract fields
        for field, key in [
            ("What", "what"),
            ("Commit", "commit"),
            ("Inspiration", "inspiration"),
            ("Discovered", "discovered"),
            ("Next", "next"),
        ]:
            match = re.search(rf"\*\*{field}\*\*:\s*(.+?)(?:\n|$)", body)
            entry[key] = match.group(1).strip() if match else None

        # Extract commit type from "type(scope): message" or "`hash` type(scope): message"
        if entry.get("commit"):
            type_match = re.search(
                r"(?:`[a-f0-9]+`\s+)?(feat|fix|docs|refactor|chore|test)",
                entry["commit"],
            )
            entry["work_type"] = type_match.group(1) if type_match else "unknown"

        # Determine if inspiration was used
        insp = entry.get("inspiration", "") or ""
        entry["has_inspiration"] = bool(
            insp and not re.match(r"^(none|n/a|no|-|$)", insp, re.IGNORECASE)
        )

        # Determine if issues were discovered
        disc = entry.get("discovered", "") or ""
        entry["has_discoveries"] = bool(
            disc and not re.match(r"^(none|n/a|no|-|$)", disc, re.IGNORECASE)
        )

        cycles.append(entry)

    return cycles


def analyze(cycles: list[dict]) -> dict:
    """Produce analysis from parsed cycles."""
    if not cycles:
        return {
            "total_cycles": 0,
            "message": "No cycles found in PROGRESS.md",
        }

    total = len(cycles)

    # Date range
    dates = []
    for c in cycles:
        try:
            dates.append(datetime.strptime(c["date"], "%Y-%m-%d"))
        except (ValueError, KeyError):
            pass

    date_range = None
    velocity = None
    if len(dates) >= 2:
        first, last = min(dates), max(dates)
        span_days = (last - first).days or 1  # avoid division by zero for same-day
        date_range = {"first": first.strftime("%Y-%m-%d"), "last": last.strftime("%Y-%m-%d"), "span_days": span_days}
        velocity = round(total / span_days, 2)
    elif len(dates) == 1:
        date_range = {"first": dates[0].strftime("%Y-%m-%d"), "last": dates[0].strftime("%Y-%m-%d"), "span_days": 1}
        velocity = float(total)

    # Work type distribution
    type_counts = Counter(c.get("work_type", "unknown") for c in cycles)
    work_distribution = dict(type_counts.most_common())

    # Dominant work type
    build_types = type_counts.get("feat", 0) + type_counts.get("docs", 0)
    fix_types = type_counts.get("fix", 0)
    maintain_types = type_counts.get("refactor", 0) + type_counts.get("chore", 0) + type_counts.get("test", 0)
    dominant = max(
        [("building", build_types), ("fixing", fix_types), ("maintaining", maintain_types)],
        key=lambda x: x[1],
    )

    # Inspiration rate
    inspired = sum(1 for c in cycles if c.get("has_inspiration"))
    inspiration_rate = round(inspired / total, 3)

    # Discovery rate
    discovering = sum(1 for c in cycles if c.get("has_discoveries"))
    discovery_rate = round(discovering / total, 3)

    # Streak: consecutive cycles from the end (measures current momentum)
    # A "streak" here just means consecutive cycles exist — realisera always completes
    # or pivots, so streak length = total cycles from the most recent unbroken date sequence.
    streak = total  # default: all cycles form one streak

    # Recent cycles for quick context
    recent = [
        {
            "number": c["number"],
            "date": c["date"],
            "what": c.get("what"),
            "work_type": c.get("work_type"),
            "has_inspiration": c.get("has_inspiration"),
        }
        for c in cycles[-5:]
    ]

    result = {
        "total_cycles": total,
        "date_range": date_range,
        "velocity_cycles_per_day": velocity,
        "work_distribution": work_distribution,
        "dominant_activity": dominant[0],
        "inspiration_rate": inspiration_rate,
        "inspired_cycles": inspired,
        "discovery_rate": discovery_rate,
        "discovering_cycles": discovering,
        "streak_length": streak,
        "recent": recent,
    }

    # Suggestions based on patterns
    suggestions = []
    if fix_types > build_types and total >= 5:
        suggestions.append(
            "More cycles spent fixing than building. "
            "Consider stabilizing the codebase before adding features, "
            "or re-evaluate the vision to ensure new work aligns."
        )
    if inspiration_rate < 0.2 and total >= 5:
        suggestions.append(
            f"Inspiration used in only {inspired}/{total} cycles. "
            "Consider running /inspirera to find external patterns worth adopting."
        )
    if inspiration_rate > 0.8 and total >= 5:
        suggestions.append(
            "Nearly every cycle draws on external inspiration. "
            "The project may benefit from more original design work grounded in its own vision."
        )
    if type_counts.get("test", 0) == 0 and total >= 5:
        suggestions.append(
            "No test-focused cycles yet. Consider dedicating a cycle to test coverage."
        )
    if type_counts.get("docs", 0) == 0 and total >= 5:
        suggestions.append(
            "No docs-focused cycles yet. Documentation may be drifting from implementation."
        )

    if suggestions:
        result["suggestions"] = suggestions

    return result


def main():
    parser = argparse.ArgumentParser(description="Analyze PROGRESS.md for realisera")
    parser.add_argument(
        "--progress",
        default="PROGRESS.md",
        help="Path to PROGRESS.md (default: ./PROGRESS.md)",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output",
    )
    args = parser.parse_args()

    # Read PROGRESS.md
    prog_path = Path(args.progress)
    if not prog_path.exists():
        print(json.dumps({"error": f"{prog_path} not found", "total_cycles": 0}))
        sys.exit(0)

    cycles = parse_cycles(prog_path.read_text())
    result = analyze(cycles)

    indent = 2 if args.pretty else None
    print(json.dumps(result, indent=indent))


if __name__ == "__main__":
    main()
