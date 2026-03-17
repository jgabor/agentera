"""Orchestrator that runs all extractors and writes combined output."""

import argparse
import json
import sys
import time
from pathlib import Path

from . import extract_configs, extract_conversations, extract_history, extract_memory


def main():
    parser = argparse.ArgumentParser(description="Run all profilera extractors")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path.home() / ".claude" / "profile" / "intermediate",
        help="Directory to write intermediate JSON files",
    )
    args = parser.parse_args()

    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    start = time.time()
    summary = {"timestamp": int(time.time() * 1000), "extractors": {}}

    # Run each extractor
    print("Extracting crystallized decisions (memory files, CLAUDE.md)...")
    stats = extract_memory.run(output_dir / "crystallized.json")
    summary["extractors"]["memory"] = stats
    print(f"  -> {stats['total']} entries")

    print("Extracting decision-rich history prompts...")
    stats = extract_history.run(output_dir / "history_decisions.json")
    summary["extractors"]["history"] = stats
    print(f"  -> {stats['total']} entries")

    print("Extracting conversation decision exchanges...")
    stats = extract_conversations.run(output_dir / "conversation_decisions.json")
    summary["extractors"]["conversations"] = stats
    print(f"  -> {stats['total_pairs']} pairs")

    print("Extracting project config patterns...")
    stats = extract_configs.run(output_dir / "project_configs.json")
    summary["extractors"]["configs"] = stats
    print(f"  -> {stats['total_configs']} configs")

    elapsed = time.time() - start
    summary["elapsed_seconds"] = round(elapsed, 1)

    # Write summary
    summary_path = output_dir / "extraction_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"\nDone in {elapsed:.1f}s. Summary written to {summary_path}")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
