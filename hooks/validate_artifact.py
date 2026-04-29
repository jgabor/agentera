#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""PostToolUse validation hook for artifact writes.

Receives JSON on stdin describing the tool invocation, routes to the
appropriate validator based on the modified file path, and reports
violations. Replaces .githooks/pre-commit (Decision 24).

Exit codes:
    0 = success (stdout shown as system message if non-empty)
    2 = blocking error (stderr fed back to Claude)

Routing:
    .agentera/*.md (or DOCS.md-overridden paths) -> artifact structure validation
    skills/*/SKILL.md -> spec alignment checks
    SPEC.md (root) -> context freshness check
    anything else -> exit 0 immediately

Supported stdin shapes:
    Claude Code (PostToolUse): {tool_input: {file_path: <path>}, ...}
    OpenCode (tool.execute.before): {runtime: "opencode", tool_input:
        {file_path: <path>, content: <candidate>}, ...}. Candidate content is
        validated before mutation. Invalid artifacts emit
        {"permissionDecision":"deny", ...}; insufficient evidence is allowed.
    Copilot CLI (preToolUse): {toolName: <name>, toolArgs: <json string>, cwd: <dir>, ...}
        If toolArgs carries a path plus reconstructable candidate content,
        artifact content is validated before mutation. Invalid artifacts emit
        {"permissionDecision":"deny", ...}; insufficient evidence is allowed.
    Codex (PreToolUse/PostToolUse, tool_name == "apply_patch"):
        {tool_name: "apply_patch", tool_input: {command: <patch body>}, cwd: <dir>, ...}
        Patch body parsed for *** Add/Update/Delete/Move headers per
        codex-rs/core/prompt_with_apply_patch_instructions.md grammar.
        Schema captured from openai/codex#18391 (merged 2026-04-22):
        codex-rs/hooks/schema/generated/{pre,post}-tool-use.command.input.schema.json.
        Exit 0 = success (stdout printed as system message);
        exit 2 with stderr = block the apply_patch (PreToolUse only).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import traceback
from pathlib import Path


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent

# Import hooks utilities (co-located in hooks/).
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from compaction import (  # type: ignore[import-not-found]
        MAX_FULL_ENTRIES as _COMPACT_MAX_FULL,
        MAX_ONELINE_ENTRIES as _COMPACT_MAX_ONELINE,
        detect_overflow as _detect_overflow,
    )
except ImportError:
    _COMPACT_MAX_FULL = 10
    _COMPACT_MAX_ONELINE = 40
    _detect_overflow = None  # type: ignore[assignment]

from common import parse_artifact_mapping  # type: ignore[import-not-found]

# Default operational artifact directory relative to target project root.
DEFAULT_OP_DIR = ".agentera"

# Artifacts at project root by default.
ROOT_ARTIFACTS = {"VISION.md", "TODO.md", "CHANGELOG.md"}

# Artifacts in .agentera/ by default.
OP_ARTIFACTS = {
    "PROGRESS.md",
    "DECISIONS.md",
    "PLAN.md",
    "HEALTH.md",
    "DESIGN.md",
    "DOCS.md",
}

# Token budgets (full-file limits) from SPEC.md Section 4.
# Per-entry budgets are not validated here (would require entry parsing).
TOKEN_BUDGETS: dict[str, int] = {
    "PROGRESS.md": 3000,
    "HEALTH.md": 2000,
    "DECISIONS.md": 5000,  # No explicit full-file budget in spec; generous limit
    "PLAN.md": 2500,
    "VISION.md": 1500,
    "DESIGN.md": 2000,
    "DOCS.md": 2000,
    "TODO.md": 5000,  # No explicit full-file budget in spec; generous limit
    "CHANGELOG.md": 5000,  # No explicit full-file budget in spec; generous limit
}

# Required heading patterns per artifact type.
# Each entry is (artifact_name, list_of_heading_patterns).
# Patterns are regex matching full heading lines.
ARTIFACT_HEADINGS: dict[str, list[str]] = {
    "HEALTH.md": [
        r"^# Health",
        r"^## Audit \d+",
    ],
    "PLAN.md": [
        r"^# Plan",
        r"(?:^## Tasks|^### Task \d+)",
    ],
    "DECISIONS.md": [
        r"^# Decisions",
        r"^## Decision \d+",
    ],
    "PROGRESS.md": [
        r"^# Progress",
        r"^(?:■\s*)?## Cycle \d+",
    ],
    "TODO.md": [
        r"^# TODO",
    ],
    "VISION.md": [
        r"^#\s+\S",  # Must have at least one heading
    ],
}

# TODO.md severity sections (checked separately for presence).
TODO_SEVERITY_HEADINGS = [
    r"^## .*Critical",
    r"^## .*Degraded",
    r"^## .*Normal",
    r"^## .*Annoying",
]


def validate_decision_numbering(content: str) -> list[str]:
    """Validate DECISIONS.md numbering hygiene."""
    active = re.split(
        r"^## Archived Decisions\b",
        content,
        maxsplit=1,
        flags=re.MULTILINE,
    )[0]
    numbers = [
        int(match.group(1))
        for match in re.finditer(r"^## Decision\s+(\d+)\b", active, re.MULTILINE)
    ]
    all_numbers = [
        int(match.group(1) or match.group(2))
        for match in re.finditer(
            r"^## Decision\s+(\d+)\b|^- Decision\s+(\d+)\s+\(",
            content,
            re.MULTILINE,
        )
    ]
    violations: list[str] = []

    seen: set[int] = set()
    duplicates: list[int] = []
    for number in all_numbers:
        if number in seen and number not in duplicates:
            duplicates.append(number)
        seen.add(number)
    if duplicates:
        joined = ", ".join(str(number) for number in duplicates)
        violations.append(f"DECISIONS.md: duplicate decision numbers: {joined}")

    if numbers != sorted(numbers):
        violations.append("DECISIONS.md: active decision numbers must be ascending")

    return violations


# ---------------------------------------------------------------------------
# DOCS.md artifact path resolution
# ---------------------------------------------------------------------------


_CANONICAL_ARTIFACTS = ROOT_ARTIFACTS | OP_ARTIFACTS


def resolve_artifact_paths(project_root: str) -> dict[str, str]:
    """Build a map of canonical artifact name to absolute path.

    Checks .agentera/DOCS.md for an Artifact Mapping table with path
    overrides. Falls back to the deterministic default layout. Parsing
    is delegated to hooks/common.py; this function filters the raw
    mapping to known canonical artifacts before applying overrides.
    """
    paths: dict[str, str] = {}
    root = Path(project_root)

    # Defaults
    for name in ROOT_ARTIFACTS:
        paths[name] = str(root / name)
    for name in OP_ARTIFACTS:
        paths[name] = str(root / DEFAULT_OP_DIR / name)

    # Check DOCS.md for overrides
    docs_path = root / DEFAULT_OP_DIR / "DOCS.md"
    if docs_path.is_file():
        try:
            content = docs_path.read_text(encoding="utf-8")
            for name, rel_path in parse_artifact_mapping(content).items():
                if name in _CANONICAL_ARTIFACTS:
                    paths[name] = str(root / rel_path)
        except (OSError, UnicodeDecodeError):
            pass  # Fall back to defaults

    return paths


def identify_artifact(file_path: str, project_root: str) -> str | None:
    """Return the canonical artifact name if file_path is a known artifact.

    Returns None if the file is not a recognized operational artifact.
    """
    abs_path = str(Path(file_path).resolve())
    artifact_paths = resolve_artifact_paths(project_root)

    for name, expected_path in artifact_paths.items():
        if abs_path == str(Path(expected_path).resolve()):
            return name

    return None


# ---------------------------------------------------------------------------
# Artifact structure validation
# ---------------------------------------------------------------------------


def count_words(text: str) -> int:
    """Approximate word count for token budget checking."""
    return len(text.split())


def validate_artifact_structure(file_path: str, artifact_name: str) -> list[str]:
    """Validate an artifact file for required headings and token budget.

    Returns a list of violation messages. Empty list means all checks pass.
    """
    try:
        content = Path(file_path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [f"Cannot read {artifact_name}: {exc}"]

    return validate_artifact_text(content, artifact_name)


def validate_artifact_text(content: str, artifact_name: str) -> list[str]:
    """Validate candidate artifact content without reading from disk."""
    violations: list[str] = []

    # Check required headings
    required = ARTIFACT_HEADINGS.get(artifact_name, [])
    for pattern in required:
        if not re.search(pattern, content, re.MULTILINE):
            violations.append(
                f"{artifact_name}: missing required heading matching /{pattern}/"
            )

    # Check TODO.md severity sections specifically
    if artifact_name == "TODO.md":
        for pattern in TODO_SEVERITY_HEADINGS:
            if not re.search(pattern, content, re.MULTILINE):
                label = pattern.split(".*")[-1] if ".*" in pattern else pattern
                violations.append(
                    f"TODO.md: missing severity section matching /{pattern}/"
                )

    if artifact_name == "DECISIONS.md":
        violations.extend(validate_decision_numbering(content))

    # Check markdown well-formedness (lightweight: unclosed code blocks)
    open_fences = len(re.findall(r"^```", content, re.MULTILINE))
    if open_fences % 2 != 0:
        violations.append(
            f"{artifact_name}: unclosed code fence (odd number of ``` lines)"
        )

    # Check token budget
    budget = TOKEN_BUDGETS.get(artifact_name)
    if budget is not None:
        word_count = count_words(content)
        if word_count > budget:
            violations.append(
                f"{artifact_name}: word count ({word_count}) exceeds budget ({budget})"
            )

    return violations


# ---------------------------------------------------------------------------
# Compaction overflow nudge (non-blocking)
# ---------------------------------------------------------------------------


# Map artifact canonical name to (spec, path-relative command hint).
_COMPACTION_SPECS: dict[str, str] = {
    "PROGRESS.md": "progress",
    "DECISIONS.md": "decisions",
    "HEALTH.md": "health",
    "EXPERIMENTS.md": "experiments",
    "TODO.md": "todo-resolved",
}


def detect_compaction_overflow(
    file_path: str,
    artifact_name: str,
) -> list[str]:
    """Return a warning list if the file exceeds 10/40/50 thresholds.

    Non-blocking: the returned warnings are appended to the existing
    violation list, which the hook reports without failing.
    """
    if _detect_overflow is None:
        return []
    spec_name = _COMPACTION_SPECS.get(artifact_name)
    if spec_name is None:
        return []
    try:
        text = Path(file_path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    try:
        full_count, oneline_count = _detect_overflow(text, spec_name)
    except Exception:
        return []

    total = full_count + oneline_count
    if full_count <= _COMPACT_MAX_FULL and total <= _COMPACT_MAX_FULL + _COMPACT_MAX_ONELINE:
        return []

    hint = (
        f"{artifact_name}: {full_count} full-detail entries exceeds "
        f"{_COMPACT_MAX_FULL}, "
        f"run scripts/compact_artifact.py {spec_name} {file_path}"
    )
    return [hint]


# ---------------------------------------------------------------------------
# Ecosystem alignment (skill definitions)
# ---------------------------------------------------------------------------


def validate_skill_definition(file_path: str) -> list[str]:
    """Run spec linter and context freshness check on a skill change.

    Calls validate_spec.py and generate_contracts.py --check
    as subprocesses. Returns a list of violation messages.
    """
    violations: list[str] = []

    # Run spec linter
    linter_result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "validate_spec.py")],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    if linter_result.returncode != 0:
        # Extract error lines from linter output
        for line in linter_result.stdout.splitlines():
            if "ERROR" in line:
                violations.append(line.strip())
        if not violations and linter_result.stderr:
            violations.append(
                f"Ecosystem linter failed: {linter_result.stderr.strip()}"
            )
        if not violations:
            violations.append("Ecosystem linter failed (see linter output)")

    # Run context freshness check
    freshness_result = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "generate_contracts.py"),
            "--check",
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    if freshness_result.returncode != 0:
        msg = freshness_result.stdout.strip() or freshness_result.stderr.strip()
        if msg:
            violations.append(f"Context freshness: {msg}")
        else:
            violations.append("Ecosystem context files are stale")

    return violations


# ---------------------------------------------------------------------------
# Context freshness (SPEC.md)
# ---------------------------------------------------------------------------


def validate_spec_spec() -> list[str]:
    """Run context freshness check when SPEC.md is modified.

    Returns a list of violation messages.
    """
    violations: list[str] = []

    freshness_result = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "generate_contracts.py"),
            "--check",
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    if freshness_result.returncode != 0:
        msg = freshness_result.stdout.strip() or freshness_result.stderr.strip()
        if msg:
            violations.append(f"Context freshness: {msg}")
        else:
            violations.append(
                "Contract files are stale after spec change. "
                "Run: python3 scripts/generate_contracts.py"
            )

    return violations


# ---------------------------------------------------------------------------
# Codex apply_patch stdin parsing
# ---------------------------------------------------------------------------


# apply_patch file headers per codex-rs/core/prompt_with_apply_patch_instructions.md.
# Examples: "*** Add File: path/to/file.md", "*** Update File: .agentera/PROGRESS.md",
# "*** Delete File: x.md", "*** Move to: new/path.md" (follows an Update header).
_APPLY_PATCH_FILE_HEADER = re.compile(
    r"^\*\*\*\s+(Add File|Update File|Delete File|Move to):\s+(.+?)\s*$",
    re.MULTILINE,
)


def extract_codex_patch_paths(command: str) -> list[str]:
    """Extract every file path the apply_patch body touches.

    The grammar emits one of three operation headers per file
    (Add/Update/Delete File) plus an optional Move-to rename header.
    Returns the list of paths in patch order; duplicates preserved so
    each touched file gets validated.
    """
    if not isinstance(command, str):
        return []
    return [match.group(2).strip() for match in _APPLY_PATCH_FILE_HEADER.finditer(command)]


# ---------------------------------------------------------------------------
# Copilot preToolUse stdin parsing
# ---------------------------------------------------------------------------


_COPILOT_PATH_KEYS = ("path", "filePath", "file_path")
_COPILOT_CONTENT_KEYS = ("content", "text", "newContent", "new_content")
_COPILOT_OLD_KEYS = ("oldString", "old_string", "oldText", "old_text")
_COPILOT_NEW_KEYS = ("newString", "new_string", "newText", "new_text")


def parse_copilot_tool_args(value: object) -> dict[str, object] | None:
    """Return Copilot toolArgs as an object.

    Copilot CLI documents toolArgs as a JSON string. The SDK exposes an object.
    Support both shapes so the hook stays portable across Copilot surfaces.
    """
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    if isinstance(parsed, dict):
        return parsed
    return None


def _first_string(args: dict[str, object], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = args.get(key)
        if isinstance(value, str):
            return value
    return None


def reconstruct_copilot_candidate(
    tool_args: object,
    project_root: str,
) -> tuple[str, str] | None:
    """Reconstruct a candidate file path and content from Copilot toolArgs.

    Returns None when the payload does not carry enough evidence. The pre-write
    gate must allow that case rather than guessing at host-specific tool shapes.
    """
    args = parse_copilot_tool_args(tool_args)
    if args is None:
        return None

    raw_path = _first_string(args, _COPILOT_PATH_KEYS)
    if raw_path is None:
        return None
    file_path = raw_path if os.path.isabs(raw_path) else str(Path(project_root) / raw_path)

    content = _first_string(args, _COPILOT_CONTENT_KEYS)
    if content is not None:
        return file_path, content

    old_text = _first_string(args, _COPILOT_OLD_KEYS)
    new_text = _first_string(args, _COPILOT_NEW_KEYS)
    if old_text is None or new_text is None:
        return None

    try:
        current = Path(file_path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None

    replace_all = args.get("replaceAll") is True or args.get("replace_all") is True
    if replace_all:
        if old_text not in current:
            return None
        return file_path, current.replace(old_text, new_text)

    if current.count(old_text) != 1:
        return None
    return file_path, current.replace(old_text, new_text, 1)


def _print_copilot_decision(decision: str, reason: str | None = None) -> None:
    payload = {"permissionDecision": decision}
    if reason:
        payload["permissionDecisionReason"] = reason
    print(json.dumps(payload, separators=(",", ":")))


def handle_candidate_pre_tool_use(
    file_path: object,
    content: object,
    project_root: str,
) -> int:
    """Validate a pre-write artifact candidate from a host adapter."""
    if not isinstance(file_path, str) or not isinstance(content, str):
        _print_copilot_decision("allow")
        return 0

    resolved_path = (
        file_path if os.path.isabs(file_path) else str(Path(project_root) / file_path)
    )
    artifact_name = identify_artifact(resolved_path, project_root)
    if artifact_name is None:
        _print_copilot_decision("allow")
        return 0

    violations = validate_artifact_text(content, artifact_name)
    if not violations:
        _print_copilot_decision("allow")
        return 0

    reason = "Artifact validation failed: " + "; ".join(violations)
    _print_copilot_decision("deny", reason)
    return 0


def handle_copilot_pre_tool_use(hook_input: dict[str, object], project_root: str) -> int:
    """Validate reconstructable Copilot edit candidates before mutation."""
    candidate = reconstruct_copilot_candidate(hook_input.get("toolArgs"), project_root)
    if candidate is None:
        _print_copilot_decision("allow")
        return 0

    file_path, content = candidate
    artifact_name = identify_artifact(file_path, project_root)
    if artifact_name is None:
        _print_copilot_decision("allow")
        return 0

    violations = validate_artifact_text(content, artifact_name)
    if not violations:
        _print_copilot_decision("allow")
        return 0

    reason = "Artifact validation failed: " + "; ".join(violations)
    _print_copilot_decision("deny", reason)
    return 0


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


def classify_file(file_path: str, project_root: str) -> str:
    """Classify a file path for validation routing.

    Returns one of:
        "artifact"       - operational artifact (.agentera/*.md or root artifacts)
        "skill"          - skill definition file (skills/*/SKILL.md)
        "the spec" - the spec (SPEC.md at root)
        "other"          - no validation needed
    """
    abs_path = str(Path(file_path).resolve())

    # Check if it's a known artifact (uses DOCS.md path resolution)
    artifact_name = identify_artifact(file_path, project_root)
    if artifact_name is not None:
        return "artifact"

    # Check if it's a SKILL.md
    # Pattern: .../skills/<name>/SKILL.md
    if re.search(r"/skills/[^/]+/SKILL\.md$", abs_path):
        return "skill"

    # Check if it's the spec
    spec_path = str((Path(project_root) / "SPEC.md").resolve())
    if abs_path == spec_path:
        return "the spec"

    return "other"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def _validate_one_path(
    file_path: str,
    project_root: str,
    skip_if_missing: bool = False,
) -> list[str]:
    """Validate a single file path; return violation messages.

    skip_if_missing: when True (Codex apply_patch path), silently skip
    paths that do not yet exist on disk. PreToolUse fires before the
    patch lands, so Add File targets and not-yet-applied Update targets
    must not surface as 'cannot read' errors.
    """
    category = classify_file(file_path, project_root)
    if category == "other":
        return []

    if skip_if_missing and not Path(file_path).is_file():
        return []

    if category == "artifact":
        artifact_name = identify_artifact(file_path, project_root)
        if artifact_name:
            violations = validate_artifact_structure(file_path, artifact_name)
            violations.extend(detect_compaction_overflow(file_path, artifact_name))
            return violations
        return []

    if category == "skill":
        return validate_skill_definition(file_path)

    if category == "the spec":
        return validate_spec_spec()

    return []


def main() -> int:
    """Read hook input from stdin, route to validator, report violations."""
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return 0
        hook_input = json.loads(raw)
    except (json.JSONDecodeError, KeyError):
        return 0  # Malformed input, skip validation silently

    project_root = hook_input.get("cwd", os.getcwd())
    tool_input = hook_input.get("tool_input") or {}
    tool_name = hook_input.get("tool_name", "")

    is_copilot_pre_tool = (
        isinstance(hook_input, dict)
        and "toolName" in hook_input
        and "toolArgs" in hook_input
        and "toolResult" not in hook_input
        and hook_input.get("hook_event_name", "preToolUse") == "preToolUse"
    )
    if is_copilot_pre_tool:
        return handle_copilot_pre_tool_use(hook_input, str(project_root))

    is_opencode_pre_tool = (
        isinstance(hook_input, dict)
        and hook_input.get("runtime") == "opencode"
        and hook_input.get("hook_event_name") == "tool.execute.before"
        and isinstance(tool_input, dict)
    )
    if is_opencode_pre_tool:
        return handle_candidate_pre_tool_use(
            tool_input.get("file_path"),
            tool_input.get("content"),
            str(project_root),
        )

    # Codex apply_patch path: tool_input.command holds the raw patch body;
    # parse for every touched file and validate each one.
    # Schema: codex-rs/hooks/schema/generated/{pre,post}-tool-use.command.input.schema.json
    file_paths: list[str] = []
    is_codex_patch = tool_name == "apply_patch" and isinstance(tool_input, dict)
    if is_codex_patch:
        command = tool_input.get("command", "")
        patch_paths = extract_codex_patch_paths(command)
        # Resolve patch-relative paths against cwd so downstream classifiers
        # can compare against the absolute artifact paths in resolve_artifact_paths.
        for p in patch_paths:
            if os.path.isabs(p):
                file_paths.append(p)
            else:
                file_paths.append(str(Path(project_root) / p))
    else:
        # Claude Code / OpenCode shape: tool_input.file_path is the modified file.
        file_path = tool_input.get("file_path") if isinstance(tool_input, dict) else None
        if file_path:
            file_paths.append(file_path)

    if not file_paths:
        return 0

    violations: list[str] = []
    for path in file_paths:
        violations.extend(
            _validate_one_path(path, project_root, skip_if_missing=is_codex_patch)
        )

    # Report results
    if not violations:
        return 0

    # Non-blocking: report violations on stdout (shown as system message)
    message = "Artifact validation warnings:\n" + "\n".join(
        f"  - {v}" for v in violations
    )
    print(message)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.exit(0)
