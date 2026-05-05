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
_SEQUENCE_KEYS_BY_ARTIFACT = {
    "decisions": {"DECISION": "decisions"},
    "docs": {"MAPPING": "mapping", "INDEX": "index", "AUDIT_LOG": "audit_log"},
    "experiments": {"EXPERIMENT": "experiments"},
    "plan": {"TASK": "tasks"},
    "progress": {"CYCLE": "cycles"},
    "session": {"BOOKMARK": "bookmarks"},
    "vision": {"PERSONA": "personas", "PRINCIPLE": "principles"},
}
_NESTED_SEQUENCE_KEYS = {
    ("DECISION", "ALTERNATIVE"): "alternatives",
}


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


def _is_empty_required(value: object) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, dict)):
        return not value
    return False


def _iter_group_entries(schema: dict, group: str):
    gv = schema.get(group, {})
    if not isinstance(gv, dict):
        return
    for entry in gv.values():
        if isinstance(entry, dict) and "field" in entry:
            yield entry


def _validate_field(
    violations: list[str],
    name: str,
    scope: dict,
    field: str,
    path: str,
) -> None:
    if field not in scope:
        violations.append(f"{name}: missing required field '{path}.{field}'")
    elif _is_empty_required(scope[field]):
        violations.append(f"{name}: empty required field '{path}.{field}'")


def _validate_required_fields(
    violations: list[str],
    name: str,
    schema: dict,
    group: str,
    scope: dict,
    path: str,
) -> None:
    for entry in _iter_group_entries(schema, group):
        field = entry.get("field")
        if entry.get("parent") or field == "entry" or not entry.get("required"):
            continue
        _validate_field(violations, name, scope, field, path)
        value = scope.get(field)
        if isinstance(value, dict):
            for child in entry.get("children", []):
                if (
                    isinstance(child, dict)
                    and child.get("required")
                    and child.get("field")
                ):
                    _validate_field(
                        violations,
                        name,
                        value,
                        child["field"],
                        f"{path}.{field}",
                    )


def _entry_min_count(schema: dict, group: str) -> int | None:
    for entry in _iter_group_entries(schema, group):
        if entry.get("field") == "entry" and entry.get("required"):
            return entry.get("min_count") or 1
    return None


def _parent_requirements(schema: dict, parent_group: str) -> dict[str, list[str]]:
    requirements: dict[str, list[str]] = {}
    prefix = f"{parent_group}."
    for group in schema:
        if group in _SKIP_META:
            continue
        for entry in _iter_group_entries(schema, group):
            parent = entry.get("parent")
            if (
                isinstance(parent, str)
                and parent.startswith(prefix)
                and parent != f"{group}.entry"
                and entry.get("required")
                and entry.get("field")
            ):
                parent_field = parent.removeprefix(prefix)
                requirements.setdefault(parent_field, []).append(entry["field"])
    return requirements


def _entry_requirements(schema: dict, group: str) -> list[str]:
    parent = f"{group}.entry"
    return [
        entry["field"]
        for entry in _iter_group_entries(schema, group)
        if entry.get("parent") == parent
        and entry.get("required")
        and entry.get("field")
    ]


def _validate_sequences(
    data: dict,
    schema: dict,
    name: str,
    violations: list[str],
) -> None:
    for group, key in _SEQUENCE_KEYS_BY_ARTIFACT.get(name, {}).items():
        seq = data.get(key)
        if seq is None:
            continue
        if not isinstance(seq, list):
            violations.append(f"{name}: '{key}' must be a list")
            continue
        if not seq:
            violations.append(f"{name}: '{key}' requires at least 1 entry")
            continue
        child_requirements = _parent_requirements(schema, group)
        for index, item in enumerate(seq):
            path = f"{key}[{index}]"
            if not isinstance(item, dict):
                violations.append(f"{name}: '{path}' must be a mapping")
                continue
            _validate_required_fields(violations, name, schema, group, item, path)
            for parent_field, child_fields in child_requirements.items():
                child_scope = item.get(parent_field)
                if not isinstance(child_scope, dict):
                    continue
                for child_field in child_fields:
                    _validate_field(
                        violations,
                        name,
                        child_scope,
                        child_field,
                        f"{path}.{parent_field}",
                    )
            for (parent_group, child_group), child_key in _NESTED_SEQUENCE_KEYS.items():
                if parent_group != group:
                    continue
                child_seq = item.get(child_key)
                min_count = _entry_min_count(schema, child_group)
                if min_count and (
                    not isinstance(child_seq, list) or len(child_seq) < min_count
                ):
                    violations.append(
                        f"{name}: '{path}.{child_key}' requires at least "
                        f"{min_count} entry"
                    )
                    continue
                if not isinstance(child_seq, list):
                    continue
                required = _entry_requirements(schema, child_group)
                for child_index, child in enumerate(child_seq):
                    child_path = f"{path}.{child_key}[{child_index}]"
                    if not isinstance(child, dict):
                        violations.append(f"{name}: '{child_path}' must be a mapping")
                        continue
                    for field in required:
                        _validate_field(
                            violations, name, child, field, child_path
                        )


def _validate_decision_alternatives(data: dict, name: str) -> list[str]:
    violations: list[str] = []
    for index, decision in enumerate(data.get("decisions", [])):
        if not isinstance(decision, dict):
            continue
        alternatives = decision.get("alternatives", [])
        if not isinstance(alternatives, list):
            continue
        chosen = [
            alt
            for alt in alternatives
            if isinstance(alt, dict) and alt.get("status") == "chosen"
        ]
        if len(chosen) != 1:
            violations.append(
                f"{name}: 'decisions[{index}].alternatives' must have exactly "
                "one chosen entry"
            )
    return violations


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
            _validate_field(violations, name, scope, field, group_lower)
    _validate_sequences(data, schema, name, violations)
    if name == "decisions":
        violations.extend(_validate_decision_alternatives(data, name))
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
