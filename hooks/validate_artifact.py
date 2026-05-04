#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
# ///
"""PostToolUse validation hook for artifact writes.

Validates artifact writes against YAML schemas loaded from
skills/agentera/schemas/artifacts/ instead of hardcoded contracts.

Adapter formats:
    Claude Code: {tool_name: "Edit"|"Write", tool_input: {file_path, content}}
    OpenCode:    {tool: {name: ...}, input: {path, content}}
    Codex:       {tool_name: "apply_patch", tool_input: {path, patch}}
    Copilot:     {tool_name: ..., input: {filePath, content}}

Exit codes:
    0 = success or advisory warnings
    2 = blocking schema violation
"""

from __future__ import annotations

import json
import os
import re
import sys
import traceback
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMAS_DIR = REPO_ROOT / "skills" / "agentera" / "schemas" / "artifacts"

AGENT_FACING = {
    "PROGRESS.md", "DECISIONS.md", "PLAN.md", "HEALTH.md",
    "OBJECTIVE.md", "EXPERIMENTS.md", "DOCS.md", "SESSION.md",
}
HUMAN_FACING = {"TODO.md", "CHANGELOG.md", "DESIGN.md"}
PER_OBJECTIVE = {"OBJECTIVE.md", "EXPERIMENTS.md"}
_CODEX_FILE_HEADER = re.compile(
    r"^\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s+(.+?)\s*$",
    re.MULTILINE,
)
_schema_cache: dict[str, dict] | None = None


def load_schemas() -> dict[str, dict]:
    global _schema_cache
    if _schema_cache is not None:
        return _schema_cache
    schemas: dict[str, dict] = {}
    if not SCHEMAS_DIR.is_dir():
        print(f"validate_artifact: schemas dir not found: {SCHEMAS_DIR}", file=sys.stderr)
        _schema_cache = schemas
        return schemas
    for path in sorted(SCHEMAS_DIR.glob("*.yaml")):
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and "artifact" in data:
                schemas[data["artifact"]] = data
        except Exception as exc:
            print(f"validate_artifact: bad schema {path.name}: {exc}", file=sys.stderr)
    _schema_cache = schemas
    return schemas


def _identify_artifact(file_path: str, project_root: str) -> str | None:
    abs_path = Path(file_path).resolve()
    root = Path(project_root).resolve()
    try:
        rel = abs_path.relative_to(root)
    except ValueError:
        return None
    parts = rel.parts
    if len(parts) == 1 and parts[0] in HUMAN_FACING:
        return parts[0]
    if len(parts) == 2 and parts[0] == ".agentera" and parts[1] in AGENT_FACING:
        return parts[1]
    if (
        len(parts) == 4
        and parts[0] == ".agentera"
        and parts[1] == "optimera"
        and parts[2]
        and parts[3] in PER_OBJECTIVE
    ):
        return parts[3]
    return None


def _check_headings(content: str, patterns: list[dict]) -> list[str]:
    violations = []
    for spec in patterns:
        pat = spec.get("pattern", "")
        if pat and not re.search(pat, content, re.MULTILINE):
            violations.append(f"missing required heading matching /{pat}/")
    return violations


def _check_severity_headings(content: str, patterns: list[str]) -> list[str]:
    violations = []
    for pat in patterns:
        if not re.search(pat, content, re.MULTILINE):
            violations.append(f"missing severity section matching /{pat}/")
    return violations


def _check_decision_numbering(content: str) -> list[str]:
    violations = []
    active = re.split(r"^## Archived Decisions\b", content, maxsplit=1, flags=re.MULTILINE)[0]
    numbers = [
        int(m.group(1))
        for m in re.finditer(r"^## Decision\s+(\d+)\b", active, re.MULTILINE)
    ]
    all_numbers = [
        int(m.group(1) or m.group(2))
        for m in re.finditer(
            r"^## Decision\s+(\d+)\b|^- Decision\s+(\d+)\s+\(",
            content, re.MULTILINE,
        )
    ]
    seen: set[int] = set()
    dups: list[int] = []
    for n in all_numbers:
        if n in seen and n not in dups:
            dups.append(n)
        seen.add(n)
    if dups:
        violations.append(f"duplicate decision numbers: {', '.join(str(n) for n in dups)}")
    if numbers != sorted(numbers):
        violations.append("active decision numbers must be ascending")
    return violations


def _check_markdown_wellformed(content: str) -> list[str]:
    violations = []
    fences = len(re.findall(r"^```", content, re.MULTILINE))
    if fences % 2 != 0:
        violations.append("unclosed code fence (odd number of ``` lines)")
    return violations


def _check_token_budget(content: str, budget: int, name: str) -> list[str]:
    words = len(content.split())
    if words > budget:
        return [f"word count ({words}) exceeds budget ({budget})"]
    return []


def validate_content(content: str, artifact_name: str) -> list[str]:
    schemas = load_schemas()
    violations: list[str] = []
    schema = schemas.get(artifact_name)

    if artifact_name in HUMAN_FACING:
        violations.extend(_check_markdown_wellformed(content))
        if schema:
            patterns = schema.get("required_headings", [])
            if patterns:
                violations.extend(_check_headings(content, patterns))
            severity = schema.get("severity_headings", [])
            if severity:
                violations.extend(_check_severity_headings(content, [s["pattern"] for s in severity] if severity and isinstance(severity[0], dict) else severity))
            budget = schema.get("token_budget")
            if budget:
                violations.extend(_check_token_budget(content, budget, artifact_name))
        return violations

    if schema:
        patterns = schema.get("required_headings", [])
        violations.extend(_check_headings(content, patterns))
        budget = schema.get("token_budget")
        if budget:
            violations.extend(_check_token_budget(content, budget, artifact_name))
        custom = schema.get("custom_checks", [])
        if isinstance(custom, list):
            for check in custom:
                name = check.get("name", "") if isinstance(check, dict) else ""
                if name == "ascending_numbering":
                    violations.extend(_check_decision_numbering(content))
                    break
            for check in custom:
                name = check.get("name", "") if isinstance(check, dict) else ""
                if name == "no_duplicates":
                    dup_violations = _check_decision_numbering(content)
                    for v in dup_violations:
                        if "duplicate" in v and v not in violations:
                            violations.append(v)
                    break
        violations.extend(_check_markdown_wellformed(content))
    else:
        violations.extend(_check_markdown_wellformed(content))

    return violations


def _parse_stdin(data: dict) -> list[tuple[str, str | None]]:
    project_root = data.get("cwd", os.getcwd())
    results: list[tuple[str, str | None]] = []

    tool_input = data.get("tool_input") or {}
    tool_name = data.get("tool_name", "")

    is_opencode = isinstance(data.get("tool"), dict)
    if is_opencode:
        inp = data.get("input") or {}
        path = inp.get("path") or inp.get("file_path")
        content = inp.get("content")
        if path:
            abs_path = path if os.path.isabs(path) else str(Path(project_root) / path)
            results.append((abs_path, content))
            return results

    is_copilot = "input" in data and "tool_name" in data and not is_opencode
    if is_copilot and not ("tool_input" in data and isinstance(data["tool_input"], dict)):
        inp = data.get("input") or {}
        path = inp.get("filePath") or inp.get("path") or inp.get("file_path")
        content = inp.get("content")
        if path:
            abs_path = path if os.path.isabs(path) else str(Path(project_root) / path)
            return [(abs_path, content)]
        return []

    is_codex = tool_name == "apply_patch" and isinstance(tool_input, dict)
    if is_codex:
        command = tool_input.get("command", "") or tool_input.get("patch", "")
        paths = [m.group(1).strip() for m in _CODEX_FILE_HEADER.finditer(command)]
        for p in paths:
            abs_p = p if os.path.isabs(p) else str(Path(project_root) / p)
            results.append((abs_p, None))
        return results

    if isinstance(tool_input, dict):
        file_path = tool_input.get("file_path")
        content = tool_input.get("content")
        if file_path:
            abs_path = file_path if os.path.isabs(file_path) else str(Path(project_root) / file_path)
            results.append((abs_path, content))

    return results


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return 0
        data = json.loads(raw)
    except (json.JSONDecodeError, KeyError):
        return 0

    if not isinstance(data, dict):
        return 0

    project_root = data.get("cwd", os.getcwd())
    file_entries = _parse_stdin(data)
    if not file_entries:
        return 0

    all_violations: list[str] = []
    for file_path, candidate_content in file_entries:
        artifact_name = _identify_artifact(file_path, str(project_root))
        if artifact_name is None:
            continue

        if candidate_content is not None:
            content = candidate_content
        else:
            try:
                content = Path(file_path).read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as exc:
                all_violations.append(f"{artifact_name}: cannot read: {exc}")
                continue

        violations = validate_content(content, artifact_name)
        for v in violations:
            all_violations.append(f"{artifact_name}: {v}")

    if not all_violations:
        return 0

    message = "Artifact validation warnings:\n" + "\n".join(
        f"  - {v}" for v in all_violations
    )
    print(message)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.exit(0)
