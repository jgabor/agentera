#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
# ///
"""PostToolUse validation hook for artifact writes (v2 schema-backed).

Reads stdin JSON, routes to the matching adapter parser, validates
content against YAML schemas from skills/agentera/schemas/artifacts/.

Exit codes:
    0 = pass (no violations or no artifact matched)
    2 = violation found (details on stderr)
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

_AGENT_YAML_RE = re.compile(r"\.agentera/([a-z_]+)\.yaml$")
_HUMAN_FACING = {"TODO.md", "CHANGELOG.md", "DESIGN.md"}

_schema_cache: dict[str, dict | None] = {}


def _load_schema(name: str) -> dict | None:
    if name not in _schema_cache:
        path = SCHEMAS_DIR / f"{name}.yaml"
        if path.is_file():
            with open(path) as f:
                _schema_cache[name] = yaml.safe_load(f)
        else:
            _schema_cache[name] = None
    return _schema_cache[name]


# ── Adapter parsers ────────────────────────────────────────────────


def _parse_claude(data: dict) -> tuple[str, str | None] | None:
    ti = data.get("tool_input")
    if not isinstance(ti, dict):
        return None
    fp = ti.get("file_path")
    if fp:
        return str(fp), ti.get("content")
    return None


def _parse_opencode(data: dict) -> tuple[str, str | None] | None:
    inp = data.get("input")
    if not isinstance(inp, dict):
        return None
    fp = inp.get("path")
    if fp:
        return str(fp), inp.get("content")
    return None


def _parse_codex(data: dict) -> tuple[str, str | None] | None:
    ti = data.get("tool_input")
    if not isinstance(ti, dict):
        return None
    fp = ti.get("path")
    patch_body = ti.get("patch") or ti.get("command", "")
    if fp:
        return str(fp), None
    if isinstance(patch_body, str):
        headers = re.findall(
            r"^\*\*\*\s+(?:Add File|Update File):\s+(.+?)\s*$",
            patch_body,
            re.MULTILINE,
        )
        if headers:
            return headers[0], None
    return None


def _parse_copilot(data: dict) -> tuple[str, str | None] | None:
    inp = data.get("input")
    if not isinstance(inp, dict):
        return None
    fp = inp.get("filePath") or inp.get("file_path")
    if fp:
        return str(fp), inp.get("content")
    return None


def _route(data: dict) -> tuple[str, str | None] | None:
    tn = data.get("tool_name", "")
    if tn == "apply_patch":
        r = _parse_codex(data)
        if r:
            return r
    if tn in ("Edit", "Write") or (
        "tool_input" in data
        and isinstance(data.get("tool_input"), dict)
        and "file_path" in data["tool_input"]
    ):
        r = _parse_claude(data)
        if r:
            return r
    if isinstance(data.get("input"), dict):
        inp = data["input"]
        if "filePath" in inp or "file_path" in inp:
            return _parse_copilot(data)
        if "path" in inp:
            return _parse_opencode(data)
    return None


# ── Validation ─────────────────────────────────────────────────────


_SKIP_META = {"meta", "GROUP_PREFIXES", "BUDGET", "COMPACTION", "VALIDATION"}
_LIST_INDICATORS = {"number", "entry", "summary"}


def _collect_required(schema: dict) -> list[tuple[str, list[str]]]:
    """Return [(group_lower, [required_field_names])] for singleton groups."""
    result: list[tuple[str, list[str]]] = []
    for gk, gv in schema.items():
        if gk in _SKIP_META or not isinstance(gv, dict):
            continue
        is_list_or_sub = False
        for _, e in gv.items():
            if isinstance(e, dict):
                if e.get("field") in _LIST_INDICATORS or e.get("parent"):
                    is_list_or_sub = True
                    break
        if is_list_or_sub:
            continue
        fields: list[str] = []
        for _, e in gv.items():
            if isinstance(e, dict) and e.get("required") and "field" in e:
                fields.append(e["field"])
        if fields:
            result.append((gk.lower(), fields))
    return result


def _validate_yaml(content: str, schema: dict, name: str) -> list[str]:
    violations: list[str] = []
    try:
        data = yaml.safe_load(content)
    except yaml.YAMLError as exc:
        return [f"{name}: invalid YAML: {exc}"]
    if not isinstance(data, dict):
        return [f"{name}: root must be a mapping"]
    for group_lower, fields in _collect_required(schema):
        if group_lower in data and isinstance(data[group_lower], dict):
            scope = data[group_lower]
        elif any(f in data for f in fields):
            scope = data
        else:
            continue
        for field in fields:
            if field not in scope:
                violations.append(f"{name}: missing required field '{field}'")
    for _, be in schema.get("BUDGET", {}).items():
        if not isinstance(be, dict):
            continue
        mw = be.get("max_words")
        scope = be.get("scope") or ""
        if mw and "full_file" in scope:
            wc = len(content.split())
            if wc > mw:
                violations.append(f"{name}: word count ({wc}) exceeds budget ({mw})")
    for _, ve in schema.get("VALIDATION", {}).items():
        if not isinstance(ve, dict):
            continue
        rule = ve.get("rule", "")
        if "unique" in rule and "number" in rule and ve.get("severity") == "error":
            for key, val in data.items():
                if isinstance(val, list):
                    nums = [
                        e["number"]
                        for e in val
                        if isinstance(e, dict) and "number" in e
                    ]
                    if nums:
                        if len(nums) != len(set(nums)):
                            violations.append(f"{name}: duplicate numbers in '{key}'")
                        if nums != sorted(nums):
                            violations.append(f"{name}: '{key}' not in ascending order")
    return violations


def _validate_md(content: str, name: str) -> list[str]:
    violations: list[str] = []
    if not content.strip():
        violations.append(f"{name}: empty content")
    fences = len(re.findall(r"^```", content, re.MULTILINE))
    if fences % 2:
        violations.append(f"{name}: unclosed code fence")
    return violations


# ── Main ───────────────────────────────────────────────────────────


def _resolve(fp: str, cwd: str) -> str:
    return fp if os.path.isabs(fp) else str(Path(cwd) / fp)


def _read_if_needed(content: str | None, abs_path: str) -> str | None:
    if content is not None:
        return content
    try:
        return Path(abs_path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


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

    cwd = data.get("cwd", os.getcwd())
    routed = _route(data)
    if routed is None:
        return 0

    file_path, content = routed
    abs_path = _resolve(file_path, cwd)
    rel = os.path.relpath(abs_path, cwd).replace("\\", "/")
    basename = os.path.basename(abs_path)

    m = _AGENT_YAML_RE.search(rel)
    if m:
        schema = _load_schema(m.group(1))
        if schema is None:
            return 0
        content = _read_if_needed(content, abs_path)
        if content is None:
            return 0
        violations = _validate_yaml(content, schema, m.group(1))
        if violations:
            for v in violations:
                print(v, file=sys.stderr)
            return 2
        return 0

    if basename in _HUMAN_FACING:
        content = _read_if_needed(content, abs_path)
        if content is None:
            return 0
        violations = _validate_md(content, basename)
        if violations:
            for v in violations:
                print(v, file=sys.stderr)
            return 2
        return 0

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.exit(0)
