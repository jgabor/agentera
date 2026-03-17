"""Shared utilities for profilera extraction scripts."""

import json
import os
import re
from pathlib import Path
from typing import Generator

CLAUDE_DIR = Path.home() / ".claude"
PROJECTS_DIR = CLAUDE_DIR / "projects"
GIT_DIR = Path(os.environ.get("PROFILERA_GIT_DIR", Path.home() / "git"))

# Decision signal patterns
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

    frontmatter = {}
    current_key = None
    current_value_lines = []

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
    # Strip known path prefixes (longest first)
    prefixes = [
        "-home-jgabor-git-",
        "-home-jgabor-",
    ]
    for prefix in prefixes:
        if dirname.startswith(prefix):
            remainder = dirname[len(prefix) :]
            if remainder:
                # A leading '-' means the original had a '.' (e.g., --claude -> .claude)
                if remainder.startswith("-"):
                    return "." + remainder[1:]
                return remainder
    return dirname


def truncate(text: str, max_len: int = 500) -> str:
    """Truncate text to max_len, adding ellipsis if truncated."""
    if len(text) <= max_len:
        return text
    return text[:max_len] + "..."
