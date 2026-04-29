#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Generate per-skill contract files from SPEC.md.

Parses SPEC.md into sections by ``## N.`` heading
boundaries, reads each SKILL.md's ``spec_sections`` frontmatter field,
and writes the declared sections verbatim into
skills/<name>/references/contract.md.

Run from repo root:
    python3 scripts/generate_contracts.py                  # all skills
    python3 scripts/generate_contracts.py --skill realisera  # one skill
    python3 scripts/generate_contracts.py --check            # freshness check
    python3 scripts/generate_contracts.py --schema           # parse tables to JSON
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
SPEC_PATH = REPO_ROOT / "SPEC.md"
SKILLS_DIR = REPO_ROOT / "skills"

# Regex matching ``## N. Title`` section headings in SPEC.md.
SECTION_HEADING_RE = re.compile(r"^## (\d+)\.\s+(.+)$", re.MULTILINE)


# ---------------------------------------------------------------------------
# Colour helpers
# ---------------------------------------------------------------------------

_USE_COLOR = sys.stdout.isatty()


def _green(text: str) -> str:
    return f"\033[32m{text}\033[0m" if _USE_COLOR else text


def _red(text: str) -> str:
    return f"\033[31m{text}\033[0m" if _USE_COLOR else text


def _yellow(text: str) -> str:
    return f"\033[33m{text}\033[0m" if _USE_COLOR else text


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------


def parse_spec_sections(spec_text: str) -> dict[int, str]:
    """Parse SPEC.md into a dict mapping section number to content.

    Each section starts at a ``## N. Title`` heading and ends just before the
    next ``## N.`` heading (or end of file).  The returned content includes
    the heading line itself so that generated files carry the heading.
    """
    matches = list(SECTION_HEADING_RE.finditer(spec_text))
    if not matches:
        return {}

    sections: dict[int, str] = {}
    for i, m in enumerate(matches):
        section_num = int(m.group(1))
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(spec_text)
        # Include the heading, strip trailing whitespace but keep one newline.
        content = spec_text[start:end].rstrip() + "\n"
        sections[section_num] = content
    return sections


def parse_frontmatter_spec_sections(text: str) -> list[int] | None:
    """Extract the ``spec_sections`` list from SKILL.md YAML frontmatter.

    Returns None if the frontmatter is missing or lacks the field.
    """
    if not text.startswith("---"):
        return None
    end = text.find("---", 3)
    if end == -1:
        return None
    block = text[3:end]
    for line in block.splitlines():
        m = re.match(r"^spec_sections:\s*\[(.+)]", line)
        if m:
            try:
                return [int(x.strip()) for x in m.group(1).split(",")]
            except ValueError:
                return None
    return None


def compute_spec_hash(spec_text: str) -> str:
    """Return the sha256 hex digest of the spec content."""
    return hashlib.sha256(spec_text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------


def build_context_content(
    skill_name: str,
    section_nums: list[int],
    sections: dict[int, str],
    spec_hash: str,
    timestamp: str,
) -> str:
    """Build the full contract.md content for a skill."""
    section_list_str = ", ".join(str(n) for n in section_nums)
    header = "\n".join(
        [
            f"<!-- contract: {skill_name} -->",
            f"<!-- source: SPEC.md (sha256: {spec_hash}) -->",
            f"<!-- sections: {section_list_str} -->",
            f"<!-- generated: {timestamp} -->",
            "<!-- do not edit manually -->",
            "<!-- regenerate: python3 scripts/generate_contracts.py -->",
        ]
    )
    body_parts: list[str] = []
    for num in section_nums:
        if num in sections:
            body_parts.append(sections[num])
    return header + "\n\n" + "\n".join(body_parts)


def generate_for_skill(
    skill_name: str,
    sections: dict[int, str],
    spec_hash: str,
    timestamp: str,
) -> str | None:
    """Generate the context file for one skill.

    Returns the generated content, or None if the skill lacks
    ``spec_sections`` in its frontmatter.
    """
    skill_md = SKILLS_DIR / skill_name / "SKILL.md"
    if not skill_md.exists():
        print(
            _red(f"ERROR: {skill_md.relative_to(REPO_ROOT)} not found"),
            file=sys.stderr,
        )
        return None

    text = skill_md.read_text(encoding="utf-8")
    section_nums = parse_frontmatter_spec_sections(text)
    if section_nums is None:
        print(
            _yellow(f"SKIP   {skill_name}: no spec_sections in frontmatter"),
        )
        return None

    missing = [n for n in section_nums if n not in sections]
    if missing:
        print(
            _red(
                f"ERROR: {skill_name} requests sections {missing} not found in SPEC.md"
            ),
            file=sys.stderr,
        )
        return None

    return build_context_content(
        skill_name,
        section_nums,
        sections,
        spec_hash,
        timestamp,
    )


def write_context_file(skill_name: str, content: str) -> Path:
    """Write the context file and return its path."""
    refs_dir = SKILLS_DIR / skill_name / "references"
    refs_dir.mkdir(parents=True, exist_ok=True)
    out_path = refs_dir / "contract.md"
    out_path.write_text(content, encoding="utf-8")
    return out_path


# ---------------------------------------------------------------------------
# Check mode
# ---------------------------------------------------------------------------


def extract_header_hash(content: str) -> str | None:
    """Extract the sha256 hash from an existing context file's header."""
    m = re.search(r"<!-- source: .+?\(sha256: ([a-f0-9]+)\) -->", content)
    return m.group(1) if m else None


def check_freshness(
    skill_names: list[str],
    sections: dict[int, str],
    spec_hash: str,
    timestamp: str,
) -> list[str]:
    """Return list of skill names whose context files are stale or missing."""
    stale: list[str] = []
    for name in skill_names:
        context_path = SKILLS_DIR / name / "references" / "contract.md"

        # Read the SKILL.md to check if it has spec_sections.
        skill_md = SKILLS_DIR / name / "SKILL.md"
        if not skill_md.exists():
            stale.append(name)
            continue
        text = skill_md.read_text(encoding="utf-8")
        section_nums = parse_frontmatter_spec_sections(text)
        if section_nums is None:
            # No spec_sections: nothing to check.
            continue

        if not context_path.exists():
            stale.append(name)
            continue

        existing = context_path.read_text(encoding="utf-8")

        # Check 1: source hash matches current spec.
        existing_hash = extract_header_hash(existing)
        if existing_hash != spec_hash:
            stale.append(name)
            continue

        # Check 2: content matches what would be generated.
        expected = build_context_content(
            name,
            section_nums,
            sections,
            spec_hash,
            timestamp,
        )
        # Compare without the timestamp line (timestamps differ between runs).
        existing_no_ts = re.sub(
            r"<!-- generated: .+ -->",
            "<!-- generated: STRIPPED -->",
            existing,
        )
        expected_no_ts = re.sub(
            r"<!-- generated: .+ -->",
            "<!-- generated: STRIPPED -->",
            expected,
        )
        if existing_no_ts != expected_no_ts:
            stale.append(name)

    return stale


# ---------------------------------------------------------------------------
# Schema parsing
# ---------------------------------------------------------------------------

SCHEMAS_DIR = REPO_ROOT / "scripts" / "schemas"
CONTRACTS_JSON = SCHEMAS_DIR / "contracts.json"

# Headings used to locate target tables in SPEC.md.
_ISSUE_SEVERITY_HEADING_RE = re.compile(r"^### Issue severity \(TODO\.md\)\s*$", re.MULTILINE)
_TOKEN_BUDGETS_HEADING_RE = re.compile(r"^### Token budgets\s*$", re.MULTILINE)
_FORMAT_CONTRACTS_HEADING_RE = re.compile(r"^### Format contracts\s*$", re.MULTILINE)

# Regex for a markdown table row: pipe-delimited cells.
_TABLE_ROW_RE = re.compile(r"^\|.+\|$")
# Regex to extract bold-wrapped text: **value**
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
# Regex to strip number from budget string like "≤3,000 words".
_BUDGET_NUMBER_RE = re.compile(r"[\d,]+")
# Regex for heading pattern derivation: ## Name → N var format
_HEADING_N_RE = re.compile(r"## (\S+?)\s+N(?:\b|·|\s|,)")


def parse_markdown_table(text_block: str) -> list[dict[str, str]]:
    """Parse a markdown table block into a list of dicts.

    Returns empty list if the text block contains no valid table.
    Handles empty rows and whitespace-only cells gracefully.
    """
    lines = text_block.strip().splitlines()
    table_lines: list[str] = []
    in_table = False
    for line in lines:
        if _TABLE_ROW_RE.match(line):
            in_table = True
            table_lines.append(line)
        elif in_table:
            break  # Table ended at first non-table line

    if len(table_lines) < 3:
        return []  # Need header + separator + at least one row

    def _split_cells(row: str) -> list[str]:
        cells = [c.strip() for c in row.split("|")]
        # Remove leading/trailing empty cells from pipe prefix/suffix
        if cells and cells[0] == "":
            cells = cells[1:]
        if cells and cells[-1] == "":
            cells = cells[:-1]
        return cells

    headers = _split_cells(table_lines[0])
    # Skip separator line (table_lines[1])

    if not headers or all(h == "" for h in headers):
        return []

    rows: list[dict[str, str]] = []
    for line in table_lines[2:]:
        cells = _split_cells(line)
        if not cells or all(c == "" for c in cells):
            continue  # Skip empty rows
        row: dict[str, str] = {}
        for i, cell in enumerate(cells):
            if i >= len(headers):
                break
            key = headers[i]
            # Strip bold markers for value extraction
            cell = _BOLD_RE.sub(r"\1", cell)
            row[key] = cell
        if row:  # Only add non-empty rows
            rows.append(row)
    return rows


def _parse_severity_mappings(spec_text: str) -> dict[str, str]:
    """Parse §2 Issue severity table for glyph mappings."""
    m = _ISSUE_SEVERITY_HEADING_RE.search(spec_text)
    if not m:
        return {}
    block = spec_text[m.end():]
    rows = parse_markdown_table(block)
    mappings: dict[str, str] = {}
    for row in rows:
        level = row.get("Level", "").strip()
        glyph = row.get("Glyph", "").strip()
        if level and glyph:
            mappings[level] = glyph
    return mappings


_BUDGET_FALLBACKS: dict[str, int] = {
    "DECISIONS.md": 5000,
    "TODO.md": 5000,
    "CHANGELOG.md": 5000,
}


def _parse_token_budgets(spec_text: str) -> dict[str, int]:
    """Parse §4 Token budgets table for full-file budget entries."""
    m = _TOKEN_BUDGETS_HEADING_RE.search(spec_text)
    if not m:
        return {}
    block = spec_text[m.end():]
    rows = parse_markdown_table(block)
    budgets: dict[str, int] = {}
    for row in rows:
        scope = row.get("Scope", "").strip()
        if scope.lower() != "full file":
            continue
        artifact = row.get("Artifact", "").strip()
        budget_str = row.get("Budget", "").strip()
        if not artifact:
            continue
        num_match = _BUDGET_NUMBER_RE.search(budget_str)
        if num_match:
            value = int(num_match.group().replace(",", ""))
            budgets[artifact] = value
    # Add fallback budgets for artifacts without explicit Full file entries.
    for artifact, value in _BUDGET_FALLBACKS.items():
        if artifact not in budgets:
            budgets[artifact] = value
    return budgets


def _derive_heading_patterns(artifact: str, structural: str) -> list[str]:
    """Derive required heading regex patterns from the artifact name
    and its Key structural elements description.
    """
    patterns: list[str] = []
    name = artifact.replace(".md", "").capitalize()

    if artifact == "VISION.md":
        patterns.append(r"^#\s+\S")
    elif artifact == "TODO.md":
        patterns.append(r"^# TODO")
    elif artifact == "OBJECTIVE.md":
        return [
            r"^# Objective",
            r"^## Metric",
            r"^## Target",
            r"^## Baseline",
            r"^## Constraints",
            r"^\*\*Status\*\*:",
        ]
    elif artifact == "EXPERIMENTS.md":
        return [r"^# Experiments", r"^(?:## Experiment \d+|## Closure\b)"]
    else:
        patterns.append(rf"^# {name}")

    # Derive a secondary sub-heading pattern from structural elements.
    sub_heading_match = _HEADING_N_RE.search(structural)
    if sub_heading_match:
        sub_name = sub_heading_match.group(1)
        patterns.append(rf"^## {sub_name} \d+")

    # Special case: PLAN.md has ### Task N pattern
    if artifact == "PLAN.md":
        patterns = [r"^# Plan", r"(?:^## Tasks|^### Task \d+)"]
    # Special case: PROGRESS.md has optional glyph prefix
    if artifact == "PROGRESS.md":
        patterns = [r"^# Progress", r"^(?:\u25a0\s*)?## Cycle \d+"]

    return patterns


def _parse_format_contracts(spec_text: str) -> tuple[dict[str, str], dict[str, list[str]]]:
    """Parse §4 Format contracts table for default paths and heading patterns."""
    m = _FORMAT_CONTRACTS_HEADING_RE.search(spec_text)
    if not m:
        return {}, {}
    block = spec_text[m.end():]
    rows = parse_markdown_table(block)
    paths: dict[str, str] = {}
    headings: dict[str, list[str]] = {}
    for row in rows:
        artifact = row.get("Artifact", "").strip()
        path = row.get("Path", "").strip()
        structural = row.get("Key structural elements", "").strip()
        if not artifact:
            continue
        if path:
            paths[artifact] = path
        if structural and artifact in {
            "VISION.md", "TODO.md", "HEALTH.md", "PLAN.md",
            "DECISIONS.md", "PROGRESS.md", "OBJECTIVE.md",
            "EXPERIMENTS.md",
        }:
            patterns = _derive_heading_patterns(artifact, structural)
            if patterns:
                headings[artifact] = patterns
    return paths, headings


def _derive_todo_severity_headings(severity_mappings: dict[str, str]) -> list[str]:
    """Derive TODO.md severity heading regexes from the severity mappings."""
    headings: list[str] = []
    for level in severity_mappings:
        headings.append(rf"^## .*{level.capitalize()}")
    return headings


def generate_schema_data(spec_text: str) -> dict:
    """Parse SPEC.md tables and return the structured contracts dict.

    The returned dict matches the contracts.json schema:
    generated_at, spec_sha256, token_budgets, artifact_headings,
    severity_mappings, default_paths, todo_severity_headings.
    """
    spec_hash = compute_spec_hash(spec_text)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    severity_mappings = _parse_severity_mappings(spec_text)
    token_budgets = _parse_token_budgets(spec_text)
    default_paths, artifact_headings = _parse_format_contracts(spec_text)
    todo_severity_headings = _derive_todo_severity_headings(severity_mappings)

    return {
        "generated_at": timestamp,
        "spec_sha256": spec_hash,
        "token_budgets": token_budgets,
        "artifact_headings": artifact_headings,
        "severity_mappings": severity_mappings,
        "default_paths": default_paths,
        "todo_severity_headings": todo_severity_headings,
    }


def write_schema(spec_text: str) -> Path:
    """Generate contracts.json from SPEC.md and write it to scripts/schemas/."""
    data = generate_schema_data(spec_text)
    SCHEMAS_DIR.mkdir(parents=True, exist_ok=True)
    json_text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    CONTRACTS_JSON.write_text(json_text, encoding="utf-8")
    return CONTRACTS_JSON


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def get_all_skill_names() -> list[str]:
    """Return sorted list of skill directory names."""
    return sorted(
        d.name for d in SKILLS_DIR.iterdir() if d.is_dir() and (d / "SKILL.md").exists()
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate per-skill contract files.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify existing files are current; exit 1 if any are stale.",
    )
    parser.add_argument(
        "--skill",
        type=str,
        default=None,
        help="Generate for a single skill only.",
    )
    parser.add_argument(
        "--schema",
        action="store_true",
        help="Parse SPEC.md tables and write scripts/schemas/contracts.json.",
    )
    args = parser.parse_args()

    if not SPEC_PATH.exists():
        print(
            _red(f"ERROR: {SPEC_PATH.relative_to(REPO_ROOT)} not found"),
            file=sys.stderr,
        )
        return 1

    spec_text = SPEC_PATH.read_text(encoding="utf-8")
    sections = parse_spec_sections(spec_text)
    spec_hash = compute_spec_hash(spec_text)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    if not sections:
        print(
            _red("ERROR: No sections found in SPEC.md"),
            file=sys.stderr,
        )
        return 1

    # Determine which skills to process.
    if args.skill:
        skill_dir = SKILLS_DIR / args.skill
        if not skill_dir.exists():
            print(
                _red(
                    f"ERROR: Skill '{args.skill}' not found in {SKILLS_DIR.relative_to(REPO_ROOT)}/"
                ),
                file=sys.stderr,
            )
            return 1
        skill_names = [args.skill]
    else:
        skill_names = get_all_skill_names()

    # Schema generation mode (parse SPEC.md tables to JSON).
    if args.schema:
        data = generate_schema_data(spec_text)
        SCHEMAS_DIR.mkdir(parents=True, exist_ok=True)
        json_text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
        CONTRACTS_JSON.write_text(json_text, encoding="utf-8")
        print(
            _green(f"WROTE  {CONTRACTS_JSON.relative_to(REPO_ROOT)}"),
        )
        print(f"  Token budgets: {len(data['token_budgets'])} artifacts")
        print(f"  Heading patterns: {len(data['artifact_headings'])} artifacts")
        print(f"  Severity mappings: {len(data['severity_mappings'])} levels")
        print(f"  Default paths: {len(data['default_paths'])} artifacts")
        return 0

    # Check mode.
    if args.check:
        stale = check_freshness(skill_names, sections, spec_hash, timestamp)
        if stale:
            print(_red(f"Stale contract files: {', '.join(stale)}"))
            return 1
        print(_green(f"All contract files are current ({len(skill_names)} checked)."))
        return 0

    # Generation mode.
    generated = 0
    skipped = 0
    errors = 0
    for name in skill_names:
        content = generate_for_skill(name, sections, spec_hash, timestamp)
        if content is None:
            skipped += 1
            continue
        out_path = write_context_file(name, content)
        print(
            _green(f"WROTE  {out_path.relative_to(REPO_ROOT)}"),
        )
        generated += 1

    print(f"\n---")
    print(f"Generated: {generated}, Skipped: {skipped}, Errors: {errors}")

    return 1 if errors > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
