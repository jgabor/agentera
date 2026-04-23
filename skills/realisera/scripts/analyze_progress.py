#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Parse PROGRESS.md and output structured analysis for realisera's Orient step.

Usage:
    python3 scripts/analyze_progress.py [--progress PATH] [--pretty]

Reads PROGRESS.md, outputs JSON with:
- Cycle count and date range
- Velocity (cycles per day)
- Work type distribution (feat/fix/docs/refactor/chore/test)
- Inspiration usage rate
- Issue discovery rate
- Recent cycle summaries
- Heuristic suggestions based on observed patterns
"""

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Optional

# SPEC Section 4 mandates `■ ## Cycle N · YYYY-MM-DD` with optional time and
# title suffix. The em-dash form is an older variant retained for back-compat.
HEADER_RE = re.compile(
    r"^(?:■\s*)?## Cycle (?P<num>\d+)\s*[·—]\s*(?P<date>\d{4}-\d{2}-\d{2})"
    r"(?:\s+(?P<time>\d{2}:\d{2}))?"
    r"(?:\s*[·—]\s*(?P<title>.+?))?\s*$",
    re.MULTILINE,
)

FIELD_SPECS = (
    ("What", "what"),
    ("Commit", "commit"),
    ("Inspiration", "inspiration"),
    ("Discovered", "discovered"),
    ("Next", "next"),
)

WORK_TYPE_RE = re.compile(
    r"(?:`[a-f0-9]+`\s+)?(feat|fix|docs|refactor|chore|test)"
)

EMPTY_MARKER_RE = re.compile(r"^(none|n/a|no|-|$)", re.IGNORECASE)


def _build_entry(match: re.Match, body: str) -> dict:
    num = int(match.group("num"))
    date_str = match.group("date")
    time_str = match.group("time")
    title = match.groupdict().get("title")

    entry: dict = {"number": num, "date": date_str, "time": time_str, "title": title}

    if time_str:
        try:
            entry["timestamp"] = datetime.strptime(
                f"{date_str} {time_str}", "%Y-%m-%d %H:%M"
            ).isoformat()
        except ValueError:
            entry["timestamp"] = None
    else:
        try:
            entry["timestamp"] = datetime.strptime(
                date_str, "%Y-%m-%d"
            ).isoformat()
        except ValueError:
            entry["timestamp"] = None

    for field, key in FIELD_SPECS:
        m = re.search(rf"\*\*{field}\*\*:\s*(.+?)(?:\n|$)", body)
        entry[key] = m.group(1).strip() if m else None

    # Work type lives in the commit line for the old format, in the header
    # title for the current format. Check commit first, then title.
    for source in (entry.get("commit") or "", title or ""):
        type_match = WORK_TYPE_RE.search(source)
        if type_match:
            entry["work_type"] = type_match.group(1)
            break
    else:
        entry["work_type"] = "unknown"

    insp = entry.get("inspiration") or ""
    entry["has_inspiration"] = bool(insp and not EMPTY_MARKER_RE.match(insp))

    disc = entry.get("discovered") or ""
    entry["has_discoveries"] = bool(disc and not EMPTY_MARKER_RE.match(disc))

    return entry


def parse_cycles(text: str) -> list[dict]:
    """Parse PROGRESS.md into structured cycle entries."""
    matches = list(HEADER_RE.finditer(text))
    cycles: list[dict] = []
    for i, m in enumerate(matches):
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        cycles.append(_build_entry(m, text[body_start:body_end]))
    return cycles


def _date_range_and_velocity(
    cycles: list[dict],
) -> tuple[Optional[dict], Optional[float]]:
    dates = []
    for c in cycles:
        try:
            dates.append(datetime.strptime(c["date"], "%Y-%m-%d"))
        except (ValueError, KeyError, TypeError):
            pass

    if not dates:
        return None, None

    first, last = min(dates), max(dates)
    span_days = (last - first).days or 1
    date_range = {
        "first": first.strftime("%Y-%m-%d"),
        "last": last.strftime("%Y-%m-%d"),
        "span_days": span_days,
    }
    velocity = (
        float(len(cycles)) if len(dates) == 1 else round(len(cycles) / span_days, 2)
    )
    return date_range, velocity


def _dominant_activity(type_counts: Counter) -> str:
    build = type_counts.get("feat", 0) + type_counts.get("docs", 0)
    fix = type_counts.get("fix", 0)
    maintain = (
        type_counts.get("refactor", 0)
        + type_counts.get("chore", 0)
        + type_counts.get("test", 0)
    )
    return max(
        [("building", build), ("fixing", fix), ("maintaining", maintain)],
        key=lambda x: x[1],
    )[0]


def _rate(cycles: list[dict], key: str) -> tuple[int, float]:
    count = sum(1 for c in cycles if c.get(key))
    return count, round(count / len(cycles), 3)


def _recent_summary(cycles: list[dict], n: int = 5) -> list[dict]:
    if len(cycles) > n and cycles[0]["number"] > cycles[-1]["number"]:
        selected = cycles[:n]
    else:
        selected = cycles[-n:]
    return [
        {
            "number": c["number"],
            "date": c["date"],
            "what": c.get("what"),
            "work_type": c.get("work_type"),
            "has_inspiration": c.get("has_inspiration"),
        }
        for c in selected
    ]


def _suggest_fix_heavy(
    total: int, fix_types: int, build_types: int
) -> Optional[str]:
    if total >= 5 and fix_types > build_types:
        return (
            "More cycles spent fixing than building. "
            "Consider stabilizing the codebase before adding features, "
            "or re-evaluate the vision to ensure new work aligns."
        )
    return None


def _suggest_low_inspiration(
    total: int, inspired: int, rate: float
) -> Optional[str]:
    if total >= 5 and rate < 0.2:
        return (
            f"Inspiration used in only {inspired}/{total} cycles. "
            "Consider running /inspirera to find external patterns worth adopting."
        )
    return None


def _suggest_high_inspiration(total: int, rate: float) -> Optional[str]:
    if total >= 5 and rate > 0.8:
        return (
            "Nearly every cycle draws on external inspiration. "
            "The project may benefit from more original design work grounded in its own vision."
        )
    return None


def _suggest_no_tests(total: int, type_counts: Counter) -> Optional[str]:
    if total >= 5 and type_counts.get("test", 0) == 0:
        return "No test-focused cycles yet. Consider dedicating a cycle to test coverage."
    return None


def _suggest_no_docs(total: int, type_counts: Counter) -> Optional[str]:
    if total >= 5 and type_counts.get("docs", 0) == 0:
        return "No docs-focused cycles yet. Documentation may be drifting from implementation."
    return None


def _build_suggestions(
    total: int,
    type_counts: Counter,
    inspired: int,
    inspiration_rate: float,
) -> list[str]:
    build_types = type_counts.get("feat", 0) + type_counts.get("docs", 0)
    fix_types = type_counts.get("fix", 0)
    candidates = [
        _suggest_fix_heavy(total, fix_types, build_types),
        _suggest_low_inspiration(total, inspired, inspiration_rate),
        _suggest_high_inspiration(total, inspiration_rate),
        _suggest_no_tests(total, type_counts),
        _suggest_no_docs(total, type_counts),
    ]
    return [s for s in candidates if s]


def analyze(cycles: list[dict]) -> dict:
    """Produce analysis from parsed cycles."""
    if not cycles:
        return {"total_cycles": 0, "message": "No cycles found in PROGRESS.md"}

    total = len(cycles)
    date_range, velocity = _date_range_and_velocity(cycles)
    type_counts = Counter(c.get("work_type", "unknown") for c in cycles)
    inspired, inspiration_rate = _rate(cycles, "has_inspiration")
    discovering, discovery_rate = _rate(cycles, "has_discoveries")

    result: dict = {
        "total_cycles": total,
        "date_range": date_range,
        "velocity_cycles_per_day": velocity,
        "work_distribution": dict(type_counts.most_common()),
        "dominant_activity": _dominant_activity(type_counts),
        "inspiration_rate": inspiration_rate,
        "inspired_cycles": inspired,
        "discovery_rate": discovery_rate,
        "discovering_cycles": discovering,
        "streak_length": total,
        "recent": _recent_summary(cycles),
    }

    suggestions = _build_suggestions(total, type_counts, inspired, inspiration_rate)
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
