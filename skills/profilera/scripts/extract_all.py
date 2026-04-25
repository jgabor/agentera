#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Run all profilera extractors and write a unified corpus.json.

Probes for recognized runtime data, runs the appropriate extractors, and
produces a single corpus.json with per-record provenance metadata.
If no runtime data is found, exits gracefully with an informative message.

Usage:
    python3 extract_all.py --output-dir ~/.claude/profile/intermediate
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Generator

# ---------------------------------------------------------------------------
# Shared constants and utilities (from utils.py)
# ---------------------------------------------------------------------------

CLAUDE_DIR = Path.home() / ".claude"
PROJECTS_DIR = CLAUDE_DIR / "projects"
COPILOT_DIR = Path.home() / ".copilot"
CODEX_DIR = Path.home() / ".codex"
GIT_DIR = Path(os.environ.get("PROFILERA_GIT_DIR", Path.home() / "git"))


def _default_profile_dir() -> Path:
    """Platform-appropriate default profile directory (XDG on Linux, native on macOS/Windows)."""
    override = os.environ.get("PROFILERA_PROFILE_DIR")
    if override:
        return Path(override)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "agentera"
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming"))
        return Path(appdata) / "agentera"
    xdg = os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share"))
    return Path(xdg) / "agentera"


PROFILE_DIR = _default_profile_dir()
_LEGACY_PROFILE_DIR = CLAUDE_DIR / "profile"

ADAPTER_VERSION = "2.6.0"
RUNTIME_CLAUDE_CODE = "claude-code"
RUNTIME_COPILOT_CLI = "copilot-cli"
RUNTIME_CODEX_CLI = "codex-cli"

_SOURCE_FAMILIES = (
    "instruction_document",
    "history_prompt",
    "conversation_turn",
    "project_config_signal",
)

_SENSITIVE_CONFIG_KEY_WORDS = frozenset((
    "auth",
    "credential",
    "key",
    "password",
    "secret",
    "token",
))

_SENSITIVE_CONFIG_KEY_COMPOUNDS = (
    "accesskey",
    "accesstoken",
    "apikey",
    "authtoken",
    "githubtoken",
    "privatekey",
    "refreshtoken",
    "secretkey",
)

_REDACTED_CONFIG_VALUE = "[redacted]"

# Section 21 record envelope: top-level provenance plus a payload object
_REQUIRED_PROVENANCE_FIELDS = (
    "source_id",
    "timestamp",
    "project_id",
    "source_kind",
    "runtime",
    "adapter_version",
)

_REQUIRED_RECORD_FIELDS = (*_REQUIRED_PROVENANCE_FIELDS, "data")

_REQUIRED_METADATA_FIELDS = (
    "extracted_at",
    "runtimes",
    "adapter_version",
    "families",
    "runtime_status",
    "total_records",
)

_VALID_FAMILY_STATUSES = frozenset(("ok", "missing", "partial"))

# Section 21 portable source_kind values
_PORTABLE_SOURCE_KINDS = frozenset(_SOURCE_FAMILIES)

# Old intermediate files to clean up when corpus.json is written
_LEGACY_FILES = (
    "crystallized.json",
    "history_decisions.json",
    "conversation_decisions.json",
    "project_configs.json",
    "extraction_summary.json",
)

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
# Corpus provenance helpers
# ---------------------------------------------------------------------------


def _generate_source_id(runtime: str, source_kind: str, *key_parts: str) -> str:
    """Generate a stable, idempotent source_id from provenance components.

    Uses a SHA-256 hash of the runtime, source_kind, and key parts (e.g., file
    path, timestamp, session ID) to produce a deterministic identifier that is
    the same across repeated extractions of the same data.
    """
    raw = "|".join([runtime, source_kind, *key_parts])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _probe_claude_code() -> bool:
    """Check whether Claude Code runtime data exists on this system.

    Probes for at least one of: ~/.claude/CLAUDE.md, ~/.claude/history.jsonl,
    or ~/.claude/projects/ directory with content.
    """
    if (CLAUDE_DIR / "CLAUDE.md").exists():
        return True
    if (CLAUDE_DIR / "history.jsonl").exists():
        return True
    if PROJECTS_DIR.exists() and any(PROJECTS_DIR.iterdir()):
        return True
    return False


def _copilot_known_surfaces(copilot_dir: Path | None = None) -> dict[str, list[Path]]:
    """Return the Copilot user-agent surfaces this collector may inspect."""
    base = copilot_dir or COPILOT_DIR
    return {
        "instruction_document": [
            base / "skills",
            base / "installed-plugins",
        ],
        "history_prompt": [],
        "conversation_turn": [],
        "project_config_signal": [
            base / "settings.json",
            base / "installed-plugins",
        ],
    }


def _codex_known_surfaces(codex_dir: Path | None = None) -> dict[str, list[Path]]:
    """Return the Codex user-agent surfaces this collector may inspect."""
    base = codex_dir or CODEX_DIR
    return {
        "instruction_document": [],
        "history_prompt": [
            base / "history.jsonl",
        ],
        "conversation_turn": [
            base / "sessions",
        ],
        "project_config_signal": [
            base / "config.toml",
        ],
    }


def _surface_has_content(path: Path) -> bool:
    """Return True when a known runtime surface exists and is non-empty."""
    if path.is_file():
        return True
    if path.is_dir():
        try:
            next(path.iterdir())
        except (StopIteration, OSError):
            return False
        return True
    return False


def _probe_copilot_cli(copilot_dir: Path | None = None) -> dict:
    """Check for Copilot CLI user-agent data without leaving known surfaces."""
    surfaces = _copilot_known_surfaces(copilot_dir)
    checked = sorted({str(path) for paths in surfaces.values() for path in paths})
    available = any(
        _surface_has_content(path) for paths in surfaces.values() for path in paths
    )
    return {
        "runtime": RUNTIME_COPILOT_CLI,
        "available": available,
        "checked_surfaces": checked,
        "families": {
            family: {
                "status": "available" if any(_surface_has_content(p) for p in paths)
                else "missing",
                "checked_surfaces": [str(path) for path in paths],
            }
            for family, paths in surfaces.items()
        },
    }


def _probe_codex_cli(codex_dir: Path | None = None) -> dict:
    """Check for Codex CLI user-agent data without leaving known surfaces."""
    surfaces = _codex_known_surfaces(codex_dir)
    checked = sorted({str(path) for paths in surfaces.values() for path in paths})
    available = any(
        _surface_has_content(path) for paths in surfaces.values() for path in paths
    )
    return {
        "runtime": RUNTIME_CODEX_CLI,
        "available": available,
        "checked_surfaces": checked,
        "families": {
            family: {
                "status": "available" if any(_surface_has_content(p) for p in paths)
                else "missing",
                "checked_surfaces": [str(path) for path in paths],
            }
            for family, paths in surfaces.items()
        },
    }


def _iso_now() -> str:
    """Return the current UTC time as an ISO 8601 string."""
    return datetime.now(timezone.utc).isoformat()


def _records_from_memory(entries: list[dict]) -> list[dict]:
    """Wrap memory/CLAUDE.md extractor output as corpus records."""
    records = []
    for entry in entries:
        source_path = entry.get("source", "")
        records.append({
            "source_id": _generate_source_id(
                RUNTIME_CLAUDE_CODE, "instruction_document", source_path
            ),
            "timestamp": _iso_now(),
            "project_id": entry.get("project", ""),
            "source_kind": "instruction_document",
            "runtime": RUNTIME_CLAUDE_CODE,
            "adapter_version": ADAPTER_VERSION,
            "data": entry,
        })
    return records


def _records_from_history(entries: list[dict]) -> list[dict]:
    """Wrap history extractor output as corpus records."""
    records = []
    for entry in entries:
        ts = entry.get("timestamp", "")
        session = entry.get("session_id", "")
        prompt_hash = hashlib.sha256(
            entry.get("prompt", "").encode("utf-8")
        ).hexdigest()[:8]
        records.append({
            "source_id": _generate_source_id(
                RUNTIME_CLAUDE_CODE, "history_prompt", str(ts), session, prompt_hash
            ),
            "timestamp": ts if ts else _iso_now(),
            "project_id": entry.get("project", ""),
            "source_kind": "history_prompt",
            "runtime": RUNTIME_CLAUDE_CODE,
            "adapter_version": ADAPTER_VERSION,
            "data": entry,
        })
    return records


def _records_from_conversations(entries: list[dict]) -> list[dict]:
    """Wrap conversation extractor output as corpus records."""
    records = []
    for entry in entries:
        ts = entry.get("timestamp", "")
        session = entry.get("session_id", "")
        response_hash = hashlib.sha256(
            entry.get("user_response", "").encode("utf-8")
        ).hexdigest()[:8]
        records.append({
            "source_id": _generate_source_id(
                RUNTIME_CLAUDE_CODE, "conversation_turn", str(ts), session, response_hash
            ),
            "timestamp": ts if ts else _iso_now(),
            "project_id": entry.get("project", ""),
            "source_kind": "conversation_turn",
            "runtime": RUNTIME_CLAUDE_CODE,
            "adapter_version": ADAPTER_VERSION,
            "data": entry,
        })
    return records


def _records_from_configs(entries: list[dict]) -> list[dict]:
    """Wrap config extractor output as corpus records."""
    records = []
    for entry in entries:
        file_path = entry.get("file_path", "")
        records.append({
            "source_id": _generate_source_id(
                RUNTIME_CLAUDE_CODE, "project_config_signal", file_path
            ),
            "timestamp": _iso_now(),
            "project_id": entry.get("project", ""),
            "source_kind": "project_config_signal",
            "runtime": RUNTIME_CLAUDE_CODE,
            "adapter_version": ADAPTER_VERSION,
            "data": entry,
        })
    return records


def _copilot_project_from_path(path: Path, copilot_dir: Path | None = None) -> str:
    """Derive a stable project/plugin label from a Copilot runtime path."""
    base = copilot_dir or COPILOT_DIR
    installed = base / "installed-plugins"
    try:
        return path.relative_to(installed).parts[0]
    except (ValueError, IndexError):
        return "global"


def _is_sensitive_config_key(key: str) -> bool:
    """Detect credential-like config keys without redacting words like tokenizer."""
    text = str(key)
    split_camel = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", text)
    terms = {
        part
        for part in re.split(r"[^A-Za-z0-9]+", split_camel.lower())
        if part
    }
    if terms & _SENSITIVE_CONFIG_KEY_WORDS:
        return True

    compact = re.sub(r"[^a-z0-9]+", "", text.lower())
    return any(word in compact for word in _SENSITIVE_CONFIG_KEY_COMPOUNDS)


def _copilot_json_signals(data: dict) -> list[str]:
    """Extract bounded config signals without copying full runtime settings."""
    signals = []
    for key, value in sorted(data.items()):
        if isinstance(value, (str, int, float, bool)) or value is None:
            signal_value = _REDACTED_CONFIG_VALUE if _is_sensitive_config_key(key) else value
            signals.append(f"{key}: {signal_value}")
        elif isinstance(value, dict):
            signals.append(f"{key}: {len(value)} keys")
        elif isinstance(value, list):
            signals.append(f"{key}: {len(value)} items")
        else:
            signals.append(f"{key}: {type(value).__name__}")
    return signals


def extract_copilot_instruction_documents(
    copilot_dir: Path | None = None,
) -> list[dict]:
    """Read Copilot skill instruction documents from known user-agent paths."""
    base = copilot_dir or COPILOT_DIR
    results = []
    paths: set[Path] = set()

    personal_skills = base / "skills"
    if personal_skills.exists():
        paths.update(personal_skills.glob("**/*.md"))

    installed_plugins = base / "installed-plugins"
    if installed_plugins.exists():
        paths.update(installed_plugins.glob("*/SKILL.md"))
        paths.update(installed_plugins.glob("*/skills/*/SKILL.md"))

    for md in sorted(path for path in paths if path.is_file()):
        text = md.read_text(encoding="utf-8", errors="replace")
        fm, body = parse_frontmatter(text)
        results.append({
            "source": str(md),
            "project": _copilot_project_from_path(md, base),
            "type": "copilot_skill_instruction",
            "name": fm.get("name", md.stem),
            "description": fm.get("description", ""),
            "content": body,
        })

    return results


def extract_copilot_configs(copilot_dir: Path | None = None) -> list[dict]:
    """Read Copilot runtime config signals from known user-agent paths."""
    base = copilot_dir or COPILOT_DIR
    results = []
    config_paths = [base / "settings.json"]
    installed_plugins = base / "installed-plugins"
    if installed_plugins.exists():
        config_paths.extend(installed_plugins.glob("*/.github/plugin/plugin.json"))
        config_paths.extend(installed_plugins.glob("*/plugin.json"))

    for config_path in sorted(path for path in config_paths if path.is_file()):
        text = config_path.read_text(encoding="utf-8", errors="replace")
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            signals = [truncate(text, 1000)]
        else:
            signals = _copilot_json_signals(data) if isinstance(data, dict) else []
        if not signals:
            continue
        results.append({
            "project": _copilot_project_from_path(config_path, base),
            "config_type": "copilot_runtime_config",
            "file_path": str(config_path),
            "signals": signals,
        })

    return results


def _codex_session_id(record: dict, path: Path) -> str:
    """Extract a Codex session/runtime ID with file-stem fallback."""
    for key in ("session_id", "sessionId", "conversation_id", "conversationId"):
        value = record.get(key)
        if value:
            return str(value)
    return path.stem


def _codex_timestamp(record: dict, fallback: str = "") -> str:
    """Extract a timestamp from known Codex record keys."""
    for key in ("timestamp", "ts", "created_at", "createdAt"):
        value = record.get(key)
        if value:
            return str(value)
    return fallback


def _codex_message_text(record: dict) -> tuple[str, str]:
    """Extract role and text from common Codex JSONL message shapes."""
    message = record.get("message")
    if isinstance(message, dict):
        role = str(message.get("role", record.get("role", "unknown")))
        text = extract_text(message.get("content", ""))
        return role, text
    role = str(record.get("role", record.get("type", "unknown")))
    for key in ("content", "text", "prompt"):
        text = extract_text(record.get(key, ""))
        if text:
            return role, text
    return role, ""


def extract_codex_history(codex_dir: Path | None = None) -> list[dict]:
    """Read Codex prompt history from the bounded user-agent history file."""
    base = codex_dir or CODEX_DIR
    history_path = base / "history.jsonl"
    if not history_path.is_file():
        return []

    results = []
    for line_no, record in enumerate(parse_jsonl(history_path), start=1):
        _, prompt = _codex_message_text(record)
        if not prompt:
            continue
        session_id = _codex_session_id(record, history_path)
        results.append({
            "source": str(history_path),
            "line": line_no,
            "runtime_session_id": session_id,
            "runtime_record_id": str(record.get("id", f"line-{line_no}")),
            "timestamp": _codex_timestamp(record),
            "project": record.get("cwd") or record.get("project") or "global",
            "prompt": prompt,
        })
    return results


def extract_codex_conversations(codex_dir: Path | None = None) -> list[dict]:
    """Read Codex session JSONL turns from the bounded sessions directory."""
    base = codex_dir or CODEX_DIR
    sessions = base / "sessions"
    if not sessions.is_dir():
        return []

    results = []
    for session_path in sorted(sessions.glob("**/*.jsonl")):
        if not session_path.is_file():
            continue
        for line_no, record in enumerate(parse_jsonl(session_path), start=1):
            role, text = _codex_message_text(record)
            if not text:
                continue
            session_id = _codex_session_id(record, session_path)
            results.append({
                "source": str(session_path),
                "line": line_no,
                "runtime_session_id": session_id,
                "runtime_record_id": str(record.get("id", f"line-{line_no}")),
                "timestamp": _codex_timestamp(record),
                "project": record.get("cwd") or record.get("project") or session_id,
                "role": role,
                "content": text,
            })
    return results


def _codex_config_signals(text: str) -> list[str]:
    """Extract safe Codex config signals without copying credentials."""
    signals = []
    sensitive = ("auth", "credential", "key", "password", "secret", "token")
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        key = line.split("=", 1)[0].strip().strip('"')
        if any(word in key.lower() for word in sensitive):
            continue
        signals.append(line if line.startswith("[") else key)
    return signals


def extract_codex_configs(codex_dir: Path | None = None) -> list[dict]:
    """Read Codex runtime config signals from the bounded config file."""
    base = codex_dir or CODEX_DIR
    config_path = base / "config.toml"
    if not config_path.is_file():
        return []
    signals = _codex_config_signals(
        config_path.read_text(encoding="utf-8", errors="replace")
    )
    if not signals:
        return []
    return [{
        "project": "global",
        "config_type": "codex_runtime_config",
        "file_path": str(config_path),
        "signals": signals,
    }]


def _records_from_copilot_memory(entries: list[dict]) -> list[dict]:
    """Wrap Copilot instruction document output as corpus records."""
    records = []
    for entry in entries:
        source_path = entry.get("source", "")
        records.append({
            "source_id": _generate_source_id(
                RUNTIME_COPILOT_CLI, "instruction_document", source_path
            ),
            "timestamp": _iso_now(),
            "project_id": entry.get("project", ""),
            "source_kind": "instruction_document",
            "runtime": RUNTIME_COPILOT_CLI,
            "adapter_version": ADAPTER_VERSION,
            "data": entry,
        })
    return records


def _records_from_copilot_configs(entries: list[dict]) -> list[dict]:
    """Wrap Copilot config output as corpus records."""
    records = []
    for entry in entries:
        file_path = entry.get("file_path", "")
        records.append({
            "source_id": _generate_source_id(
                RUNTIME_COPILOT_CLI, "project_config_signal", file_path
            ),
            "timestamp": _iso_now(),
            "project_id": entry.get("project", ""),
            "source_kind": "project_config_signal",
            "runtime": RUNTIME_COPILOT_CLI,
            "adapter_version": ADAPTER_VERSION,
            "data": entry,
        })
    return records


def _records_from_codex_history(entries: list[dict]) -> list[dict]:
    """Wrap Codex history output as corpus records."""
    records = []
    for entry in entries:
        prompt_hash = hashlib.sha256(
            entry.get("prompt", "").encode("utf-8")
        ).hexdigest()[:8]
        records.append({
            "source_id": _generate_source_id(
                RUNTIME_CODEX_CLI,
                "history_prompt",
                entry.get("source", ""),
                str(entry.get("line", "")),
                entry.get("runtime_session_id", ""),
                entry.get("runtime_record_id", ""),
                prompt_hash,
            ),
            "timestamp": entry.get("timestamp") or _iso_now(),
            "project_id": str(entry.get("project", "")),
            "source_kind": "history_prompt",
            "runtime": RUNTIME_CODEX_CLI,
            "adapter_version": ADAPTER_VERSION,
            "data": entry,
        })
    return records


def _records_from_codex_conversations(entries: list[dict]) -> list[dict]:
    """Wrap Codex session turn output as corpus records."""
    records = []
    for entry in entries:
        content_hash = hashlib.sha256(
            entry.get("content", "").encode("utf-8")
        ).hexdigest()[:8]
        records.append({
            "source_id": _generate_source_id(
                RUNTIME_CODEX_CLI,
                "conversation_turn",
                entry.get("source", ""),
                str(entry.get("line", "")),
                entry.get("runtime_session_id", ""),
                entry.get("runtime_record_id", ""),
                content_hash,
            ),
            "timestamp": entry.get("timestamp") or _iso_now(),
            "project_id": str(entry.get("project", "")),
            "source_kind": "conversation_turn",
            "runtime": RUNTIME_CODEX_CLI,
            "adapter_version": ADAPTER_VERSION,
            "data": entry,
        })
    return records


def _records_from_codex_configs(entries: list[dict]) -> list[dict]:
    """Wrap Codex config output as corpus records."""
    records = []
    for entry in entries:
        file_path = entry.get("file_path", "")
        records.append({
            "source_id": _generate_source_id(
                RUNTIME_CODEX_CLI, "project_config_signal", file_path
            ),
            "timestamp": _iso_now(),
            "project_id": entry.get("project", ""),
            "source_kind": "project_config_signal",
            "runtime": RUNTIME_CODEX_CLI,
            "adapter_version": ADAPTER_VERSION,
            "data": entry,
        })
    return records


def _empty_runtime_families() -> dict[str, dict]:
    """Return an empty family status map for one runtime."""
    return {kind: {"count": 0, "status": "missing"} for kind in _SOURCE_FAMILIES}


def _aggregate_families(runtime_status: dict[str, dict]) -> dict[str, dict]:
    """Aggregate per-runtime family status while retaining runtime details."""
    families = {}
    for kind in _SOURCE_FAMILIES:
        by_runtime = {
            runtime: status["families"][kind]
            for runtime, status in runtime_status.items()
            if kind in status.get("families", {})
        }
        count = sum(info.get("count", 0) for info in by_runtime.values())
        statuses = {info.get("status", "missing") for info in by_runtime.values()}
        if count == 0:
            status = "missing"
        elif statuses <= {"ok"}:
            status = "ok"
        else:
            status = "partial"
        families[kind] = {
            "count": count,
            "status": status,
            "by_runtime": by_runtime,
        }
    return families


def _cleanup_legacy_files(output_dir: Path) -> list[str]:
    """Remove old intermediate files from the output directory.

    Returns a list of filenames that were removed.
    """
    removed = []
    for name in _LEGACY_FILES:
        legacy = output_dir / name
        if legacy.exists():
            legacy.unlink()
            removed.append(name)
    return removed


# ---------------------------------------------------------------------------
# Self-validation (Section 21 provenance contract)
# ---------------------------------------------------------------------------


def validate_corpus(records: list[dict]) -> tuple[list[str], list[str]]:
    """Validate corpus records against the Section 21 record contract.

    Checks every record for:
    - Required provenance fields (source_id, timestamp, project_id,
      source_kind, runtime, adapter_version) and a data payload object.
      Missing fields are errors.
    - Recognized source_kind values. Unrecognized values are warnings
      (runtime extensions are permitted but noted).

    Returns (errors, warnings) where each is a list of human-readable
    messages. An empty errors list means all records are well-formed.
    """
    errors: list[str] = []
    warnings: list[str] = []

    for i, record in enumerate(records):
        missing = [
            field for field in _REQUIRED_RECORD_FIELDS
            if field not in record or record[field] == ""
        ]
        if missing:
            source_id = record.get("source_id", f"record[{i}]")
            errors.append(
                f"Record {source_id}: missing required record "
                f"fields: {', '.join(missing)}"
            )

        data = record.get("data")
        if "data" in record and not isinstance(data, dict):
            source_id = record.get("source_id", f"record[{i}]")
            errors.append(f"Record {source_id}: data must be an object")

        kind = record.get("source_kind", "")
        if kind and kind not in _PORTABLE_SOURCE_KINDS:
            source_id = record.get("source_id", f"record[{i}]")
            warnings.append(
                f"Record {source_id}: unrecognized source_kind "
                f"'{kind}' (runtime extension)"
            )

    return errors, warnings


def _validate_family_status(path: str, info: object) -> tuple[list[str], int | None, str | None]:
    """Validate one family status object and return its count/status."""
    errors: list[str] = []
    if not isinstance(info, dict):
        return [f"{path}: must be an object"], None, None

    count = info.get("count")
    status = info.get("status")
    if not isinstance(count, int) or count < 0:
        errors.append(f"{path}.count: must be a non-negative integer")
        count = None
    if status not in _VALID_FAMILY_STATUSES:
        errors.append(
            f"{path}.status: must be one of {', '.join(sorted(_VALID_FAMILY_STATUSES))}"
        )
        status = None
    return errors, count, status


def _validate_runtime_status(
    runtime_status: dict,
    runtimes: list[str],
    records: list[dict],
) -> list[str]:
    """Validate per-runtime family metadata against emitted records."""
    errors: list[str] = []
    for runtime, status in runtime_status.items():
        path = f"corpus.metadata.runtime_status.{runtime}"
        if not isinstance(status, dict):
            errors.append(f"{path}: must be an object")
            continue
        if runtime not in runtimes:
            errors.append(f"{path}: runtime not listed in metadata.runtimes")
        if status.get("available") is not True:
            errors.append(f"{path}.available: must be true for contributing runtimes")
        checked_surfaces = status.get("checked_surfaces")
        if not isinstance(checked_surfaces, list) or not all(
            isinstance(surface, str) for surface in checked_surfaces
        ):
            errors.append(f"{path}.checked_surfaces: must be a string list")
        families = status.get("families")
        if not isinstance(families, dict):
            errors.append(f"{path}.families: must be an object")
            continue
        for family in _SOURCE_FAMILIES:
            family_path = f"{path}.families.{family}"
            if family not in families:
                errors.append(f"{family_path}: missing required family status")
                continue
            family_errors, count, _status = _validate_family_status(
                family_path, families[family]
            )
            errors.extend(family_errors)
            actual = sum(
                1 for record in records
                if record.get("runtime") == runtime and record.get("source_kind") == family
            )
            if count is not None and count != actual:
                errors.append(f"{family_path}.count: must match {actual} emitted records")
    return errors


def _validate_aggregate_families(
    families: dict,
    runtime_status: dict,
    records: list[dict],
) -> list[str]:
    """Validate aggregate family metadata against runtime status and records."""
    errors: list[str] = []
    for family in _SOURCE_FAMILIES:
        path = f"corpus.metadata.families.{family}"
        if family not in families:
            errors.append(f"{path}: missing required family status")
            continue
        family_errors, count, _status = _validate_family_status(path, families[family])
        errors.extend(family_errors)
        info = families[family]
        if not isinstance(info, dict):
            continue
        by_runtime = info.get("by_runtime")
        if not isinstance(by_runtime, dict):
            errors.append(f"{path}.by_runtime: must be an object")
            continue
        expected_runtimes = set(runtime_status)
        if set(by_runtime) != expected_runtimes:
            missing = sorted(expected_runtimes - set(by_runtime))
            extra = sorted(set(by_runtime) - expected_runtimes)
            detail = []
            if missing:
                detail.append("missing " + ", ".join(missing))
            if extra:
                detail.append("unexpected " + ", ".join(extra))
            errors.append(f"{path}.by_runtime: must match runtime_status ({'; '.join(detail)})")
        expected_count = sum(
            status.get("families", {}).get(family, {}).get("count", 0)
            for status in runtime_status.values()
            if isinstance(status, dict)
        )
        actual_records = sum(1 for record in records if record.get("source_kind") == family)
        if count is not None and count != expected_count:
            errors.append(f"{path}.count: must equal per-runtime count {expected_count}")
        if count is not None and count != actual_records:
            errors.append(f"{path}.count: must match {actual_records} emitted records")
        for runtime, runtime_family in by_runtime.items():
            runtime_info = runtime_status.get(runtime, {})
            expected = runtime_info.get("families", {}).get(family) if isinstance(runtime_info, dict) else None
            if runtime_family != expected:
                errors.append(f"{path}.by_runtime.{runtime}: must match runtime_status family data")
    return errors


def validate_corpus_envelope(corpus: dict) -> tuple[list[str], list[str]]:
    """Validate a Section 21 corpus envelope, including aggregate metadata."""
    if corpus == {}:
        return [], []

    errors: list[str] = []
    warnings: list[str] = []
    metadata = corpus.get("metadata")
    records = corpus.get("records")
    if not isinstance(metadata, dict):
        return ["corpus.metadata: must be an object"], warnings
    if not isinstance(records, list):
        return ["corpus.records: must be a list"], warnings

    missing_metadata = [
        field for field in _REQUIRED_METADATA_FIELDS
        if field not in metadata or metadata[field] == ""
    ]
    if missing_metadata:
        errors.append(
            "corpus.metadata: missing required fields: "
            + ", ".join(missing_metadata)
        )

    record_errors, record_warnings = validate_corpus(records)
    errors.extend(record_errors)
    warnings.extend(record_warnings)

    runtimes = metadata.get("runtimes")
    if not isinstance(runtimes, list) or not all(isinstance(r, str) for r in runtimes):
        errors.append("corpus.metadata.runtimes: must be a string list")
        runtimes = []
    elif records and not runtimes:
        errors.append("corpus.metadata.runtimes: must name contributing runtimes")

    total_records = metadata.get("total_records")
    if total_records != len(records):
        errors.append("corpus.metadata.total_records: must match records length")

    if metadata.get("adapter_version") != ADAPTER_VERSION:
        errors.append("corpus.metadata.adapter_version: must match extractor adapter version")

    seen_source_ids: set[str] = set()
    for record in records:
        source_id = record.get("source_id")
        if isinstance(source_id, str) and source_id:
            if source_id in seen_source_ids:
                errors.append(f"Record {source_id}: duplicate source_id")
            seen_source_ids.add(source_id)
        runtime = record.get("runtime")
        if isinstance(runtime, str) and runtimes and runtime not in runtimes:
            errors.append(f"Record {source_id}: runtime '{runtime}' missing from metadata.runtimes")

    runtime_status = metadata.get("runtime_status")
    if not isinstance(runtime_status, dict):
        errors.append("corpus.metadata.runtime_status: must be an object")
    elif isinstance(runtimes, list):
        missing = [runtime for runtime in runtimes if runtime not in runtime_status]
        if missing:
            errors.append(
                "corpus.metadata.runtime_status: missing runtimes " + ", ".join(missing)
            )

    families = metadata.get("families")
    if not isinstance(families, dict):
        errors.append("corpus.metadata.families: must be an object")

    if isinstance(runtime_status, dict) and isinstance(runtimes, list):
        errors.extend(_validate_runtime_status(runtime_status, runtimes, records))
    if isinstance(families, dict) and isinstance(runtime_status, dict):
        errors.extend(_validate_aggregate_families(families, runtime_status, records))

    return errors, warnings


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def _probe_claude_code_runtime() -> dict | None:
    """Return Claude Code runtime status when supported local data exists."""
    if not _probe_claude_code():
        return None
    return {
        "runtime": RUNTIME_CLAUDE_CODE,
        "available": True,
        "checked_surfaces": [
            str(CLAUDE_DIR / "CLAUDE.md"),
            str(CLAUDE_DIR / "history.jsonl"),
            str(PROJECTS_DIR),
        ],
        "families": {},
    }


def _available_probe(probe: dict) -> dict | None:
    """Normalize probe output to None when a runtime has no data."""
    return probe if probe["available"] else None


def _run_runtime_family(
    runtime: str,
    runtime_status: dict,
    probe_status: dict,
    family: dict,
) -> tuple[list[dict], str | None]:
    """Run one source-family extractor and return records plus any error."""
    kind = family["kind"]
    checked_surfaces = family.get("checked_surfaces", lambda _status: None)(probe_status)
    if family.get("unsupported_reason"):
        status = {
            "count": 0,
            "status": "missing",
            "reason": family["unsupported_reason"],
        }
        if checked_surfaces is not None:
            status["checked_surfaces"] = checked_surfaces
        runtime_status["families"][kind] = status
        return [], None

    try:
        records = family["to_records"](family["extract"]())
    except Exception as exc:
        status = {"count": 0, "status": "missing", "error": str(exc)}
        if checked_surfaces is not None:
            status["checked_surfaces"] = checked_surfaces
        runtime_status["families"][kind] = status
        return [], f"{runtime}.{kind}: {exc}"

    status = {
        "count": len(records),
        "status": "ok" if records else family.get("empty_status", "ok"),
    }
    if checked_surfaces is not None:
        status["checked_surfaces"] = checked_surfaces
    runtime_status["families"][kind] = status
    return records, None


def _runtime_collectors() -> tuple[dict, ...]:
    """Return supported runtime collector specs.

    Adding a runtime should extend this registry instead of branching inside
    build_corpus(). Existing extractor implementations stay runtime-local.
    """
    return (
        {
            "runtime": RUNTIME_CLAUDE_CODE,
            "probe": _probe_claude_code_runtime,
            "families": (
                {
                    "kind": "instruction_document",
                    "extract": lambda: extract_memory_files() + extract_claude_md_files(),
                    "to_records": _records_from_memory,
                },
                {
                    "kind": "history_prompt",
                    "extract": extract_history,
                    "to_records": _records_from_history,
                },
                {
                    "kind": "conversation_turn",
                    "extract": extract_conversations,
                    "to_records": _records_from_conversations,
                },
                {
                    "kind": "project_config_signal",
                    "extract": extract_configs,
                    "to_records": _records_from_configs,
                },
            ),
        },
        {
            "runtime": RUNTIME_COPILOT_CLI,
            "probe": lambda: _available_probe(_probe_copilot_cli()),
            "families": (
                {
                    "kind": "instruction_document",
                    "extract": extract_copilot_instruction_documents,
                    "to_records": _records_from_copilot_memory,
                    "empty_status": "missing",
                    "checked_surfaces": lambda status: status["families"]["instruction_document"]["checked_surfaces"],
                },
                {
                    "kind": "history_prompt",
                    "unsupported_reason": "no documented Copilot CLI local source family surface",
                    "checked_surfaces": lambda _status: [],
                },
                {
                    "kind": "conversation_turn",
                    "unsupported_reason": "no documented Copilot CLI local source family surface",
                    "checked_surfaces": lambda _status: [],
                },
                {
                    "kind": "project_config_signal",
                    "extract": extract_copilot_configs,
                    "to_records": _records_from_copilot_configs,
                    "empty_status": "missing",
                    "checked_surfaces": lambda status: status["families"]["project_config_signal"]["checked_surfaces"],
                },
            ),
        },
        {
            "runtime": RUNTIME_CODEX_CLI,
            "probe": lambda: _available_probe(_probe_codex_cli()),
            "families": (
                {
                    "kind": "instruction_document",
                    "unsupported_reason": "no documented Codex CLI local instruction source family surface",
                    "checked_surfaces": lambda status: status["families"]["instruction_document"]["checked_surfaces"],
                },
                {
                    "kind": "history_prompt",
                    "extract": extract_codex_history,
                    "to_records": _records_from_codex_history,
                    "empty_status": "missing",
                    "checked_surfaces": lambda status: status["families"]["history_prompt"]["checked_surfaces"],
                },
                {
                    "kind": "conversation_turn",
                    "extract": extract_codex_conversations,
                    "to_records": _records_from_codex_conversations,
                    "empty_status": "missing",
                    "checked_surfaces": lambda status: status["families"]["conversation_turn"]["checked_surfaces"],
                },
                {
                    "kind": "project_config_signal",
                    "extract": extract_codex_configs,
                    "to_records": _records_from_codex_configs,
                    "empty_status": "missing",
                    "checked_surfaces": lambda status: status["families"]["project_config_signal"]["checked_surfaces"],
                },
            ),
        },
    )


def build_corpus() -> tuple[dict, list[str], list[str]]:
    """Run all extractors, validate, and return the corpus envelope.

    Returns ``(corpus, errors, warnings)`` where *corpus* is a dict with
    top-level ``metadata`` and ``records`` keys, *errors* is a list of
    validation error messages (missing required provenance fields), and
    *warnings* is a list of validation warning messages (unrecognized
    source_kind values). If no runtime data is detected, returns
    ``({}, [], [])``.
    """
    all_records: list[dict] = []
    runtime_status: dict[str, dict] = {}
    errors: list[str] = []

    for collector in _runtime_collectors():
        probe = collector["probe"]()
        if probe is None:
            continue
        runtime = collector["runtime"]
        status = {
            "available": True,
            "checked_surfaces": probe["checked_surfaces"],
            "families": _empty_runtime_families(),
        }

        for family in collector["families"]:
            records, error = _run_runtime_family(runtime, status, probe, family)
            all_records.extend(records)
            if error:
                errors.append(error)

        runtime_status[runtime] = status

    if not runtime_status:
        return {}, [], []

    metadata = {
        "extracted_at": _iso_now(),
        "runtimes": list(runtime_status),
        "adapter_version": ADAPTER_VERSION,
        "families": _aggregate_families(runtime_status),
        "runtime_status": runtime_status,
        "total_records": len(all_records),
    }
    if errors:
        metadata["errors"] = errors

    corpus = {"metadata": metadata, "records": all_records}
    validation_errors, validation_warnings = validate_corpus_envelope(corpus)
    return corpus, validation_errors, validation_warnings


def migrate_legacy_profile() -> str | None:
    """One-time migration from ~/.claude/profile/ to the XDG location.

    Returns a message if migration occurred, None otherwise.
    """
    if not _LEGACY_PROFILE_DIR.exists():
        return None
    new_profile = PROFILE_DIR / "PROFILE.md"
    if new_profile.exists():
        return None
    legacy_profile = _LEGACY_PROFILE_DIR / "PROFILE.md"
    if not legacy_profile.exists():
        return None
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(legacy_profile, new_profile)
    # Also migrate history if present
    legacy_history = _LEGACY_PROFILE_DIR / "history"
    if legacy_history.is_dir():
        new_history = PROFILE_DIR / "history"
        if not new_history.exists():
            shutil.copytree(legacy_history, new_history)
    return f"Migrated profile from {_LEGACY_PROFILE_DIR} to {PROFILE_DIR}"


def main():
    parser = argparse.ArgumentParser(
        description="Run all profilera extractors and produce corpus.json"
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=PROFILE_DIR / "intermediate",
        help="Directory to write corpus.json",
    )
    args = parser.parse_args()

    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    migrated = migrate_legacy_profile()
    if migrated:
        print(migrated)

    start = time.time()

    # Probe for runtime data
    copilot_probe = _probe_copilot_cli()
    codex_probe = _probe_codex_cli()
    if (
        not _probe_claude_code()
        and not copilot_probe["available"]
        and not codex_probe["available"]
    ):
        print(
            "No supported runtime data found.\n"
            f"Checked Claude Code: {CLAUDE_DIR / 'CLAUDE.md'}, "
            f"{CLAUDE_DIR / 'history.jsonl'}, "
            f"{PROJECTS_DIR}\n"
            f"Checked Copilot CLI: {', '.join(copilot_probe['checked_surfaces'])}\n"
            f"Checked Codex CLI: {', '.join(codex_probe['checked_surfaces'])}\n"
            "No corpus.json written."
        )
        sys.exit(0)

    print("Building corpus from supported runtime data...")
    corpus, validation_errors, validation_warnings = build_corpus()

    elapsed = time.time() - start

    # Report validation results
    if validation_warnings:
        print(f"\n  Validation warnings ({len(validation_warnings)}):")
        for w in validation_warnings:
            print(f"    WARNING: {w}")

    if validation_errors:
        print(f"\n  Validation errors ({len(validation_errors)}):")
        for e in validation_errors:
            print(f"    ERROR: {e}")
        print(f"\nAborted in {elapsed:.1f}s. corpus.json NOT written "
              f"due to {len(validation_errors)} validation error(s).")
        sys.exit(1)

    # Write corpus.json (validation passed)
    corpus_path = output_dir / "corpus.json"
    corpus_path.write_text(
        json.dumps(corpus, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # Clean up legacy intermediate files
    removed = _cleanup_legacy_files(output_dir)
    if removed:
        print(f"  Cleaned up legacy files: {', '.join(removed)}")

    # Print summary
    meta = corpus["metadata"]
    print(f"  Runtimes: {', '.join(meta['runtimes'])}")
    print(f"  Adapter version: {meta['adapter_version']}")
    for kind, info in meta["families"].items():
        status_marker = "ok" if info["status"] == "ok" else "MISSING"
        print(f"  {kind}: {info['count']} records [{status_marker}]")
    print(f"  Total records: {meta['total_records']}")
    if meta.get("errors"):
        print(f"  Errors: {meta['errors']}")
    print(f"\nDone in {elapsed:.1f}s. Corpus written to {corpus_path}")


if __name__ == "__main__":
    main()
