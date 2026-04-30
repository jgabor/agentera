#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Offline semantic eval command for captured skill fixtures.

This runner evaluates fixture text and seeded artifact facts only. It never
invokes Claude Code, OpenCode, or any other model runtime.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from semantic_fixtures import SemanticFixture, load_fixture


@dataclass(frozen=True)
class CheckedFact:
    """One deterministic semantic assertion result."""

    fact: str
    status: str
    detail: str

    def as_dict(self) -> dict[str, str]:
        return {"fact": self.fact, "status": self.status, "detail": self.detail}


def evaluate_fixture(fixture: SemanticFixture, source: str = "<fixture>") -> dict[str, Any]:
    """Evaluate one validated fixture and return a machine-readable result."""
    facts = _check_output_facts(fixture) + _check_seeded_artifact_facts(fixture)
    failing = next((fact for fact in facts if fact.status == "fail"), None)
    return {
        "fixture": source,
        "status": "fail" if failing else "pass",
        "checked_facts": [fact.as_dict() for fact in facts],
        "failing_fact": failing.as_dict() if failing else None,
    }


def evaluate_fixture_file(path: Path) -> dict[str, Any]:
    """Load, validate, and evaluate a fixture file."""
    fixture, errors = load_fixture(path)
    if errors:
        failing = CheckedFact("fixture_contract", "fail", "; ".join(errors))
        return {
            "fixture": str(path),
            "status": "fail",
            "checked_facts": [failing.as_dict()],
            "failing_fact": failing.as_dict(),
        }
    assert fixture is not None
    return evaluate_fixture(fixture, str(path))


def build_report(results: list[dict[str, Any]]) -> dict[str, Any]:
    """Build the command's stable JSON summary."""
    passed = sum(1 for result in results if result["status"] == "pass")
    failed = len(results) - passed
    return {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": "fail" if failed else "pass",
        "fixtures_tested": len(results),
        "passed": passed,
        "failed": failed,
        "results": results,
    }


def _check_output_facts(fixture: SemanticFixture) -> list[CheckedFact]:
    facts: list[CheckedFact] = []
    expected = fixture.expected_facts
    for index, text in enumerate(expected.get("required_output", [])):
        found = text in fixture.captured_output
        facts.append(CheckedFact(
            f"required_output[{index}]",
            "pass" if found else "fail",
            f"captured output {'contains' if found else 'does not contain'} {text!r}",
        ))
    for index, text in enumerate(expected.get("forbidden_output", [])):
        found = text in fixture.captured_output
        facts.append(CheckedFact(
            f"forbidden_output[{index}]",
            "fail" if found else "pass",
            f"captured output {'contains forbidden' if found else 'omits forbidden'} {text!r}",
        ))

    writes = expected.get("artifact_expectations", {}).get("writes")
    if writes == "none":
        facts.append(CheckedFact(
            "artifact_expectations.writes",
            "pass",
            "fixture expects no artifact writes; offline eval performed none",
        ))
    return facts


def _check_seeded_artifact_facts(fixture: SemanticFixture) -> list[CheckedFact]:
    facts: list[CheckedFact] = []
    by_path = {
        item["path"]: item["content"]
        for item in fixture.seeded_state.get("files", [])
        if isinstance(item, dict) and isinstance(item.get("path"), str)
    }

    for index, expected in enumerate(fixture.expected_facts.get("required_artifacts", [])):
        fact_name = f"required_artifacts[{index}]"
        if not isinstance(expected, dict):
            facts.append(CheckedFact(fact_name, "fail", "expected artifact fact must be an object"))
            continue

        path = expected.get("path")
        if not isinstance(path, str) or not path.strip():
            facts.append(CheckedFact(fact_name, "fail", "expected artifact fact must name a path"))
            continue

        content = by_path.get(path)
        if content is None:
            facts.append(CheckedFact(fact_name, "fail", f"seeded artifact {path!r} is missing"))
            continue

        missing = [text for text in expected.get("contains", []) if text not in content]
        if missing:
            facts.append(CheckedFact(fact_name, "fail", f"seeded artifact {path!r} lacks {missing[0]!r}"))
        else:
            facts.append(CheckedFact(fact_name, "pass", f"seeded artifact {path!r} matched"))
    return facts


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Offline semantic eval runner for captured Agentera skill fixtures."
    )
    parser.add_argument("fixtures", nargs="+", type=Path, help="Semantic fixture Markdown files to evaluate.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = build_report([evaluate_fixture_file(path) for path in args.fixtures])
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
