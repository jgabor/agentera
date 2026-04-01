#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Parse EXPERIMENTS.md and output structured analysis for optimera's Orient step.

Usage:
    python3 scripts/analyze_experiments.py [--experiments PATH] [--objective PATH]

Reads EXPERIMENTS.md (and optionally OBJECTIVE.md for the target), outputs JSON with:
- Metric trajectory and trend
- Plateau detection
- Win/loss patterns
- Distance to target
- Suggested focus areas
"""

import argparse
import json
import re
import sys
from pathlib import Path


def parse_experiments(text: str) -> list[dict]:
    """Parse EXPERIMENTS.md into structured experiment entries."""
    experiments = []
    # Split on experiment headers: ## Experiment N — YYYY-MM-DD HH:MM
    sections = re.split(r"^## Experiment (\d+)", text, flags=re.MULTILINE)

    # sections[0] is preamble (before first experiment), then alternating: number, body
    for i in range(1, len(sections) - 1, 2):
        num = int(sections[i])
        body = sections[i + 1]

        entry = {"number": num}

        # Extract fields
        for field, key in [
            ("Hypothesis", "hypothesis"),
            ("Change", "change"),
            ("Metric", "metric_raw"),
            ("Regression", "regression"),
            ("Status", "status"),
            ("Commit", "commit"),
            ("Inspiration", "inspiration"),
            ("Next", "next"),
        ]:
            match = re.search(
                rf"\*\*{field}\*\*:\s*(.+?)(?:\n|$)", body
            )
            entry[key] = match.group(1).strip() if match else None

        # Parse metric values from "before → after (direction is better|worse|unchanged)"
        if entry.get("metric_raw"):
            metric_match = re.search(
                r"([\d.]+)\s*→\s*([\d.]+)", entry["metric_raw"]
            )
            if metric_match:
                entry["metric_before"] = float(metric_match.group(1))
                entry["metric_after"] = float(metric_match.group(2))
                entry["metric_delta"] = entry["metric_after"] - entry["metric_before"]

        # Normalize status
        if entry.get("status"):
            entry["status"] = entry["status"].lower().strip()

        experiments.append(entry)

    return experiments


def parse_target(text: str) -> dict | None:
    """Extract target value and direction from OBJECTIVE.md."""
    # Look for target patterns in the Objective section
    target = {}

    # Try to find direction hints
    if re.search(r"direction.*lower|reduce|decrease|minimize|lower", text, re.IGNORECASE):
        target["direction"] = "lower"
    elif re.search(r"direction.*higher|increase|maximize|higher|improve", text, re.IGNORECASE):
        target["direction"] = "higher"

    # Try to find a target number
    target_match = re.search(
        r"target[:\s]+.*?([\d.]+)", text, re.IGNORECASE
    )
    if target_match:
        target["value"] = float(target_match.group(1))

    return target if target else None


def analyze(experiments: list[dict], target: dict | None = None) -> dict:
    """Produce analysis from parsed experiments."""
    if not experiments:
        return {
            "total_experiments": 0,
            "message": "No experiments found in EXPERIMENTS.md",
        }

    total = len(experiments)
    kept = [e for e in experiments if e.get("status") == "kept"]
    discarded = [e for e in experiments if e.get("status") == "discarded"]
    errors = [e for e in experiments if e.get("status") == "error"]

    # Metric trajectory
    trajectory = []
    for e in experiments:
        if "metric_after" in e:
            trajectory.append(
                {"experiment": e["number"], "value": e["metric_after"], "status": e.get("status")}
            )

    # Current metric (last successful measurement)
    current_metric = None
    for e in reversed(experiments):
        if "metric_after" in e:
            current_metric = e["metric_after"]
            break

    # Best metric achieved
    best = None
    if trajectory:
        direction = target.get("direction") if target else None
        if direction == "lower":
            best = min(trajectory, key=lambda x: x["value"])
        elif direction == "higher":
            best = max(trajectory, key=lambda x: x["value"])
        else:
            # Infer from kept experiments
            if kept and "metric_delta" in kept[0]:
                if kept[0]["metric_delta"] > 0:
                    best = max(trajectory, key=lambda x: x["value"])
                else:
                    best = min(trajectory, key=lambda x: x["value"])

    # Plateau detection: last N experiments with no improvement
    plateau_length = 0
    for e in reversed(experiments):
        if e.get("status") == "kept":
            break
        plateau_length += 1

    # Win rate
    win_rate = len(kept) / total if total > 0 else 0

    # Distance to target
    distance = None
    if target and target.get("value") is not None and current_metric is not None:
        if target.get("direction") == "lower":
            distance = current_metric - target["value"]
        elif target.get("direction") == "higher":
            distance = target["value"] - current_metric

    result = {
        "total_experiments": total,
        "kept": len(kept),
        "discarded": len(discarded),
        "errors": len(errors),
        "win_rate": round(win_rate, 3),
        "current_metric": current_metric,
        "trajectory": trajectory,
        "plateau_length": plateau_length,
        "plateau_detected": plateau_length >= 3,
    }

    if best:
        result["best"] = best
    if distance is not None:
        result["distance_to_target"] = round(distance, 4)
        result["target"] = target["value"]
    if plateau_length >= 3:
        result["plateau_warning"] = (
            f"No improvement in the last {plateau_length} experiments. "
            "Consider a radically different approach or seeking external inspiration."
        )

    # Recent experiments for quick context
    result["recent"] = [
        {
            "number": e["number"],
            "hypothesis": e.get("hypothesis"),
            "status": e.get("status"),
            "metric_delta": e.get("metric_delta"),
        }
        for e in experiments[-5:]
    ]

    return result


def main():
    parser = argparse.ArgumentParser(description="Analyze EXPERIMENTS.md for optimera")
    parser.add_argument(
        "--experiments",
        default="EXPERIMENTS.md",
        help="Path to EXPERIMENTS.md (default: ./EXPERIMENTS.md)",
    )
    parser.add_argument(
        "--objective",
        default="OBJECTIVE.md",
        help="Path to OBJECTIVE.md (default: ./OBJECTIVE.md)",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output",
    )
    args = parser.parse_args()

    # Read EXPERIMENTS.md
    exp_path = Path(args.experiments)
    if not exp_path.exists():
        print(json.dumps({"error": f"{exp_path} not found", "total_experiments": 0}))
        sys.exit(0)

    experiments = parse_experiments(exp_path.read_text())

    # Read OBJECTIVE.md for target (optional)
    target = None
    obj_path = Path(args.objective)
    if obj_path.exists():
        target = parse_target(obj_path.read_text())

    result = analyze(experiments, target)

    indent = 2 if args.pretty else None
    print(json.dumps(result, indent=indent))


if __name__ == "__main__":
    main()
