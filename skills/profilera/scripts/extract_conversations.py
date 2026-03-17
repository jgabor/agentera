"""Extract decision-rich exchanges from interactive conversation JSONL files."""

import json
import sys
from pathlib import Path

from . import utils

# Cap total output to ~2 MB of JSON
MAX_OUTPUT_BYTES = 2 * 1024 * 1024


def _process_conversation(jsonl_path: Path) -> list[dict]:
    """Extract decision-rich user-assistant pairs from a conversation file."""
    messages = []
    for entry in utils.parse_jsonl(jsonl_path):
        msg_type = entry.get("type")
        if msg_type not in ("user", "assistant"):
            continue
        messages.append(entry)

    # Count direct user text messages (not tool results)
    user_texts = [
        m
        for m in messages
        if m.get("type") == "user"
        and isinstance(m.get("message", {}).get("content"), str)
    ]

    # Skip non-interactive conversations
    if len(user_texts) < 5:
        return []

    # Extract decision-rich pairs
    pairs = []
    last_assistant_text = ""

    for msg in messages:
        if msg["type"] == "assistant":
            content = msg.get("message", {}).get("content", "")
            last_assistant_text = utils.truncate(utils.extract_text(content), 500)
        elif msg["type"] == "user":
            content = msg.get("message", {}).get("content")
            # Only process direct text input, not tool results
            if not isinstance(content, str):
                continue

            is_rich, signal_type = utils.is_decision_rich(content)
            if not is_rich:
                continue

            pairs.append(
                {
                    "timestamp": msg.get("timestamp"),
                    "session_id": msg.get("sessionId", ""),
                    "assistant_proposal": last_assistant_text,
                    "user_response": content,
                    "signal_type": signal_type,
                }
            )

    return pairs


def extract(projects_dir: Path | None = None) -> list[dict]:
    """Scan all project conversation files and extract decision-rich exchanges."""
    if projects_dir is None:
        projects_dir = utils.PROJECTS_DIR

    if not projects_dir.exists():
        return []

    results = []
    output_size = 0

    # Find all JSONL files under projects
    jsonl_files = sorted(projects_dir.glob("**/*.jsonl"))

    for jsonl_path in jsonl_files:
        # Skip very small files (likely just metadata)
        if jsonl_path.stat().st_size < 1024:
            continue

        project_dir = jsonl_path.parent
        # Walk up to find the project directory (direct child of projects_dir)
        while project_dir.parent != projects_dir and project_dir != projects_dir:
            project_dir = project_dir.parent
        project_name = utils.project_name_from_dir(project_dir.name)

        pairs = _process_conversation(jsonl_path)
        for pair in pairs:
            pair["project"] = project_name
            pair["source_file"] = str(jsonl_path)
            results.append(pair)

            # Rough size estimate
            output_size += len(pair.get("user_response", "")) + len(
                pair.get("assistant_proposal", "")
            )
            if output_size >= MAX_OUTPUT_BYTES:
                return results

    return results


def run(output_path: Path, projects_dir: Path | None = None) -> dict:
    """Run extraction and write results. Returns summary stats."""
    results = extract(projects_dir)

    output_path.write_text(
        json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # Stats
    by_project = {}
    by_type = {}
    for r in results:
        p = r.get("project", "unknown")
        by_project[p] = by_project.get(p, 0) + 1
        st = r["signal_type"]
        by_type[st] = by_type.get(st, 0) + 1

    return {
        "total_pairs": len(results),
        "files_scanned": len(list((projects_dir or utils.PROJECTS_DIR).glob("**/*.jsonl"))),
        "by_signal_type": by_type,
        "top_projects": dict(
            sorted(by_project.items(), key=lambda x: x[1], reverse=True)[:10]
        ),
    }


if __name__ == "__main__":
    out = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else Path("conversation_decisions.json")
    )
    stats = run(out)
    print(json.dumps(stats, indent=2))
