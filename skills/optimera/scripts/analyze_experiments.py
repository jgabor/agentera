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


def _number(value: str) -> float:
    return float(value.replace(",", ""))


def _unit(text: str) -> str | None:
    match = re.search(r"[\d,]+(?:\.\d+)?\s*([A-Za-z][A-Za-z /_-]*)", text)
    return match.group(1).strip().lower() if match else None


def _excerpt(line: str) -> str:
    return re.sub(r"\s+", " ", line.replace("**", "").strip())


def normalize_status(value: str | None) -> tuple[str | None, str | None]:
    """Normalize rich status prose into analyzer status buckets."""
    if not value:
        return None, "missing status"

    status = value.lower().strip()
    if status.startswith("▨") or "baseline recorded" in status or "reference point" in status:
        return "baseline", None
    if "discard" in status:
        return "discarded", None
    if "kept" in status or "keep" in status:
        return "kept", None
    if "error" in status or "failed" in status or "failure" in status:
        return "error", None

    return "unknown", f"unknown status: {value}"


def _metric_from_table(body: str) -> dict:
    header = []
    for line in body.splitlines():
        if "|" not in line:
            continue
        if re.fullmatch(r"[|:\-\s]+", line.strip()):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if not cells or not re.search(r"primary|metric|total", cells[0], re.IGNORECASE):
            header = cells
            continue

        values = []
        for index, cell in enumerate(cells[1:]):
            match = re.search(r"[+-]?[\d,]+(?:\.\d+)?", cell)
            if match:
                label = header[index + 1] if index + 1 < len(header) else ""
                values.append((label.lower(), _number(match.group(0))))

        if len(values) >= 2:
            non_delta = [value for label, value in values if "delta" not in label]
            delta = [value for label, value in values if "delta" in label]
            metric = {"metric_before": non_delta[0], "metric_after": non_delta[-1]}
            metric["metric_delta"] = delta[-1] if delta else non_delta[-1] - non_delta[0]
            return metric

    return {}


def parse_metric_values(entry: dict, body: str) -> None:
    """Extract before/after/current/delta values from prose and simple tables."""
    raw = entry.get("metric_raw") or ""
    metric = _metric_from_table(body)

    arrow_match = re.search(
        r"([+-]?[\d,]+(?:\.\d+)?)\s*(?:[A-Za-z][A-Za-z /_-]*)?\s*(?:→|->)\s*([+-]?[\d,]+(?:\.\d+)?)",
        raw,
    )
    if arrow_match:
        metric["metric_before"] = _number(arrow_match.group(1))
        metric["metric_after"] = _number(arrow_match.group(2))
        metric.setdefault("metric_delta", metric["metric_after"] - metric["metric_before"])

    single_match = None
    if not arrow_match:
        single_match = re.search(r"\*\*([+-]?[\d,]+(?:\.\d+)?)\s*([^*\n]*)\*\*", raw)
        if not single_match:
            single_match = re.search(r"([+-]?[\d,]+(?:\.\d+)?)\s*([A-Za-z][A-Za-z /_-]*)?", raw)
    if single_match:
        metric["metric_current"] = _number(single_match.group(1))
        if single_match.lastindex and single_match.lastindex >= 2:
            unit = _unit(single_match.group(0))
            if unit:
                metric["metric_unit"] = unit

    baseline = entry.get("baseline")
    if baseline and "metric_before" not in metric:
        baseline_match = re.search(r"([+-]?[\d,]+(?:\.\d+)?)", baseline)
        if baseline_match:
            metric["metric_before"] = _number(baseline_match.group(1))

    delta = entry.get("delta")
    if delta and "metric_delta" not in metric:
        delta_match = re.search(r"([+-][\d,]+(?:\.\d+)?)", delta)
        if delta_match:
            metric["metric_delta"] = _number(delta_match.group(1))

    if "metric_after" not in metric and "metric_current" in metric:
        metric["metric_after"] = metric["metric_current"]
    if "metric_current" not in metric and "metric_after" in metric:
        metric["metric_current"] = metric["metric_after"]
    if "metric_delta" not in metric and {"metric_before", "metric_after"} <= metric.keys():
        metric["metric_delta"] = metric["metric_after"] - metric["metric_before"]
    if "metric_unit" not in metric and raw:
        unit = _unit(raw)
        if unit:
            metric["metric_unit"] = unit

    entry.update(metric)


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
            ("Baseline", "baseline"),
            ("Delta", "delta"),
            ("Regression", "regression"),
            ("Status", "status"),
            ("Commit", "commit"),
            ("Inspiration", "inspiration"),
            ("Next", "next"),
        ]:
            match = re.search(
                rf"\*\*{field}\*\*(?:\s*\([^\n]*?\))?:\s*(.+?)(?:\n|$)", body
            )
            entry[key] = match.group(1).strip() if match else None

        diagnostics = []
        status, status_diagnostic = normalize_status(entry.get("status"))
        entry["status"] = status
        if status_diagnostic:
            diagnostics.append(status_diagnostic)

        parse_metric_values(entry, body)
        if entry.get("metric_raw") and "metric_current" not in entry:
            diagnostics.append("metric value not found")
        if diagnostics:
            entry["diagnostics"] = diagnostics

        experiments.append(entry)

    return experiments


def parse_target(text: str) -> dict | None:
    """Extract target value and direction from OBJECTIVE.md."""
    target = {}
    diagnostics = []
    target_lines = [
        line
        for line in text.splitlines()
        if re.search(
            r"target|goal|reduce|decrease|increase|improve",
            line,
            re.IGNORECASE,
        )
        and not line.lstrip().startswith("#")
    ]
    metric_lines = [
        line for line in text.splitlines() if re.search(r"baseline|metric", line, re.IGNORECASE)
    ]

    if target_lines:
        target["context"] = _excerpt(target_lines[0])
    else:
        diagnostics.append("objective target context not found")

    if re.search(
        r"direction\s*:\s*lower|lower is better|reduce|decrease|minimi[sz]e|lower",
        text,
        re.IGNORECASE,
    ):
        target["direction"] = "lower"
    elif re.search(
        r"direction\s*:\s*higher|higher is better|increase|maximi[sz]e|higher|improve",
        text,
        re.IGNORECASE,
    ):
        target["direction"] = "higher"
    else:
        diagnostics.append("objective target direction not found")

    target_text = "\n".join(target_lines)
    target_match = re.search(
        r"(?:<=|>=|=|below|above|under|over)\s*([\d,]+(?:\.\d+)?)",
        target_text,
        re.IGNORECASE,
    )
    if not target_match:
        target_match = re.search(
            r"target[^\n\d]*(?:of|is|at|:)\s*([\d,]+(?:\.\d+)?)",
            target_text,
            re.IGNORECASE,
        )
    if target_match:
        target["value"] = _number(target_match.group(1))
    else:
        percent_match = re.search(
            r"(?:by|target)\s+\**([\d,]+(?:\.\d+)?)\s*%",
            target_text,
            re.IGNORECASE,
        )
        baseline_match = re.search(
            r"([\d,]+(?:\.\d+)?)\s*(?:to|→|->)\s*[\d,]+(?:\.\d+)?",
            "\n".join(metric_lines),
        )
        if percent_match and baseline_match and target.get("direction") in {"lower", "higher"}:
            baseline = _number(baseline_match.group(1))
            percent = _number(percent_match.group(1)) / 100
            multiplier = 1 - percent if target["direction"] == "lower" else 1 + percent
            target["value"] = round(baseline * multiplier, 4)

    if "value" not in target:
        diagnostics.append("objective target value not found")
    if diagnostics:
        target["diagnostics"] = diagnostics

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
    diagnostics = [
        {"experiment": e.get("number"), "message": message}
        for e in experiments
        for message in e.get("diagnostics", [])
    ]
    if target:
        diagnostics.extend(
            {"experiment": None, "message": message}
            for message in target.get("diagnostics", [])
        )

    # Metric trajectory
    trajectory = []
    for e in experiments:
        if "metric_current" in e:
            trajectory.append(
                {"experiment": e["number"], "value": e["metric_current"], "status": e.get("status")}
            )

    # Current metric (last successful measurement)
    current_metric = None
    for e in reversed(experiments):
        if "metric_current" in e:
            current_metric = e["metric_current"]
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
        result["target_met"] = distance <= 0
    if target and target.get("value") is not None and target.get("direction"):
        result["target_direction"] = target["direction"]
    if target and target.get("value") is not None and target.get("context"):
        result["target_context"] = target["context"]
    if plateau_length >= 3:
        result["plateau_warning"] = (
            f"No improvement in the last {plateau_length} experiments. "
            "Consider a radically different approach or seeking external inspiration."
        )
    if diagnostics:
        result["diagnostics"] = diagnostics

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


def _improvement(experiment: dict, direction: str | None) -> float | None:
    if "metric_before" not in experiment or "metric_after" not in experiment:
        return None
    if direction == "higher":
        return experiment["metric_after"] - experiment["metric_before"]
    if direction == "lower":
        return experiment["metric_before"] - experiment["metric_after"]
    if "metric_delta" in experiment:
        return -experiment["metric_delta"]
    return None


def frontier_report(experiments: list[dict], analysis: dict, target: dict | None = None) -> str:
    """Render a Markdown frontier report without changing default JSON analysis."""
    direction = target.get("direction") if target else analysis.get("target_direction")
    unit = next((e.get("metric_unit") for e in experiments if e.get("metric_unit")), "units")
    lines = ["# Frontier Report", ""]

    lines.extend(
        [
            f"- Experiments: {analysis.get('total_experiments', 0)}",
            f"- Kept: {analysis.get('kept', 0)}",
            f"- Discarded: {analysis.get('discarded', 0)}",
            f"- Keep rate: {analysis.get('win_rate', 0):.1%}",
        ]
    )

    best = analysis.get("best")
    if best:
        lines.append(f"- Best metric: {best['value']:g} at Experiment {best['experiment']}")
    if "target_met" in analysis:
        status = "met" if analysis["target_met"] else "not met"
        lines.append(f"- Target: {status}")
    if direction:
        lines.append(f"- Direction: {direction}")

    ranked = []
    for experiment in experiments:
        if experiment.get("status") == "baseline":
            continue
        improvement = _improvement(experiment, direction)
        if improvement is None:
            continue
        ranked.append((improvement, experiment["number"], experiment))
    ranked.sort(key=lambda item: (-item[0], item[1]))

    lines.extend(["", "## Top Improvements", ""])
    if not ranked:
        lines.append("No comparable metric deltas found.")
    else:
        for improvement, _, experiment in ranked[:5]:
            hypothesis = experiment.get("hypothesis") or "Untitled experiment"
            lines.append(
                f"- Experiment {experiment['number']}: {improvement:g} {unit} improvement "
                f"({experiment.get('status') or 'unknown'}) - {hypothesis}"
            )

    if analysis.get("plateau_detected"):
        lines.extend(["", "## Plateau", "", analysis["plateau_warning"]])
    if analysis.get("diagnostics"):
        lines.extend(["", "## Diagnostics", ""])
        for diagnostic in analysis["diagnostics"]:
            experiment = diagnostic.get("experiment")
            prefix = f"Experiment {experiment}" if experiment is not None else "Objective"
            lines.append(f"- {prefix}: {diagnostic['message']}")

    return "\n".join(lines) + "\n"


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
    parser.add_argument(
        "--frontier",
        action="store_true",
        help="Print a Markdown frontier report instead of JSON",
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

    if args.frontier:
        print(frontier_report(experiments, result, target), end="")
        return

    indent = 2 if args.pretty else None
    print(json.dumps(result, indent=indent))


if __name__ == "__main__":
    main()
