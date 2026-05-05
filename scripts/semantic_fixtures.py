#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Semantic fixture contract validation for offline skill evals.

This module defines the fixture shape only. It intentionally does not run
semantic checks, invoke model runtimes, or change ``scripts/eval_skills.py``.

Fixture format::

    # Semantic Fixture: hej-routing-example

    ## Prompt
    User prompt text presented to the skill.

    ## Seeded Project State
    ```json
    {"files": [{"path": ".agentera/plan.yaml", "content": "..."}]}
    ```

    ## Captured Output
    Assistant output captured offline.

    ## Expected Facts
    ```json
    {
      "required_output": ["suggested -> /realisera"],
      "forbidden_output": ["/optimera"],
      "artifact_expectations": {"writes": "none"}
    }
    ```

``artifact_expectations.writes`` may be ``"none"`` for read-only fixtures, or
a list of write expectations with ``path`` and optional ``contains`` strings.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REQUIRED_SECTIONS: tuple[str, ...] = (
    "Prompt",
    "Seeded Project State",
    "Captured Output",
    "Expected Facts",
)


@dataclass(frozen=True)
class SemanticFixture:
    """Validated semantic fixture content."""

    prompt: str
    seeded_state: dict[str, Any]
    captured_output: str
    expected_facts: dict[str, Any]


def load_fixture(path: Path) -> tuple[SemanticFixture | None, list[str]]:
    """Read and validate a semantic fixture file."""
    return validate_fixture_text(path.read_text(encoding="utf-8"))


def validate_fixture_text(text: str) -> tuple[SemanticFixture | None, list[str]]:
    """Validate fixture text and return ``(fixture, errors)``.

    Errors name the missing or malformed section so invalid fixtures fail with
    actionable feedback.
    """
    sections = _parse_sections(text)
    errors: list[str] = []

    for section in REQUIRED_SECTIONS:
        if section not in sections:
            errors.append(f"missing section: {section}")

    prompt = sections.get("Prompt", "").strip()
    if "Prompt" in sections and not prompt:
        errors.append("malformed section: Prompt: must be non-empty")

    seeded_state: dict[str, Any] = {}
    if "Seeded Project State" in sections:
        seeded_state, state_errors = _validate_seeded_state(sections["Seeded Project State"])
        errors.extend(state_errors)

    captured_output = sections.get("Captured Output", "").strip()
    if "Captured Output" in sections and not captured_output:
        errors.append("malformed section: Captured Output: must be non-empty")

    expected_facts: dict[str, Any] = {}
    if "Expected Facts" in sections:
        expected_facts, fact_errors = _validate_expected_facts(sections["Expected Facts"])
        errors.extend(fact_errors)

    if errors:
        return None, errors
    return SemanticFixture(prompt, seeded_state, captured_output, expected_facts), []


def _parse_sections(text: str) -> dict[str, str]:
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for line in text.splitlines():
        match = re.match(r"^##\s+(.+?)\s*$", line)
        if match:
            current = match.group(1)
            sections.setdefault(current, [])
            continue
        if current is not None:
            sections[current].append(line)
    return {name: "\n".join(lines).strip() for name, lines in sections.items()}


def _validate_seeded_state(section_text: str) -> tuple[dict[str, Any], list[str]]:
    data, errors = _load_json_section("Seeded Project State", section_text)
    if errors:
        return {}, errors
    if not isinstance(data, dict):
        return {}, ["malformed section: Seeded Project State: JSON must be an object"]

    files = data.get("files")
    if not isinstance(files, list):
        return {}, ["malformed section: Seeded Project State: files must be a list"]
    for index, item in enumerate(files):
        if not isinstance(item, dict):
            return {}, [f"malformed section: Seeded Project State: files[{index}] must be an object"]
        if not _non_empty_string(item.get("path")):
            return {}, [f"malformed section: Seeded Project State: files[{index}].path must be non-empty"]
        if not isinstance(item.get("content"), str):
            return {}, [f"malformed section: Seeded Project State: files[{index}].content must be a string"]
    return data, []


def _validate_expected_facts(section_text: str) -> tuple[dict[str, Any], list[str]]:
    data, errors = _load_json_section("Expected Facts", section_text)
    if errors:
        return {}, errors
    if not isinstance(data, dict):
        return {}, ["malformed section: Expected Facts: JSON must be an object"]

    errors.extend(_validate_string_list(data, "required_output", required=False))
    errors.extend(_validate_string_list(data, "forbidden_output", required=False))

    has_output_fact = bool(data.get("required_output") or data.get("forbidden_output"))
    has_artifact_fact = "artifact_expectations" in data
    if not has_output_fact and not has_artifact_fact:
        errors.append("malformed section: Expected Facts: must declare at least one expected fact")

    if has_artifact_fact:
        errors.extend(_validate_artifact_expectations(data["artifact_expectations"]))

    return data, errors


def _validate_artifact_expectations(value: Any) -> list[str]:
    if not isinstance(value, dict):
        return ["malformed section: Expected Facts: artifact_expectations must be an object"]
    writes = value.get("writes")
    if writes == "none":
        return []
    if not isinstance(writes, list):
        return ["malformed section: Expected Facts: artifact_expectations.writes must be 'none' or a list"]
    for index, item in enumerate(writes):
        if not isinstance(item, dict):
            return [f"malformed section: Expected Facts: artifact_expectations.writes[{index}] must be an object"]
        if not _non_empty_string(item.get("path")):
            return [f"malformed section: Expected Facts: artifact_expectations.writes[{index}].path must be non-empty"]
        if "contains" in item:
            contains = item["contains"]
            if not isinstance(contains, list) or not all(_non_empty_string(s) for s in contains):
                return [f"malformed section: Expected Facts: artifact_expectations.writes[{index}].contains must be non-empty strings"]
    return []


def _validate_string_list(data: dict[str, Any], key: str, required: bool) -> list[str]:
    if key not in data:
        return [f"malformed section: Expected Facts: {key} is required"] if required else []
    value = data[key]
    if not isinstance(value, list) or not all(_non_empty_string(item) for item in value):
        return [f"malformed section: Expected Facts: {key} must be non-empty strings"]
    return []


def _load_json_section(section_name: str, text: str) -> tuple[Any, list[str]]:
    block = _extract_json_block(text)
    if block is None:
        return None, [f"malformed section: {section_name}: expected fenced json block"]
    try:
        return json.loads(block), []
    except json.JSONDecodeError as exc:
        return None, [f"malformed section: {section_name}: invalid JSON at line {exc.lineno}"]


def _extract_json_block(text: str) -> str | None:
    match = re.search(r"```json\s*\n(?P<body>.*?)\n```", text, re.DOTALL)
    if not match:
        return None
    return match.group("body")


def _non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())
