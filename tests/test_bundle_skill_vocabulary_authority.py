"""Regression coverage for the bundle and SKILL.md vocabulary authority."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
import re

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
AUTHORITY = REPO_ROOT / "references" / "cli" / "bundle-skill-vocabulary.yaml"

EXPECTED_CONCEPTS = [
    "agentera_app_files",
    "suite_package",
    "plugin_shipped_hooks",
    "removed_bundle_status_command",
    "agentera_routing_entry",
    "skill_entry_file",
    "v1_skill_entry_file",
    "legacy_hej_bridge",
]

EXPECTED_CLASSIFICATIONS = [
    "canonical_concept",
    "compatibility_identifier",
    "path_like_reference",
    "package_metadata",
    "historical_record",
    "fixture_only",
    "generic_plain_language",
    "ambiguous_current_prose",
]

CURRENT_PROSE_FILES = [
    "AGENTS.md",
    "README.md",
    "references/adapters/opencode.md",
    "scripts/measure_token_payload.py",
    "skills/agentera/SKILL.md",
    "skills/agentera/capabilities/hej/schemas/triggers.yaml",
    "skills/agentera/capabilities/resonera/instructions.md",
    "tests/test_cross_capability.py",
    "tests/test_resonera_capability.py",
    "tests/test_runtime_adapters.py",
]

AMBIGUOUS_CURRENT_SKILL_PROSE = [
    "Master dispatcher",
    "master dispatcher",
    "master SKILL.md",
    "reads `SKILL.md`",
    "SKILL.md source",
    "Agentera SKILL.md",
    "SKILL.md workflow behavior",
    "keeps `SKILL.md` a dispatcher",
]

VOCABULARY_RE = re.compile(r"bundle|SKILL\.md", re.IGNORECASE)


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


@lru_cache
def _focused_scan() -> tuple[tuple[str, int, str, str], ...]:
    matches: list[tuple[str, int, str, str]] = []
    for relative_path in _authority()["focused_scan"]["paths"]:
        path = REPO_ROOT / relative_path
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if match := VOCABULARY_RE.search(line):
                matches.append((relative_path, line_number, match.group(0), line.strip()))
    return tuple(matches)


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


def test_canonical_bundle_and_skill_concepts_are_ordered_and_defined() -> None:
    authority = _authority()

    assert authority["canonical_concept_order"] == EXPECTED_CONCEPTS
    assert list(authority["canonical_concepts"]) == EXPECTED_CONCEPTS
    for concept in EXPECTED_CONCEPTS:
        entry = authority["canonical_concepts"][concept]
        assert entry["definition"].strip()
        assert entry["allowed_terms"]
        assert entry["forbidden_ambiguous_shortcuts"]
        assert not set(entry["allowed_terms"]).intersection(
            entry["forbidden_ambiguous_shortcuts"]
        )


def test_required_concepts_capture_allowed_and_forbidden_terms() -> None:
    concepts = _authority()["canonical_concepts"]

    assert "Agentera app files" in concepts["agentera_app_files"]["allowed_terms"]
    assert "bundle" in concepts["agentera_app_files"]["forbidden_ambiguous_shortcuts"]
    assert "suite-bundle" in concepts["suite_package"]["allowed_terms"]
    assert "plugin-shipped hooks" in concepts["plugin_shipped_hooks"]["allowed_terms"]
    assert (
        "removed `bundle-status` command"
        in concepts["removed_bundle_status_command"]["allowed_terms"]
    )
    assert (
        "Agentera routing entry point"
        in concepts["agentera_routing_entry"]["allowed_terms"]
    )
    assert "Agentera skill dispatcher" in concepts["agentera_routing_entry"][
        "forbidden_ambiguous_shortcuts"
    ]
    assert "SKILL.md" in concepts["agentera_routing_entry"][
        "forbidden_ambiguous_shortcuts"
    ]
    assert "skill entry file" in concepts["skill_entry_file"]["allowed_terms"]
    assert "v1 skill entry file" in concepts["v1_skill_entry_file"]["allowed_terms"]
    assert "legacy hej bridge" in concepts["legacy_hej_bridge"]["allowed_terms"]


def test_compatibility_surfaces_and_metadata_are_preserved() -> None:
    authority = _authority()
    compatibility = authority["compatibility_identifiers"]

    assert ".agentera-bundle.json" in compatibility["bundle"]
    assert "bundle.status" in compatibility["bundle"]
    assert "activeBundleRoot" in compatibility["bundle"]
    assert "--only bundle" in compatibility["bundle"]
    assert "skills/agentera/SKILL.md" in compatibility["skill_entry_file"]
    assert "skills/*/SKILL.md" in compatibility["skill_entry_file"]
    assert "suite-bundle" in authority["package_metadata_values"]
    assert "agentera bundle-status" in authority["historical_terms"]


def test_classification_rules_are_closed_and_actionable() -> None:
    authority = _authority()

    assert authority["classification_order"] == EXPECTED_CLASSIFICATIONS
    assert list(authority["classification_rules"]) == EXPECTED_CLASSIFICATIONS
    for classification in EXPECTED_CLASSIFICATIONS:
        rule = authority["classification_rules"][classification]
        assert rule["meaning"].strip()
        assert rule["action"].strip()

    assert "Preserve" in authority["classification_rules"]["compatibility_identifier"]["action"]
    assert "Replace or qualify" in authority["classification_rules"]["ambiguous_current_prose"]["action"]


def test_focused_scan_classifications_are_closed_and_reasoned() -> None:
    focused_scan = _authority()["focused_scan"]
    allowed_classifications = set(focused_scan["allowed_classifications"])

    assert focused_scan["allowed_classifications"] == [
        "canonical",
        "compatibility-preserved",
        "historical",
        "fixture-only",
        "generic",
    ]
    assert set(focused_scan["paths"]) == set(CURRENT_PROSE_FILES + ["references/cli/vocabulary.md"])
    for occurrence in _classified_occurrences():
        assert occurrence.classification in allowed_classifications
        assert occurrence.reason.strip()


def test_focused_bundle_and_skillmd_occurrences_are_classified() -> None:
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


def test_vocabulary_docs_delegate_bundle_skill_authority_to_yaml() -> None:
    vocabulary = (REPO_ROOT / "references" / "cli" / "vocabulary.md").read_text(encoding="utf-8")
    section = vocabulary.split("### Bundle and SKILL.md vocabulary", 1)[1].split(
        "## Evaluation and evidence grammar", 1
    )[0]

    assert "references/cli/bundle-skill-vocabulary.yaml" in section
    assert "machine-readable authority" in section
    assert "Do not replace this with a parallel Markdown table" in section
    assert "Agentera app files" in section
    assert "Agentera routing entry point" in section
    assert "legacy hej bridge" in section
    assert "| Concept |" not in section
    assert "| Allowed" not in section
    assert "| Forbidden" not in section


def test_source_index_points_to_bundle_skill_authority() -> None:
    vocabulary = (REPO_ROOT / "references" / "cli" / "vocabulary.md").read_text(encoding="utf-8")

    assert (
        "| `references/cli/bundle-skill-vocabulary.yaml` | Bundle and `SKILL.md` concept classification authority. |"
        in vocabulary
    )
    delegation = _authority()["docs_delegation"]
    assert delegation["document"] == "references/cli/vocabulary.md"
    assert delegation["authority_path"] == "references/cli/bundle-skill-vocabulary.yaml"
    assert delegation["must_not_duplicate_large_table"] is True


def test_current_installed_app_diagnostics_use_authority_terms() -> None:
    authority = _authority()
    allowed_terms = set(authority["canonical_concepts"]["agentera_app_files"]["allowed_terms"])
    diagnostics = "\n".join(
        [
            (REPO_ROOT / "scripts" / "agentera").read_text(encoding="utf-8"),
            (REPO_ROOT / "scripts" / "agentera_upgrade.py").read_text(encoding="utf-8"),
            (REPO_ROOT / "UPGRADE.md").read_text(encoding="utf-8"),
        ]
    )

    assert "Agentera app files" in allowed_terms
    assert "app files" in allowed_terms
    assert "installed app" in allowed_terms
    assert "Agentera app files are not up to date" in diagnostics
    assert "approve app files repair" in diagnostics
    assert "Agentera app state is not fresh" not in diagnostics
    assert "Agentera app state is not up to date" not in diagnostics
    assert "approval to refresh installed apps" not in diagnostics
    assert "approve app refresh" not in diagnostics
    assert "bundle fresh" + "ness" not in diagnostics
    assert "bundle refresh" not in diagnostics


def test_current_skill_dispatcher_prose_uses_qualified_terms() -> None:
    current_prose = "\n".join(
        (REPO_ROOT / path).read_text(encoding="utf-8")
        for path in CURRENT_PROSE_FILES
    )

    assert "Agentera skill dispatcher" not in current_prose
    assert "routing layer" in current_prose or "Agentera routing entry point" in current_prose or "Agentera router" in current_prose
    assert "skill entry file" in current_prose
    for ambiguous in AMBIGUOUS_CURRENT_SKILL_PROSE:
        assert ambiguous not in current_prose
