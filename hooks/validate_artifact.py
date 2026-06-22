#!/usr/bin/env -S uv run --script
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

import importlib.util
import argparse
import json
import os
import re
import subprocess
import sys
import traceback
from pathlib import Path

import yaml

# Ensure hooks/ is on sys.path so common.py can be imported when this module
# is loaded via importlib (e.g., from test fixtures).
_hooks_dir = str(Path(__file__).resolve().parent)
if _hooks_dir not in sys.path:
    sys.path.insert(0, _hooks_dir)

from common import (
    DEFAULT_ARTIFACT_PATHS as _DEFAULT_ARTIFACT_PATHS,
    load_yaml_mapping,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMAS_DIR = REPO_ROOT / "skills" / "agentera" / "schemas" / "artifacts"

_AGENT_YAML_RE = re.compile(r"\.agentera/([a-z_]+)\.yaml$")
_HUMAN_FACING = {"TODO.md", "CHANGELOG.md", "DESIGN.md"}
_HUMAN_FACING_SCHEMA_NAMES = {
    "TODO.md": "todo",
    "CHANGELOG.md": "changelog",
    "DESIGN.md": "design",
}
_COMPACTION_MODULE = None

_CANONICAL_SCHEMA_NAMES = {
    "DECISIONS.md": "decisions",
    "DOCS.md": "docs",
    "EXPERIMENTS.md": "experiments",
    "HEALTH.md": "health",
    "PLAN.md": "plan",
    "PROGRESS.md": "progress",
    "VISION.md": "vision",
}

_ARTIFACT_BY_SCHEMA_NAME = {schema: artifact for artifact, schema in _CANONICAL_SCHEMA_NAMES.items()}


def _load_compaction_module():
    global _COMPACTION_MODULE
    if _COMPACTION_MODULE is not None:
        return _COMPACTION_MODULE
    module_path = REPO_ROOT / "hooks" / "compaction.py"
    spec = importlib.util.spec_from_file_location("agentera_compaction", module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    _COMPACTION_MODULE = module
    return module


def _compact_after_valid_write(artifact: str, abs_path: str) -> list[str]:
    if not os.path.exists(abs_path):
        return []
    try:
        compaction = _load_compaction_module()
        if artifact == "TODO.md":
            compaction.compact_file(Path(abs_path), "todo-resolved")
        elif artifact in compaction.COMPACTABLE_YAML_ARTIFACTS:
            compaction.compact_yaml_file(Path(abs_path), artifact)
        else:
            return []
    except Exception as exc:
        return [f"{artifact}: compaction failed: {exc}"]
    return []


# ── Runtime event parsing ──────────────────────────────────────────


class ArtifactWrite:
    __slots__ = ("file_path", "content")

    def __init__(self, file_path: str, content: str | None = None):
        self.file_path = file_path
        self.content = content

    def __eq__(self, other: object) -> bool:
        return (
            isinstance(other, ArtifactWrite)
            and self.file_path == other.file_path
            and self.content == other.content
        )

    def __repr__(self) -> str:
        return f"ArtifactWrite(file_path={self.file_path!r}, content={self.content!r})"


class RuntimeEventParser:
    """Parse supported runtime hook payloads into artifact write candidates."""

    def parse_claude(self, data: dict) -> ArtifactWrite | None:
        ti = data.get("tool_input")
        if not isinstance(ti, dict):
            return None
        fp = ti.get("file_path")
        if fp:
            return ArtifactWrite(str(fp), ti.get("content"))
        return None

    def parse_opencode(self, data: dict) -> ArtifactWrite | None:
        inp = data.get("input")
        if not isinstance(inp, dict):
            return None
        fp = inp.get("path")
        if fp:
            return ArtifactWrite(str(fp), inp.get("content"))
        return None

    def parse_codex(self, data: dict) -> ArtifactWrite | None:
        ti = data.get("tool_input")
        if not isinstance(ti, dict):
            return None
        fp = ti.get("path")
        patch_body = ti.get("patch") or ti.get("command", "")
        if fp:
            return ArtifactWrite(str(fp))
        if isinstance(patch_body, str):
            headers = re.findall(
                r"^\*\*\*\s+(?:Add File|Update File):\s+(.+?)\s*$",
                patch_body,
                re.MULTILINE,
            )
            if headers:
                return ArtifactWrite(headers[0])
        return None

    def parse_copilot(self, data: dict) -> ArtifactWrite | None:
        inp = data.get("input")
        if not isinstance(inp, dict):
            return None
        fp = inp.get("filePath") or inp.get("file_path")
        if fp:
            return ArtifactWrite(str(fp), inp.get("content"))
        return None

    def parse(self, data: dict) -> ArtifactWrite | None:
        tn = data.get("tool_name", "")
        if tn == "apply_patch":
            candidate = self.parse_codex(data)
            if candidate:
                return candidate
        if tn in ("Edit", "Write") or (
            "tool_input" in data
            and isinstance(data.get("tool_input"), dict)
            and "file_path" in data["tool_input"]
        ):
            candidate = self.parse_claude(data)
            if candidate:
                return candidate
        if isinstance(data.get("input"), dict):
            inp = data["input"]
            if "filePath" in inp or "file_path" in inp:
                return self.parse_copilot(data)
            if "path" in inp:
                return self.parse_opencode(data)
        return None


# ── Validation ─────────────────────────────────────────────────────


_SKIP_META = {"meta", "GROUP_PREFIXES", "BUDGET", "COMPACTION", "VALIDATION", "CONVENTION"}
_LIST_INDICATORS = {"number", "entry", "summary"}
_SEQUENCE_KEYS_BY_ARTIFACT = {
    "decisions": {"DECISION": "decisions", "ARCHIVE": "archive"},
    "docs": {"MAPPING": "mapping", "INDEX": "index", "AUDIT_LOG": "audit_log"},
    "experiments": {"EXPERIMENT": "experiments", "ARCHIVE": "archive"},
    "plan": {"TASK": "tasks"},
    "progress": {"CYCLE": "cycles", "ARCHIVE": "archive"},
    "session": {"BOOKMARK": "bookmarks"},
    "vision": {"PERSONA": "personas", "PRINCIPLE": "principles"},
}
_NESTED_SEQUENCE_KEYS = {
    ("DECISION", "ALTERNATIVE"): "alternatives",
}
_SEQUENCE_ORDER_BY_ARTIFACT = {
    ("progress", "cycles"): "descending",
}


def _collect_required(schema: dict) -> list[tuple[str, list[str]]]:
    """Return [(group_lower, [required_field_names])] for singleton groups."""
    return [
        (group_lower, fields)
        for _, group_lower, fields in _collect_singleton_groups(schema)
    ]


def _collect_singleton_groups(schema: dict) -> list[tuple[str, str, list[str]]]:
    """Return [(GROUP, group_lower, [required_field_names])] for singleton groups."""
    result: list[tuple[str, str, list[str]]] = []
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
            result.append((gk, gk.lower(), fields))
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
    full_path = f"{path}.{field}" if path else field
    if field not in scope:
        violations.append(f"{name}: missing required field '{full_path}'")
    elif _is_empty_required(scope[field]):
        violations.append(f"{name}: empty required field '{full_path}'")


def _allowed_values(entry: dict) -> list[str]:
    for rule in entry.get("validation", []):
        if isinstance(rule, str) and rule.startswith("Must be one of: "):
            return [value.strip() for value in rule.removeprefix("Must be one of: ").split(",")]
    return []


def _validate_allowed_value(
    violations: list[str],
    name: str,
    scope: dict,
    entry: dict,
    path: str,
) -> None:
    field = entry.get("field")
    allowed = _allowed_values(entry)
    if not field or not allowed or field not in scope or _is_empty_required(scope[field]):
        return
    value = scope[field]
    if isinstance(value, str) and value not in allowed:
        violations.append(
            f"{name}: invalid value '{value}' for '{path}.{field}' "
            f"(expected one of: {', '.join(allowed)})"
        )


def _validate_field_type(
    violations: list[str],
    name: str,
    scope: dict,
    entry: dict,
    path: str,
) -> bool:
    field = entry.get("field")
    if not field or field not in scope:
        return True
    value = scope[field]
    expected_type = entry.get("type")
    if not expected_type or _is_empty_required(value):
        return True
    full_path = f"{path}.{field}" if path else field
    is_valid = True
    if expected_type == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            violations.append(f"{name}: '{full_path}' must be an integer, got {type(value).__name__}")
            is_valid = False
    elif expected_type == "string":
        if not isinstance(value, str):
            violations.append(f"{name}: '{full_path}' must be a string, got {type(value).__name__}")
            is_valid = False
    elif expected_type == "map":
        if not isinstance(value, dict):
            violations.append(f"{name}: '{full_path}' must be a mapping, got {type(value).__name__}")
            is_valid = False
    elif expected_type == "list[string]":
        if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
            violations.append(f"{name}: '{full_path}' must be a list of strings")
            is_valid = False
    elif expected_type == "list[map]":
        if not isinstance(value, list) or not all(isinstance(x, dict) for x in value):
            violations.append(f"{name}: '{full_path}' must be a list of mappings")
            is_valid = False
    return is_valid


def _validate_field_constraints(
    violations: list[str],
    name: str,
    scope: dict,
    entry: dict,
    path: str,
) -> None:
    field = entry.get("field")
    if not field or field not in scope:
        return
    value = scope[field]
    for rule in entry.get("validation", []):
        if not isinstance(rule, str):
            continue
        if rule == "Must be a positive integer":
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                full_path = f"{path}.{field}" if path else field
                violations.append(
                    f"{name}: '{full_path}' must be a positive integer"
                )


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
        if entry.get("parent") or field == "entry":
            continue
        if entry.get("required"):
            _validate_field(violations, name, scope, field, path)
        if field in scope and not _is_empty_required(scope[field]):
            if _validate_field_type(violations, name, scope, entry, path):
                _validate_allowed_value(violations, name, scope, entry, path)
                _validate_field_constraints(violations, name, scope, entry, path)
        value = scope.get(field)
        if isinstance(value, dict):
            for child in entry.get("children", []):
                if (
                    isinstance(child, dict)
                    and child.get("field")
                ):
                    child_field = child["field"]
                    child_path = f"{path}.{field}" if path else field
                    if child.get("required"):
                        _validate_field(violations, name, value, child_field, child_path)
                    if child_field in value and not _is_empty_required(value[child_field]):
                        if _validate_field_type(violations, name, value, child, child_path):
                            _validate_allowed_value(violations, name, value, child, child_path)
                            _validate_field_constraints(violations, name, value, child, child_path)


def _validate_singleton_group(
    violations: list[str],
    name: str,
    schema: dict,
    group: str,
    scope: dict,
    path: str,
) -> None:
    for entry in _iter_group_entries(schema, group):
        field = entry.get("field")
        if entry.get("parent") or field == "entry":
            continue
        if entry.get("required"):
            _validate_field(violations, name, scope, field, path)
        if field in scope and not _is_empty_required(scope[field]):
            if _validate_field_type(violations, name, scope, entry, path):
                _validate_allowed_value(violations, name, scope, entry, path)
                _validate_field_constraints(violations, name, scope, entry, path)


def _schema_field_names(schema: dict, group: str) -> set[str]:
    return {
        entry["field"]
        for entry in _iter_group_entries(schema, group)
        if entry.get("field")
        and not entry.get("parent")
        and entry.get("field") != "entry"
    }


def _validate_unknown_fields(
    violations: list[str],
    name: str,
    scope: dict,
    allowed: set[str],
    path: str,
) -> None:
    for field in scope:
        if field not in allowed:
            full_path = f"{path}.{field}" if path else field
            violations.append(f"{name}: unsupported field '{full_path}'")


def _validate_plan_known_fields(data: dict, schema: dict, violations: list[str]) -> None:
    grouped_scopes = {"header": "HEADER", "scope": "SCOPE"}
    sequence_keys = set(_SEQUENCE_KEYS_BY_ARTIFACT.get("plan", {}).values())
    allowed_top_level = (
        _schema_field_names(schema, "PLAN")
        | set(grouped_scopes)
        | sequence_keys
    )
    _validate_unknown_fields(violations, "plan", data, allowed_top_level, "")
    for key, group in grouped_scopes.items():
        scope = data.get(key)
        if isinstance(scope, dict):
            _validate_unknown_fields(
                violations,
                "plan",
                scope,
                _schema_field_names(schema, group),
                key,
            )


def _validate_full_plan_contract(data: dict, violations: list[str]) -> None:
    header = data.get("header") if isinstance(data.get("header"), dict) else {}
    if str(header.get("level", "")).lower() != "full":
        return

    for field in ("reviewed", "critic_issues"):
        _validate_field(violations, "plan", header, field, "header")
    _validate_field(violations, "plan", data, "design", "")

    critic_issues = header.get("critic_issues")
    if not _is_empty_required(critic_issues):
        match = re.fullmatch(
            r"\s*(\d+)\s+found,\s*(\d+)\s+addressed,\s*(\d+)\s+dismissed\s*",
            str(critic_issues),
        )
        if not match:
            violations.append(
                "plan: header.critic_issues must match "
                "'N found, M addressed, K dismissed'"
            )
        else:
            found, addressed, dismissed = (int(value) for value in match.groups())
            if found < 1:
                violations.append("plan: header.critic_issues must record at least 1 found issue")
            if addressed + dismissed != found:
                violations.append(
                    "plan: header.critic_issues counts must satisfy "
                    "addressed + dismissed == found"
                )

    tasks = data.get("tasks")
    if not isinstance(tasks, list):
        return
    for index, task in enumerate(tasks):
        if not isinstance(task, dict):
            continue
        _validate_field(violations, "plan", task, "acceptance", f"tasks[{index}]")


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


def _validate_decision_satisfaction(data: dict, name: str) -> list[str]:
    violations: list[str] = []
    allowed_states = {"open", "provisionally_satisfied", "user_confirmed_satisfied"}
    entries: list[tuple[str, object]] = [
        (f"decisions[{index}]", decision)
        for index, decision in enumerate(data.get("decisions", []))
    ] + [
        (f"archive[{index}]", decision)
        for index, decision in enumerate(data.get("archive", []))
    ]
    for entry_path, decision in entries:
        if not isinstance(decision, dict) or "satisfaction" not in decision:
            continue
        path = f"{entry_path}.satisfaction"
        satisfaction = decision.get("satisfaction")
        if not isinstance(satisfaction, dict):
            violations.append(f"{name}: '{path}' must be a mapping")
            continue
        _validate_unknown_fields(violations, name, satisfaction, {"state", "evidence", "user_confirmation"}, path)
        state = satisfaction.get("state")
        if not isinstance(state, str) or not state.strip():
            violations.append(f"{name}: missing required field '{path}.state'")
            continue
        if state not in allowed_states:
            violations.append(
                f"{name}: invalid value '{state}' for '{path}.state' "
                "(expected one of: open, provisionally_satisfied, user_confirmed_satisfied)"
            )
            continue
        if state == "provisionally_satisfied" and _is_empty_required(satisfaction.get("evidence")):
            violations.append(f"{name}: '{path}.evidence' is required for provisionally_satisfied")
        if state == "user_confirmed_satisfied":
            confirmation = satisfaction.get("user_confirmation")
            if confirmation is None:
                violations.append(f"{name}: '{path}.user_confirmation' is required for user_confirmed_satisfied")
                continue
            if not isinstance(confirmation, dict):
                violations.append(
                    f"{name}: '{path}.user_confirmation' must be a mapping with confirmed_by and confirmed_at, got {type(confirmation).__name__}"
                )
                continue
            for field in ("confirmed_by", "confirmed_at"):
                if _is_empty_required(confirmation.get(field)):
                    violations.append(
                        f"{name}: missing required field '{path}.user_confirmation.{field}'"
                    )
    return violations


def _validation_rule_severity(schema: dict, rule: str) -> str | None:
    for group_key in ("VALIDATION", "VALIDATION_RULES"):
        for entry in schema.get(group_key, {}).values():
            if isinstance(entry, dict) and entry.get("rule") == rule:
                severity = entry.get("severity")
                return str(severity) if severity else None
    return None


def _expected_sequence_order(name: str, key: str) -> str:
    return _SEQUENCE_ORDER_BY_ARTIFACT.get((name, key), "ascending")


def _sequence_in_order(nums: list[int], direction: str) -> bool:
    reverse = direction == "descending"
    return nums == sorted(nums, reverse=reverse)


def _validate_yaml(content: str, schema: dict, name: str) -> list[str]:
    violations: list[str] = []
    try:
        data = yaml.safe_load(content)
    except yaml.YAMLError as exc:
        return [f"{name}: invalid YAML: {exc}"]
    if not isinstance(data, dict):
        return [f"{name}: root must be a mapping"]
    for group, group_lower, fields in _collect_singleton_groups(schema):
        if group_lower in data and isinstance(data[group_lower], dict):
            scope = data[group_lower]
        elif any(f in data for f in fields):
            scope = data
        else:
            continue
        _validate_singleton_group(violations, name, schema, group, scope, group_lower)
    if name == "plan":
        _validate_plan_known_fields(data, schema, violations)
        _validate_full_plan_contract(data, violations)
    _validate_sequences(data, schema, name, violations)
    if name == "decisions":
        violations.extend(_validate_decision_alternatives(data, name))
        violations.extend(_validate_decision_satisfaction(data, name))
    word_budget_severity = _validation_rule_severity(schema, "word_budget")
    for _, be in schema.get("BUDGET", {}).items():
        if not isinstance(be, dict):
            continue
        mw = be.get("max_words")
        scope = be.get("scope") or ""
        if mw and "full_file" in scope and word_budget_severity == "error":
            wc = len(content.split())
            if wc > mw:
                violations.append(f"{name}: word count ({wc}) exceeds budget ({mw})")
    for group_key in ("VALIDATION", "VALIDATION_RULES"):
        for _, ve in schema.get(group_key, {}).items():
            if not isinstance(ve, dict):
                continue
            rule = ve.get("rule", "")
            severity = ve.get("severity")
            if severity != "error":
                continue
            if "unique" in rule and "number" in rule:
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
                            direction = _expected_sequence_order(name, key)
                            if not _sequence_in_order(nums, direction):
                                violations.append(f"{name}: '{key}' not in {direction} order")
            elif rule == "closure_consistency":
                status = data.get("status") or data.get("header", {}).get("status")
                if isinstance(status, str) and status == "closed":
                    header = data.get("header", {}) if isinstance(data.get("header"), dict) else {}
                    for field in ("closed_at", "final_value", "target_ref", "reason"):
                        val = data.get(field)
                        if val is None:
                            val = header.get(field)
                        if val is None or (isinstance(val, str) and not val.strip()):
                            violations.append(f"{name}: closure field '{field}' is required when status is 'closed'")
    return violations


def _validate_md(content: str, name: str, schema: dict | None = None) -> list[str]:
    violations: list[str] = []
    if not content.strip():
        violations.append(f"{name}: empty content")
    fences = len(re.findall(r"^```", content, re.MULTILINE))
    if fences % 2:
        violations.append(f"{name}: unclosed code fence")
    if schema:
        violations.extend(_validate_md_schema(content, name, schema))
    return violations


# ── Markdown schema validation ──────────────────────────────────────


def _validate_md_schema(content: str, name: str, schema: dict) -> list[str]:
    """Check Markdown content against schema group requirements."""
    violations: list[str] = []
    if not content.strip():
        return violations
    for group_key, group_value in schema.items():
        if group_key in _SKIP_META or not isinstance(group_value, dict):
            continue
        has_required = any(
            isinstance(e, dict) and e.get("required") and e.get("field")
            for e in group_value.values()
        )
        if not has_required:
            continue
        if group_key == "ITEM":
            _validate_md_items(content, name, violations)
        elif group_key == "RELEASE":
            _validate_md_releases(content, name, violations)
        elif group_key == "TOKEN":
            _validate_md_tokens(content, name, violations)
    return violations


def _validate_md_items(content: str, name: str, violations: list[str]) -> None:
    """Validate TODO.md severity sections with entries."""
    version_heading = re.search(r"^##\s+", content, re.MULTILINE)
    if not version_heading:
        violations.append(
            f"{name}: missing severity sections (expected '## <glyph> <name>' headings)"
        )
        return
    severity_glyphs = ["⇶", "⇉", "→", "⇢"]
    found = False
    for glyph in severity_glyphs:
        if re.search(rf"^##\s*{re.escape(glyph)}", content, re.MULTILINE):
            found = True
            section_start = re.search(rf"^##\s*{re.escape(glyph)}.+$", content, re.MULTILINE)
            if section_start:
                idx = section_start.end()
                next_match = re.search(r"\n##\s", content[idx:])
                body_start = idx
                if content.startswith("\r\n", body_start):
                    body_start += 2
                elif body_start < len(content) and content[body_start] == "\n":
                    body_start += 1
                section_end = idx + next_match.start() if next_match else len(content)
                section_body = content[body_start:section_end]
    if not found:
        violations.append(
            f"{name}: missing severity glyph in section headings "
            "(expected '## ⇶ Critical', '## ⇉ Degraded', '## → Normal', '## ⇢ Annoying')"
        )


def _validate_md_releases(content: str, name: str, violations: list[str]) -> None:
    """Validate CHANGELOG.md has version headers and change sections."""
    if not re.search(r"^##\s*\[", content, re.MULTILINE):
        violations.append(f"{name}: missing version header (expected '## [X.Y.Z]')")
    change_sections = {"### Added", "### Changed", "### Fixed", "### Removed"}
    if not change_sections.intersection(content.split("\n")):
        violations.append(
            f"{name}: missing change sections "
            "(expected '### Added', '### Changed', '### Fixed', or '### Removed')"
        )


def _validate_md_tokens(content: str, name: str, violations: list[str]) -> None:
    """Validate DESIGN.md has section headings and YAML token blocks."""
    if not re.search(r"^##\s", content, re.MULTILINE):
        violations.append(f"{name}: missing section heading (expected '## SectionName')")
    yaml_blocks = len(re.findall(r"^```yaml\s*$", content, re.MULTILINE))
    if not yaml_blocks:
        violations.append(f"{name}: missing YAML code block with token definitions (expected '```yaml')")


# ── Main ───────────────────────────────────────────────────────────


def _resolve(fp: str, cwd: str) -> str:
    return fp if os.path.isabs(fp) else str(Path(cwd) / fp)


def _docs_path_overrides(cwd: str) -> dict[str, str]:
    docs_path = Path(cwd) / ".agentera" / "docs.yaml"
    if not docs_path.is_file():
        return {}
    try:
        data = load_yaml_mapping(docs_path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"warning: failed to load docs path overrides: {exc}", file=sys.stderr)
        return {}
    mapping = data.get("mapping")
    if not isinstance(mapping, list):
        return {}
    overrides: dict[str, str] = {}
    for entry in mapping:
        if not isinstance(entry, dict):
            continue
        artifact = entry.get("artifact")
        path = entry.get("path")
        if isinstance(artifact, str) and isinstance(path, str):
            overrides[artifact] = path
    return overrides


def _default_artifact_path(artifact: str, cwd: str) -> str:
    rel = _docs_path_overrides(cwd).get(artifact, _DEFAULT_ARTIFACT_PATHS.get(artifact, ""))
    return _resolve(rel, cwd) if rel else ""


def _artifact_paths(cwd: str) -> dict[str, str]:
    paths = dict(_DEFAULT_ARTIFACT_PATHS)
    paths.update(_docs_path_overrides(cwd))
    return {artifact: _resolve(path, cwd) for artifact, path in paths.items()}


def _same_path(left: str, right: str) -> bool:
    return Path(left).resolve(strict=False) == Path(right).resolve(strict=False)


def _artifact_for_write(abs_path: str, rel_path: str, basename: str, cwd: str) -> str | None:
    for artifact, mapped_path in _artifact_paths(cwd).items():
        if _same_path(abs_path, mapped_path):
            return artifact

    match = _AGENT_YAML_RE.search(rel_path)
    if match:
        return _ARTIFACT_BY_SCHEMA_NAME.get(match.group(1))
    if basename in _HUMAN_FACING:
        return basename
    return None


def _read_if_needed(content: str | None, abs_path: str) -> str | None:
    if content is not None:
        return content
    try:
        return Path(abs_path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


class ArtifactSchemaValidator:
    """Validate agent-facing YAML and human-facing Markdown artifacts."""

    def __init__(self, schemas_dir: Path = SCHEMAS_DIR):
        self.schemas_dir = schemas_dir
        self._schema_cache: dict[str, dict | None] = {}

    def load_schema(self, name: str) -> dict | None:
        if name not in self._schema_cache:
            path = self.schemas_dir / f"{name}.yaml"
            if path.is_file():
                with open(path, encoding="utf-8") as f:
                    self._schema_cache[name] = load_yaml_mapping(f.read())
            else:
                self._schema_cache[name] = None
        return self._schema_cache[name]

    def validate_yaml(self, content: str, schema: dict, name: str) -> list[str]:
        return _validate_yaml(content, schema, name)

    def validate_markdown(self, content: str, name: str, schema: dict | None = None) -> list[str]:
        return _validate_md(content, name, schema)

    def validate_write(self, write: ArtifactWrite, cwd: str) -> list[str]:
        abs_path = _resolve(write.file_path, cwd)
        rel = os.path.relpath(abs_path, cwd).replace("\\", "/")
        basename = os.path.basename(abs_path)
        artifact = _artifact_for_write(abs_path, rel, basename, cwd)

        if artifact in _CANONICAL_SCHEMA_NAMES:
            name = _CANONICAL_SCHEMA_NAMES[artifact]
            schema = self.load_schema(name)
            if schema is None:
                return []
            if not schema:
                return [f"{name}: schema file is empty or contains no valid definitions"]
            content = _read_if_needed(write.content, abs_path)
            if content is None:
                return []
            violations = self.validate_yaml(content, schema, name)
            if violations:
                return violations
            return _compact_after_valid_write(artifact, abs_path)

        if artifact in _HUMAN_FACING:
            content = _read_if_needed(write.content, abs_path)
            if content is None:
                return []
            schema_name = _HUMAN_FACING_SCHEMA_NAMES.get(artifact)
            schema = self.load_schema(schema_name) if schema_name else None
            violations = self.validate_markdown(content, artifact, schema)
            if violations:
                return violations
            return _compact_after_valid_write(artifact, abs_path)

        return []

    def validate_explicit(self, artifact: str, file_path: str, cwd: str) -> list[str]:
        content = _read_if_needed(None, file_path)
        if content is None:
            return [f"{artifact}: cannot read artifact file '{file_path}'"]
        if artifact in _CANONICAL_SCHEMA_NAMES:
            name = _CANONICAL_SCHEMA_NAMES[artifact]
            schema = self.load_schema(name)
            if schema is None:
                return [f"{artifact}: schema '{name}' is not available"]
            if not schema:
                return [f"{artifact}: schema '{name}' file is empty or contains no valid definitions"]
            violations = self.validate_yaml(content, schema, name)
            return violations
        if artifact in _HUMAN_FACING:
            schema_name = _HUMAN_FACING_SCHEMA_NAMES.get(artifact)
            schema = self.load_schema(schema_name) if schema_name else None
            return self.validate_markdown(content, artifact, schema)
        return [f"{artifact}: unsupported artifact; expected one of: {', '.join(sorted(_DEFAULT_ARTIFACT_PATHS))}"]


def load_schema(name: str) -> dict | None:
    return ArtifactSchemaValidator().load_schema(name)


def validate_yaml(content: str, schema: dict, name: str) -> list[str]:
    return ArtifactSchemaValidator().validate_yaml(content, schema, name)


def validate_markdown(content: str, name: str) -> list[str]:
    return ArtifactSchemaValidator().validate_markdown(content, name)


class HookCliAdapter:
    """Translate hook stdin/stdout/exit-code behavior around core modules."""

    def __init__(
        self,
        parser: RuntimeEventParser | None = None,
        validator: ArtifactSchemaValidator | None = None,
    ):
        self.parser = parser or RuntimeEventParser()
        self.validator = validator or ArtifactSchemaValidator()

    def run(self, raw: str, default_cwd: str | None = None) -> tuple[int, list[str]]:
        try:
            if not raw.strip():
                return 0, []
            data = json.loads(raw)
        except (json.JSONDecodeError, KeyError):
            return 0, []
        if not isinstance(data, dict):
            return 0, []

        write = self.parser.parse(data)
        if write is None:
            return 0, []

        cwd = data.get("cwd", default_cwd or os.getcwd())
        violations = self.validator.validate_write(write, cwd)
        return (2, violations) if violations else (0, [])

    def run_explicit(
        self,
        artifact: str,
        file_path: str | None,
        cwd: str,
    ) -> tuple[int, dict]:
        artifact = artifact.strip()
        default_path = _default_artifact_path(artifact, cwd)
        resolved_file = _resolve(file_path, cwd) if file_path else default_path
        violations = self.validator.validate_explicit(artifact, resolved_file, cwd)
        payload = {
            "command": "validate-artifact",
            "status": "fail" if violations else "pass",
            "artifact": artifact,
            "file": resolved_file,
            "docs_mapped_default": default_path or None,
            "path_source": "provided" if file_path else "docs_mapped_default",
            "violations": violations,
        }
        return (2, payload) if violations else (0, payload)

    def main(self, argv: list[str] | None = None) -> int:
        parser = argparse.ArgumentParser(description="Validate Agentera artifacts")
        parser.add_argument("--artifact", help="Canonical artifact name, e.g. PROGRESS.md")
        parser.add_argument("--file", help="Artifact file path to validate; defaults to docs.yaml mapping when omitted")
        parser.add_argument("--cwd", default=os.getcwd(), help="Project directory for relative paths and docs.yaml mapping")
        parser.add_argument("--format", choices=["text", "json"], default="text", help="Output format for explicit validation")
        args = parser.parse_args(argv)

        if args.artifact:
            rc, payload = self.run_explicit(args.artifact, args.file, _resolve(args.cwd, os.getcwd()))
            if args.format == "json":
                print(json.dumps(payload, ensure_ascii=False, indent=2))
            else:
                print(
                    f"status={payload['status']} | artifact={payload['artifact']} | "
                    f"file={payload['file']} | docs_mapped_default={payload['docs_mapped_default']} | "
                    f"path_source={payload['path_source']}"
                )
                for violation in payload["violations"]:
                    print(violation, file=sys.stderr)
            return rc

        if args.file:
            print("--file requires --artifact for explicit validation", file=sys.stderr)
            return 2

        rc, violations = self.run(sys.stdin.read(), os.getcwd())
        for violation in violations:
            print(violation, file=sys.stderr)
        return rc


def main() -> int:
    return HookCliAdapter().main()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.exit(2)
