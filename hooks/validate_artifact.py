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
    skills/*/SKILL.md -> ecosystem alignment checks
    references/ecosystem-spec.md -> context freshness check
    anything else -> exit 0 immediately
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent

# Default operational artifact directory relative to target project root.
DEFAULT_OP_DIR = ".agentera"

# Artifacts at project root by default.
ROOT_ARTIFACTS = {"VISION.md", "TODO.md", "CHANGELOG.md"}

# Artifacts in .agentera/ by default.
OP_ARTIFACTS = {
    "PROGRESS.md", "DECISIONS.md", "PLAN.md", "HEALTH.md",
    "OBJECTIVE.md", "EXPERIMENTS.md", "DESIGN.md", "DOCS.md",
}

# Token budgets (full-file limits) from ecosystem-spec.md Section 4.
# Per-entry budgets are not validated here (would require entry parsing).
TOKEN_BUDGETS: dict[str, int] = {
    "PROGRESS.md": 3000,
    "EXPERIMENTS.md": 2500,
    "HEALTH.md": 2000,
    "DECISIONS.md": 5000,  # No explicit full-file budget in spec; generous limit
    "PLAN.md": 2500,
    "VISION.md": 1500,
    "DESIGN.md": 2000,
    "DOCS.md": 2000,
    "TODO.md": 5000,  # No explicit full-file budget in spec; generous limit
    "CHANGELOG.md": 5000,  # No explicit full-file budget in spec; generous limit
    "OBJECTIVE.md": 2000,  # No explicit full-file budget in spec; generous limit
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
        r"^## Cycle \d+",
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


# ---------------------------------------------------------------------------
# DOCS.md artifact path resolution
# ---------------------------------------------------------------------------

def resolve_artifact_paths(project_root: str) -> dict[str, str]:
    """Build a map of canonical artifact name to absolute path.

    Checks .agentera/DOCS.md for an Artifact Mapping table with path
    overrides. Falls back to the deterministic default layout.
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
            overrides = _parse_artifact_mapping(content)
            for name, rel_path in overrides.items():
                paths[name] = str(root / rel_path)
        except (OSError, UnicodeDecodeError):
            pass  # Fall back to defaults

    return paths


def _parse_artifact_mapping(docs_content: str) -> dict[str, str]:
    """Parse the Artifact Mapping table from DOCS.md content.

    Expects rows like: | VISION.md | VISION.md | visionera, realisera |
    Returns mapping of artifact name to relative path.
    """
    overrides: dict[str, str] = {}
    in_mapping = False

    for line in docs_content.splitlines():
        if "## Artifact Mapping" in line:
            in_mapping = True
            continue
        if in_mapping and line.startswith("##"):
            break
        if not in_mapping or not line.startswith("|"):
            continue
        # Skip header separator rows
        if re.match(r"^\|[-| :]+\|$", line):
            continue

        cells = [c.strip() for c in line.split("|")]
        # Split creates empty strings at start/end from leading/trailing |
        cells = [c for c in cells if c]
        if len(cells) >= 2:
            artifact_name = cells[0]
            rel_path = cells[1]
            if artifact_name in ROOT_ARTIFACTS or artifact_name in OP_ARTIFACTS:
                overrides[artifact_name] = rel_path

    return overrides


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
    violations: list[str] = []

    try:
        content = Path(file_path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        violations.append(f"Cannot read {artifact_name}: {exc}")
        return violations

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

    # Check markdown well-formedness (lightweight: unclosed code blocks)
    open_fences = len(re.findall(r"^```", content, re.MULTILINE))
    if open_fences % 2 != 0:
        violations.append(f"{artifact_name}: unclosed code fence (odd number of ``` lines)")

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
# Ecosystem alignment (skill definitions)
# ---------------------------------------------------------------------------

def validate_skill_definition(file_path: str) -> list[str]:
    """Run ecosystem linter and context freshness check on a skill change.

    Calls validate_ecosystem.py and generate_ecosystem_context.py --check
    as subprocesses. Returns a list of violation messages.
    """
    violations: list[str] = []

    # Run ecosystem linter
    linter_result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "validate_ecosystem.py")],
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
            violations.append(f"Ecosystem linter failed: {linter_result.stderr.strip()}")
        if not violations:
            violations.append("Ecosystem linter failed (see linter output)")

    # Run context freshness check
    freshness_result = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "generate_ecosystem_context.py"),
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
# Context freshness (ecosystem-spec.md)
# ---------------------------------------------------------------------------

def validate_ecosystem_spec() -> list[str]:
    """Run context freshness check when ecosystem-spec.md is modified.

    Returns a list of violation messages.
    """
    violations: list[str] = []

    freshness_result = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "generate_ecosystem_context.py"),
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
                "Ecosystem context files are stale after spec change. "
                "Run: python3 scripts/generate_ecosystem_context.py"
            )

    return violations


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

def classify_file(file_path: str, project_root: str) -> str:
    """Classify a file path for validation routing.

    Returns one of:
        "artifact"       - operational artifact (.agentera/*.md or root artifacts)
        "skill"          - skill definition file (skills/*/SKILL.md)
        "ecosystem-spec" - the ecosystem spec (references/ecosystem-spec.md)
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

    # Check if it's the ecosystem spec
    spec_path = str((Path(project_root) / "references" / "ecosystem-spec.md").resolve())
    if abs_path == spec_path:
        return "ecosystem-spec"

    return "other"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    """Read hook input from stdin, route to validator, report violations."""
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return 0
        hook_input = json.loads(raw)
    except (json.JSONDecodeError, KeyError):
        return 0  # Malformed input, skip validation silently

    # Extract file path from tool_input
    tool_input = hook_input.get("tool_input", {})
    file_path = tool_input.get("file_path")
    if not file_path:
        return 0

    project_root = hook_input.get("cwd", os.getcwd())

    # Route to appropriate validator
    category = classify_file(file_path, project_root)

    if category == "other":
        return 0

    violations: list[str] = []

    if category == "artifact":
        artifact_name = identify_artifact(file_path, project_root)
        if artifact_name:
            violations = validate_artifact_structure(file_path, artifact_name)

    elif category == "skill":
        violations = validate_skill_definition(file_path)

    elif category == "ecosystem-spec":
        violations = validate_ecosystem_spec()

    # Report results
    if not violations:
        return 0

    # Non-blocking: report violations on stdout (shown as system message)
    message = "Artifact validation warnings:\n" + "\n".join(f"  - {v}" for v in violations)
    print(message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
