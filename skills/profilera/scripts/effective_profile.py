# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Compute effective confidence with dormancy decay for PROFILE.md entries.

Reads the decision profile, parses inline metadata, applies dormancy decay,
and outputs either a summary table (for consuming skills) or a prioritized
list of entries to validate (for profilera's Validate mode).

Usage:
    python3 scripts/effective_profile.py                  # summary table
    python3 scripts/effective_profile.py --validate       # entries to validate
    python3 scripts/effective_profile.py --profile PATH   # custom profile path
"""

import argparse
import json
import math
import re
import sys
from datetime import date, datetime
from pathlib import Path

PROFILE_PATH = Path.home() / ".claude" / "profile" / "PROFILE.md"

# Default decay lambdas per permanence class
DEFAULT_LAMBDAS = {
    "stable": 0.001,
    "durable": 0.005,
    "situational": 0.015,
    "unknown": 0.010,
}

# Half-lives in days (for staleness normalization in scoring)
HALF_LIVES = {
    "stable": 693,  # ~2 years
    "durable": 139,  # ~5 months
    "situational": 46,  # ~6 weeks
    "unknown": 69,  # ~2.5 months
}

CONFIDENCE_FLOOR = 20
VALIDATE_COUNT = 6

# Regex for the inline metadata line
METADATA_RE = re.compile(
    r"`conf:(?P<conf>[\d.]+)\s*\|\s*perm:(?P<perm>\w+)\s*\|"
    r"\s*first:(?P<first>[\d-]+)\s*\|\s*confirmed:(?P<confirmed>[\d-]+|—)\s*\|"
    r"\s*challenged:(?P<challenged>[\d-]+|—)`"
)

# Regex for decay parameters in the header comment
LAMBDA_RE = re.compile(r"(?P<perm>stable|durable|situational)\s+λ=(?P<val>[\d.]+)")

# Regex for entry heading (### Decision Name)
HEADING_RE = re.compile(r"^###\s+(.+)$", re.MULTILINE)


def parse_date(s: str) -> date | None:
    """Parse a YYYY-MM-DD date string, returning None for '—'."""
    if s == "—" or not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        return None


def parse_lambdas(text: str) -> dict[str, float]:
    """Extract decay lambdas from the PROFILE.md header comment."""
    lambdas = dict(DEFAULT_LAMBDAS)
    for match in LAMBDA_RE.finditer(text):
        lambdas[match.group("perm")] = float(match.group("val"))
    return lambdas


def parse_entries(text: str) -> list[dict]:
    """Parse all profile entries with their inline metadata."""
    entries = []
    headings = list(HEADING_RE.finditer(text))

    for i, heading in enumerate(headings):
        name = heading.group(1).strip()

        # Get the text between this heading and the next (or end of file)
        start = heading.end()
        end = headings[i + 1].start() if i + 1 < len(headings) else len(text)
        block = text[start:end]

        meta_match = METADATA_RE.search(block)
        if not meta_match:
            continue

        entries.append(
            {
                "name": name,
                "conf": float(meta_match.group("conf")),
                "perm": meta_match.group("perm"),
                "first": meta_match.group("first"),
                "confirmed": meta_match.group("confirmed"),
                "challenged": meta_match.group("challenged"),
            }
        )

    return entries


def compute_effective(entry: dict, lambdas: dict[str, float], today: date) -> dict:
    """Compute effective confidence after dormancy decay."""
    conf = entry["conf"]
    perm = entry["perm"]
    lam = lambdas.get(perm, lambdas.get("unknown", 0.010))

    # Use confirmed date if available, otherwise first date
    ref_date = parse_date(entry["confirmed"]) or parse_date(entry["first"])
    if ref_date is None:
        days_stale = 0
    else:
        days_stale = max(0, (today - ref_date).days)

    effective = max(CONFIDENCE_FLOOR, conf * math.exp(-lam * days_stale))

    return {
        **entry,
        "effective": round(effective, 2),
        "days_stale": days_stale,
        "decay_gap": round(conf - effective, 2),
    }


def score_for_validation(entry: dict) -> float:
    """Score an entry for validation priority. Higher = more worth validating."""
    conf = entry["conf"]
    effective = entry["effective"]
    perm = entry["perm"]

    # Decay gap: how much confidence was lost to decay (0-1)
    decay_gap = conf - effective

    # Staleness relative to permanence half-life (0-1, capped)
    half_life = HALF_LIVES.get(perm, HALF_LIVES["unknown"])
    staleness = min(1.0, entry["days_stale"] / half_life)

    # Has been challenged before
    has_tension = 1.0 if entry["challenged"] != "—" else 0.0

    # How far from center (extremes are more interesting)
    extremity = abs(effective - 50) / 50

    return 0.35 * decay_gap + 0.30 * staleness + 0.20 * has_tension + 0.15 * extremity


def format_summary_table(entries: list[dict]) -> str:
    """Format entries as a markdown summary table sorted by effective confidence."""
    sorted_entries = sorted(entries, key=lambda e: e["effective"], reverse=True)

    lines = [
        "| Entry | Conf | Eff | Perm | Stale? |",
        "|-------|------|-----|------|--------|",
    ]
    for e in sorted_entries:
        stale = "Yes" if e["decay_gap"] >= 5 else "No"
        lines.append(
            f"| {e['name']} | {e['conf']:.0f} | {e['effective']:.0f} "
            f"| {e['perm']} | {stale} |"
        )

    return "\n".join(lines)


def select_for_validation(entries: list[dict]) -> list[dict]:
    """Select the entries most worth validating, with scoring reasons."""
    scored = []
    for e in entries:
        score = score_for_validation(e)
        # Determine primary reason
        conf = e["conf"]
        effective = e["effective"]
        perm = e["perm"]
        half_life = HALF_LIVES.get(perm, HALF_LIVES["unknown"])

        reasons = []
        if conf - effective >= 10:
            reasons.append("significant decay gap")
        if e["days_stale"] >= half_life:
            reasons.append("stale relative to permanence")
        if e["challenged"] != "—":
            reasons.append("previously challenged")
        if effective >= 80:
            reasons.append("high confidence — worth periodic check")
        if effective <= 30:
            reasons.append("low confidence — confirm or drop")

        scored.append(
            {
                "name": e["name"],
                "conf": e["conf"],
                "effective": e["effective"],
                "perm": e["perm"],
                "confirmed": e["confirmed"],
                "challenged": e["challenged"],
                "days_stale": e["days_stale"],
                "score": round(score, 3),
                "reason": reasons[0] if reasons else "routine check",
            }
        )

    scored.sort(key=lambda e: e["score"], reverse=True)
    return scored[:VALIDATE_COUNT]


def main():
    parser = argparse.ArgumentParser(
        description="Compute effective confidence for decision profile entries"
    )
    parser.add_argument(
        "--profile",
        type=Path,
        default=PROFILE_PATH,
        help="Path to PROFILE.md",
    )
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Output entries to validate (JSON) instead of summary table",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output summary as JSON instead of markdown table",
    )
    args = parser.parse_args()

    if not args.profile.exists():
        print(f"Profile not found: {args.profile}", file=sys.stderr)
        sys.exit(1)

    text = args.profile.read_text(encoding="utf-8")
    lambdas = parse_lambdas(text)
    entries = parse_entries(text)

    if not entries:
        print("No entries with inline metadata found in profile.", file=sys.stderr)
        sys.exit(1)

    today = date.today()
    effective_entries = [compute_effective(e, lambdas, today) for e in entries]

    if args.validate:
        selected = select_for_validation(effective_entries)
        print(json.dumps(selected, indent=2))
    elif args.json:
        print(json.dumps(effective_entries, indent=2))
    else:
        print(format_summary_table(effective_entries))


if __name__ == "__main__":
    main()
