"""Regression coverage for the routing and execution vocabulary authority."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
AUTHORITY = REPO_ROOT / "references" / "cli" / "routing-execution-vocabulary.yaml"

EXPECTED_CONCEPTS = [
    "request_to_capability_routing",
    "next_action_recommendation",
    "orkestrera_task_assignment",
    "worker_launch",
    "runtime_subagent_support",
    "worker_safety_git_commit",
]

EXPECTED_CLASSIFICATIONS = [
    "canonical_concept",
    "compatibility_identifier",
    "code_identifier",
    "path_like_reference",
    "historical_record",
    "fixture_only",
    "generic_plain_language",
    "ambiguous_current_prose",
]

CURRENT_PROSE_FILES = [
    "AGENTS.md",
    "references/cli/vocabulary.md",
    "references/adapters/runtime-feature-parity.md",
    "scripts/measure_token_payload.py",
    "skills/agentera/SKILL.md",
    "skills/agentera/references/contract.md",
    "skills/agentera/capabilities/realisera/instructions.md",
    "skills/agentera/capabilities/optimera/instructions.md",
    "skills/agentera/capabilities/orkestrera/instructions.md",
    "tests/test_skill_dispatch_contract.py",
    "tests/test_runtime_adapters.py",
    "tests/test_runtime_adapter_registry.py",
]

VOCABULARY_RE = re.compile(
    r"\b(dispatcher|dispatch|router|conductor)\b"
    r"|subagent_dispatch|pre-dispatch|worktree dispatch|runtime dispatch substrate",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ClassifiedOccurrence:
    path_pattern: str
    text_pattern: str
    classification: str
    reason: str

    def matches(self, relative_path: str, text: str) -> bool:
        return re.search(self.path_pattern, relative_path) is not None and re.search(
            self.text_pattern,
            text,
            re.IGNORECASE,
        ) is not None


def _authority() -> dict:
    return yaml.safe_load(AUTHORITY.read_text(encoding="utf-8"))


def _focused_scan() -> list[tuple[str, int, str, str]]:
    matches: list[tuple[str, int, str, str]] = []
    for relative_path in _authority()["focused_scan"]["paths"]:
        path = REPO_ROOT / relative_path
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if match := VOCABULARY_RE.search(line):
                matches.append((relative_path, line_number, match.group(0), line.strip()))
    return matches


def _classified_occurrences() -> list[ClassifiedOccurrence]:
    return [
        ClassifiedOccurrence(
            entry["path"],
            entry["text"],
            entry["classification"],
            entry["reason"],
        )
        for entry in _authority()["focused_scan"]["allowed_occurrences"]
    ]


def _classification_for(relative_path: str, text: str) -> ClassifiedOccurrence | None:
    for occurrence in _classified_occurrences():
        if occurrence.matches(relative_path, text):
            return occurrence
    return None


def test_canonical_routing_execution_concepts_are_ordered_and_defined() -> None:
    authority = _authority()

    assert authority["canonical_concept_order"] == EXPECTED_CONCEPTS
    assert list(authority["canonical_concepts"]) == EXPECTED_CONCEPTS
    for concept in EXPECTED_CONCEPTS:
        entry = authority["canonical_concepts"][concept]
        assert entry["definition"].strip()
        assert entry["preferred_terms"]
        assert entry["forbidden_ambiguous_shortcuts"]
        assert not set(entry["preferred_terms"]).intersection(
            entry["forbidden_ambiguous_shortcuts"]
        )


def test_required_concepts_capture_preferred_and_forbidden_terms() -> None:
    concepts = _authority()["canonical_concepts"]

    assert "Agentera router" in concepts["request_to_capability_routing"]["preferred_terms"]
    assert "master dispatcher" in concepts["request_to_capability_routing"]["forbidden_ambiguous_shortcuts"]
    assert "suggest" in concepts["next_action_recommendation"]["preferred_terms"]
    assert "dispatch" in concepts["next_action_recommendation"]["forbidden_ambiguous_shortcuts"]
    assert "delegate" in concepts["orkestrera_task_assignment"]["preferred_terms"]
    assert "conductor" in concepts["orkestrera_task_assignment"]["forbidden_ambiguous_shortcuts"]
    assert "spawn" in concepts["worker_launch"]["preferred_terms"]
    assert "worktree dispatch" in concepts["worker_launch"]["forbidden_ambiguous_shortcuts"]
    assert "subagent mechanism" in concepts["runtime_subagent_support"]["preferred_terms"]
    assert "runtime dispatch substrate" in concepts["runtime_subagent_support"]["forbidden_ambiguous_shortcuts"]
    assert "pre-spawn Git commit" in concepts["worker_safety_git_commit"]["preferred_terms"]
    assert "pre-dispatch commit" in concepts["worker_safety_git_commit"]["forbidden_ambiguous_shortcuts"]


def test_compatibility_code_historical_and_fixture_terms_are_preserved() -> None:
    authority = _authority()
    compatibility = authority["compatibility_identifiers"]

    assert "subagent_dispatch" in compatibility["runtime_adapter"]
    assert "RuntimeAdapter.subagent_dispatch" in compatibility["runtime_adapter"]
    assert "subagent_dispatch" in authority["code_identifiers"]
    assert "test_runtime_adapter_subagent_dispatch_metadata_is_complete" in authority["code_identifiers"]
    assert "pre-dispatch commit" in authority["historical_terms"]
    assert "worktree dispatch" in authority["historical_terms"]
    assert "subagent_dispatch fixture" in authority["fixture_terms"]


def test_classification_rules_are_closed_and_actionable() -> None:
    authority = _authority()

    assert authority["classification_order"] == EXPECTED_CLASSIFICATIONS
    assert list(authority["classification_rules"]) == EXPECTED_CLASSIFICATIONS
    for classification in EXPECTED_CLASSIFICATIONS:
        rule = authority["classification_rules"][classification]
        assert rule["meaning"].strip()
        assert rule["action"].strip()

    assert "Preserve" in authority["classification_rules"]["compatibility_identifier"]["action"]
    assert "Preserve" in authority["classification_rules"]["code_identifier"]["action"]
    assert "Replace or qualify" in authority["classification_rules"]["ambiguous_current_prose"]["action"]


def test_focused_scan_classifications_are_closed_and_reasoned() -> None:
    focused_scan = _authority()["focused_scan"]
    allowed_classifications = set(focused_scan["allowed_classifications"])

    assert focused_scan["allowed_classifications"] == [
        "canonical",
        "compatibility-preserved",
        "historical",
        "fixture-only",
        "code-identifier",
        "generic",
    ]
    assert set(focused_scan["paths"]) == set(CURRENT_PROSE_FILES)
    for occurrence in _classified_occurrences():
        assert occurrence.classification in allowed_classifications
        assert occurrence.reason.strip()


def test_focused_routing_execution_occurrences_are_classified() -> None:
    unclassified = [
        f"{path}:{line_number}: {term!r}: {text}"
        for path, line_number, term, text in _focused_scan()
        if _classification_for(path, text) is None
    ]

    assert unclassified == []


def test_focused_scan_exercises_every_allowed_classification() -> None:
    classifications = {
        classification.classification
        for path, _line_number, _term, text in _focused_scan()
        if (classification := _classification_for(path, text)) is not None
    }

    assert classifications == set(_authority()["focused_scan"]["allowed_classifications"])


def test_vocabulary_docs_delegate_routing_execution_authority_to_yaml() -> None:
    vocabulary = (REPO_ROOT / "references" / "cli" / "vocabulary.md").read_text(encoding="utf-8")
    section = vocabulary.split("### Routing and execution vocabulary", 1)[1].split(
        "## Artifact grammar", 1
    )[0]

    assert "references/cli/routing-execution-vocabulary.yaml" in section
    assert "machine-readable authority" in section
    assert "Agentera router" in section
    assert "suggest" in section
    assert "delegate" in section
    assert "spawn" in section
    assert "subagent mechanism" in section
    assert "pre-spawn Git commit" in section
    assert "Do not replace this with a parallel Markdown table" in section
    assert "| Concept |" not in section
    assert "| Preferred" not in section
    assert "| Forbidden" not in section


def test_source_index_points_to_routing_execution_authority() -> None:
    vocabulary = (REPO_ROOT / "references" / "cli" / "vocabulary.md").read_text(encoding="utf-8")

    assert (
        "| `references/cli/routing-execution-vocabulary.yaml` | Routing and execution vocabulary authority. |"
        in vocabulary
    )
    delegation = _authority()["docs_delegation"]
    assert delegation["document"] == "references/cli/vocabulary.md"
    assert delegation["authority_path"] == "references/cli/routing-execution-vocabulary.yaml"
    assert delegation["must_not_duplicate_large_table"] is True
