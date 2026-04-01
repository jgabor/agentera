#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Run all profilera extractors and write combined output.

Scans Claude Code session data — memory files, history, conversations, and project
configs — to extract decision-rich signals for building a decision profile.

Usage:
    python3 extract_all.py --output-dir ~/.claude/profile/intermediate
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Generator

# ---------------------------------------------------------------------------
# Shared constants and utilities (from utils.py)
# ---------------------------------------------------------------------------

CLAUDE_DIR = Path.home() / ".claude"
PROJECTS_DIR = CLAUDE_DIR / "projects"
GIT_DIR = Path(os.environ.get("PROFILERA_GIT_DIR", Path.home() / "git"))

DECISION_PATTERNS = [
    r"\bshould\s+(we|i|it)\b",
    r"\bprefer\b",
    r"\binstead\b",
    r"\brather\b",
    r"\bvs\.?\s",
    r"\bbetter\s+(approach|way|option)\b",
    r"\brecommend\b",
    r"\bor\s+should\b",
    r"\bwhich\s+(is|one|way|do)\b",
    r"\btrade.?off\b",
    r"\bpros\s+and\s+cons\b",
]

CORRECTION_PATTERNS = [
    r"\bdon'?t\b",
    r"\bnot\s+that\b",
    r"\bactually[,\s]",
    r"\bwait[,\s]",
    r"\bwrong\b",
    r"\bshould\s+be\b",
    r"\blet'?s?\s+not\b",
    r"\bno,\s",
    r"\bstop\b",
    r"\bnever\b",
    r"\bavoid\b",
]

_decision_re = re.compile("|".join(DECISION_PATTERNS), re.IGNORECASE)
_correction_re = re.compile("|".join(CORRECTION_PATTERNS), re.IGNORECASE)


def is_decision_rich(text: str) -> tuple[bool, str]:
    """Check if text contains decision signals. Returns (is_rich, signal_type)."""
    if not text or len(text) < 15:
        return False, ""
    if _decision_re.search(text):
        return True, "decision"
    if _correction_re.search(text):
        return True, "correction"
    if len(text) > 80 and "?" in text:
        return True, "question"
    return False, ""


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Extract YAML frontmatter and body from markdown text."""
    if not text.startswith("---"):
        return {}, text

    end = text.find("---", 3)
    if end == -1:
        return {}, text

    raw = text[3:end].strip()
    body = text[end + 3 :].strip()

    frontmatter: dict[str, str] = {}
    current_key: str | None = None
    current_value_lines: list[str] = []

    for line in raw.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        if ":" in stripped and not stripped.startswith("-"):
            if current_key:
                frontmatter[current_key] = " ".join(current_value_lines).strip()
            key, _, value = stripped.partition(":")
            current_key = key.strip()
            value = value.strip()
            if value == ">" or value == "|":
                current_value_lines = []
            else:
                current_value_lines = [value] if value else []
        elif current_key:
            current_value_lines.append(stripped)

    if current_key:
        frontmatter[current_key] = " ".join(current_value_lines).strip()

    return frontmatter, body


def parse_jsonl(path: Path) -> Generator[dict, None, None]:
    """Stream JSONL file, yielding parsed dicts. Skips malformed lines."""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def extract_text(content) -> str:
    """Extract text from a message content field (string or array of content blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                texts.append(block.get("text", ""))
        return "\n".join(texts)
    return ""


def project_name_from_dir(dirname: str) -> str:
    """Extract readable project name from Claude projects directory name.

    The directory name encodes the filesystem path with '/' replaced by '-'.
    e.g., '-home-jgabor-git-lira' -> 'lira'
          '-home-jgabor-git-jg-go' -> 'jg-go'
          '-home-jgabor--claude' -> '.claude'
    """
    prefixes = [
        "-home-jgabor-git-",
        "-home-jgabor-",
    ]
    for prefix in prefixes:
        if dirname.startswith(prefix):
            remainder = dirname[len(prefix) :]
            if remainder:
                if remainder.startswith("-"):
                    return "." + remainder[1:]
                return remainder
    return dirname


def truncate(text: str, max_len: int = 500) -> str:
    """Truncate text to max_len, adding ellipsis if truncated."""
    if len(text) <= max_len:
        return text
    return text[:max_len] + "..."


# ---------------------------------------------------------------------------
# Extract: memory files and CLAUDE.md (from extract_memory.py)
# ---------------------------------------------------------------------------


def extract_memory_files() -> list[dict]:
    """Read all memory .md files across projects (excluding MEMORY.md index files)."""
    results = []
    for md in sorted(PROJECTS_DIR.glob("*/memory/*.md")):
        if md.name == "MEMORY.md":
            continue
        project = project_name_from_dir(md.parent.parent.name)
        text = md.read_text(encoding="utf-8", errors="replace")
        fm, body = parse_frontmatter(text)
        results.append(
            {
                "source": str(md),
                "project": project,
                "type": fm.get("type", "unknown"),
                "name": fm.get("name", md.stem),
                "description": fm.get("description", ""),
                "content": body,
            }
        )
    return results


def extract_claude_md_files() -> list[dict]:
    """Read CLAUDE.md and AGENTS.md from git projects and global config."""
    results = []

    global_claude = CLAUDE_DIR / "CLAUDE.md"
    if global_claude.exists():
        text = global_claude.read_text(encoding="utf-8", errors="replace")
        results.append(
            {
                "source": str(global_claude),
                "project": "global",
                "type": "claude_md",
                "name": "global-claude-md",
                "description": "Global Claude Code instructions",
                "content": text,
            }
        )

    if GIT_DIR.exists():
        for name in ("CLAUDE.md", "AGENTS.md"):
            for md in sorted(GIT_DIR.glob(f"*/{name}")):
                project = md.parent.name
                text = md.read_text(encoding="utf-8", errors="replace")
                file_type = "claude_md" if name == "CLAUDE.md" else "agents_md"
                results.append(
                    {
                        "source": str(md),
                        "project": project,
                        "type": file_type,
                        "name": f"{project}-{name.lower().replace('.', '-')}",
                        "description": f"{name} for {project}",
                        "content": text,
                    }
                )

    return results


def run_memory(output_path: Path) -> dict:
    """Run memory extraction and write results. Returns summary stats."""
    memory = extract_memory_files()
    claude_md = extract_claude_md_files()
    all_entries = memory + claude_md

    output_path.write_text(
        json.dumps(all_entries, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    return {
        "memory_files": len(memory),
        "claude_md_files": len(claude_md),
        "total": len(all_entries),
    }


# ---------------------------------------------------------------------------
# Extract: history (from extract_history.py)
# ---------------------------------------------------------------------------


def extract_history(history_path: Path | None = None) -> list[dict]:
    """Filter history.jsonl for decision-rich prompts."""
    if history_path is None:
        history_path = CLAUDE_DIR / "history.jsonl"

    if not history_path.exists():
        return []

    results = []
    for entry in parse_jsonl(history_path):
        display = entry.get("display", "")
        if not display:
            continue

        is_rich, signal_type = is_decision_rich(display)
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


def run_history(output_path: Path, history_path: Path | None = None) -> dict:
    """Run history extraction and write results. Returns summary stats."""
    results = extract_history(history_path)

    output_path.write_text(
        json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    by_type: dict[str, int] = {}
    by_project: dict[str, int] = {}
    for r in results:
        st = r["signal_type"]
        by_type[st] = by_type.get(st, 0) + 1
        p = r["project"] or "unknown"
        by_project[p] = by_project.get(p, 0) + 1

    return {
        "total": len(results),
        "by_signal_type": by_type,
        "top_projects": dict(
            sorted(by_project.items(), key=lambda x: x[1], reverse=True)[:10]
        ),
    }


# ---------------------------------------------------------------------------
# Extract: conversations (from extract_conversations.py)
# ---------------------------------------------------------------------------

MAX_OUTPUT_BYTES = 2 * 1024 * 1024


def _process_conversation(jsonl_path: Path) -> list[dict]:
    """Extract decision-rich user-assistant pairs from a conversation file."""
    messages = []
    for entry in parse_jsonl(jsonl_path):
        msg_type = entry.get("type")
        if msg_type not in ("user", "assistant"):
            continue
        messages.append(entry)

    user_texts = [
        m
        for m in messages
        if m.get("type") == "user"
        and isinstance(m.get("message", {}).get("content"), str)
    ]

    if len(user_texts) < 5:
        return []

    pairs = []
    last_assistant_text = ""

    for msg in messages:
        if msg["type"] == "assistant":
            content = msg.get("message", {}).get("content", "")
            last_assistant_text = truncate(extract_text(content), 500)
        elif msg["type"] == "user":
            content = msg.get("message", {}).get("content")
            if not isinstance(content, str):
                continue

            is_rich, signal_type = is_decision_rich(content)
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


def extract_conversations(projects_dir: Path | None = None) -> list[dict]:
    """Scan all project conversation files and extract decision-rich exchanges."""
    if projects_dir is None:
        projects_dir = PROJECTS_DIR

    if not projects_dir.exists():
        return []

    results = []
    output_size = 0

    jsonl_files = sorted(projects_dir.glob("**/*.jsonl"))

    for jsonl_path in jsonl_files:
        if jsonl_path.stat().st_size < 1024:
            continue

        project_dir = jsonl_path.parent
        while project_dir.parent != projects_dir and project_dir != projects_dir:
            project_dir = project_dir.parent
        project_name = project_name_from_dir(project_dir.name)

        pairs = _process_conversation(jsonl_path)
        for pair in pairs:
            pair["project"] = project_name
            pair["source_file"] = str(jsonl_path)
            results.append(pair)

            output_size += len(pair.get("user_response", "")) + len(
                pair.get("assistant_proposal", "")
            )
            if output_size >= MAX_OUTPUT_BYTES:
                return results

    return results


def run_conversations(
    output_path: Path, projects_dir: Path | None = None
) -> dict:
    """Run conversation extraction and write results. Returns summary stats."""
    results = extract_conversations(projects_dir)

    output_path.write_text(
        json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    by_project: dict[str, int] = {}
    by_type: dict[str, int] = {}
    for r in results:
        p = r.get("project", "unknown")
        by_project[p] = by_project.get(p, 0) + 1
        st = r["signal_type"]
        by_type[st] = by_type.get(st, 0) + 1

    return {
        "total_pairs": len(results),
        "files_scanned": len(
            list((projects_dir or PROJECTS_DIR).glob("**/*.jsonl"))
        ),
        "by_signal_type": by_type,
        "top_projects": dict(
            sorted(by_project.items(), key=lambda x: x[1], reverse=True)[:10]
        ),
    }


# ---------------------------------------------------------------------------
# Extract: project configs (from extract_configs.py)
# ---------------------------------------------------------------------------

CONFIG_TYPES = {
    "go.mod": "gomod",
    ".golangci.yml": "golangci",
    ".golangci.yaml": "golangci",
    "lefthook.yml": "lefthook",
    "lefthook.yaml": "lefthook",
    "magefile.go": "magefile",
    ".goreleaser.yaml": "goreleaser",
    ".goreleaser.yml": "goreleaser",
    "package.json": "package_json",
    "tsconfig.json": "tsconfig",
    "biome.json": "biome",
    ".editorconfig": "editorconfig",
}


def _extract_gomod(text: str) -> list[str]:
    """Extract module path and key dependencies from go.mod."""
    signals = []
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("module "):
            signals.append(f"module: {line[7:]}")
        elif line.startswith("go "):
            signals.append(f"go version: {line[3:]}")
        elif "/" in line and not line.startswith("//"):
            dep = line.split()[0] if line.split() else ""
            if dep and not dep.startswith("(") and not dep.startswith(")"):
                signals.append(f"dep: {dep}")
    return signals


def _extract_golangci(text: str) -> list[str]:
    """Extract enabled linters and key settings from golangci-lint config."""
    signals = []
    in_enable = False
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("enable:"):
            in_enable = True
            continue
        if in_enable:
            if stripped.startswith("- "):
                signals.append(f"linter: {stripped[2:]}")
            elif not stripped.startswith("#") and stripped and not stripped.startswith("-"):
                in_enable = False

    if "gofumpt" in text:
        signals.append("formatter: gofumpt")
    elif "gofmt" in text:
        signals.append("formatter: gofmt")

    return signals


def _extract_lefthook(text: str) -> list[str]:
    """Extract hook names and commands from lefthook config."""
    signals = []
    for match in re.finditer(r"^(\w[\w-]*):", text, re.MULTILINE):
        hook_name = match.group(1)
        if hook_name not in ("min_version", "output", "skip_output", "colors"):
            signals.append(f"hook: {hook_name}")

    for match in re.finditer(r"run:\s*(.+)", text):
        signals.append(f"run: {match.group(1).strip()}")

    return signals


def _extract_magefile(text: str) -> list[str]:
    """Extract build targets (exported functions) from magefile.go."""
    signals = []
    for match in re.finditer(r"^func\s+([A-Z]\w*)\b", text, re.MULTILINE):
        signals.append(f"target: {match.group(1)}")
    return signals


def _extract_package_json(text: str) -> list[str]:
    """Extract key info from package.json."""
    signals = []
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return signals

    if "name" in data:
        signals.append(f"name: {data['name']}")

    for dep_key in ("dependencies", "devDependencies"):
        for dep in data.get(dep_key, {}):
            signals.append(f"dep: {dep}")

    for script_name in data.get("scripts", {}):
        signals.append(f"script: {script_name}")

    return signals


def _extract_generic(text: str) -> list[str]:
    """For configs without specific parsers, include a truncated version."""
    return [truncate(text, 1000)]


_CONFIG_EXTRACTORS = {
    "gomod": _extract_gomod,
    "golangci": _extract_golangci,
    "lefthook": _extract_lefthook,
    "magefile": _extract_magefile,
    "goreleaser": _extract_generic,
    "package_json": _extract_package_json,
    "tsconfig": _extract_generic,
    "biome": _extract_generic,
    "editorconfig": _extract_generic,
}


def extract_configs(git_dir: Path | None = None) -> list[dict]:
    """Scan git projects for config files and extract signals."""
    if git_dir is None:
        git_dir = GIT_DIR

    if not git_dir.exists():
        return []

    results = []

    for project_dir in sorted(git_dir.iterdir()):
        if not project_dir.is_dir():
            continue

        project = project_dir.name

        for config_name, config_type in CONFIG_TYPES.items():
            config_path = project_dir / config_name
            if not config_path.exists():
                continue

            text = config_path.read_text(encoding="utf-8", errors="replace")
            extractor = _CONFIG_EXTRACTORS.get(config_type, _extract_generic)
            signals = extractor(text)

            if signals:
                results.append(
                    {
                        "project": project,
                        "config_type": config_type,
                        "file_path": str(config_path),
                        "signals": signals,
                    }
                )

    return results


def run_configs(output_path: Path, git_dir: Path | None = None) -> dict:
    """Run config extraction and write results. Returns summary stats."""
    results = extract_configs(git_dir)

    output_path.write_text(
        json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    by_type: dict[str, int] = {}
    by_project: dict[str, int] = {}
    for r in results:
        ct = r["config_type"]
        by_type[ct] = by_type.get(ct, 0) + 1
        p = r["project"]
        by_project[p] = by_project.get(p, 0) + 1

    return {
        "total_configs": len(results),
        "by_config_type": by_type,
        "projects_with_configs": len(by_project),
    }


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


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
    summary: dict = {"timestamp": int(time.time() * 1000), "extractors": {}}

    print("Extracting crystallized decisions (memory files, CLAUDE.md)...")
    stats = run_memory(output_dir / "crystallized.json")
    summary["extractors"]["memory"] = stats
    print(f"  -> {stats['total']} entries")

    print("Extracting decision-rich history prompts...")
    stats = run_history(output_dir / "history_decisions.json")
    summary["extractors"]["history"] = stats
    print(f"  -> {stats['total']} entries")

    print("Extracting conversation decision exchanges...")
    stats = run_conversations(output_dir / "conversation_decisions.json")
    summary["extractors"]["conversations"] = stats
    print(f"  -> {stats['total_pairs']} pairs")

    print("Extracting project config patterns...")
    stats = run_configs(output_dir / "project_configs.json")
    summary["extractors"]["configs"] = stats
    print(f"  -> {stats['total_configs']} configs")

    elapsed = time.time() - start
    summary["elapsed_seconds"] = round(elapsed, 1)

    summary_path = output_dir / "extraction_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"\nDone in {elapsed:.1f}s. Summary written to {summary_path}")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
