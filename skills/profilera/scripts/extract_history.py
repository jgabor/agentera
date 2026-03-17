"""Extract decision-rich prompts from history.jsonl."""

import json
import sys
from pathlib import Path

from . import utils


def extract(history_path: Path | None = None) -> list[dict]:
    """Filter history.jsonl for decision-rich prompts."""
    if history_path is None:
        history_path = utils.CLAUDE_DIR / "history.jsonl"

    if not history_path.exists():
        return []

    results = []
    for entry in utils.parse_jsonl(history_path):
        display = entry.get("display", "")
        if not display:
            continue

        is_rich, signal_type = utils.is_decision_rich(display)
        if not is_rich:
            continue

        project_path = entry.get("project", "")
        project = project_path.rstrip("/").rsplit("/", 1)[-1] if project_path else ""

        results.append(
            {
                "timestamp": entry.get("timestamp"),
                "project": project,
                "project_path": project_path,
                "prompt": display,
                "signal_type": signal_type,
                "session_id": entry.get("sessionId", ""),
            }
        )

    return results


def run(output_path: Path, history_path: Path | None = None) -> dict:
    """Run extraction and write results. Returns summary stats."""
    results = extract(history_path)

    output_path.write_text(
        json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # Count by signal type
    by_type = {}
    for r in results:
        st = r["signal_type"]
        by_type[st] = by_type.get(st, 0) + 1

    # Count by project
    by_project = {}
    for r in results:
        p = r["project"] or "unknown"
        by_project[p] = by_project.get(p, 0) + 1

    return {
        "total": len(results),
        "by_signal_type": by_type,
        "top_projects": dict(
            sorted(by_project.items(), key=lambda x: x[1], reverse=True)[:10]
        ),
    }


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("history_decisions.json")
    stats = run(out)
    print(json.dumps(stats, indent=2))
