"""Decision 57 capability instruction contract coverage."""

from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
AUTHORITY = REPO_ROOT / "references" / "cli" / "capability-instruction-contract.yaml"


def _authority() -> dict:
    return yaml.safe_load(AUTHORITY.read_text(encoding="utf-8"))


def test_decision_57_instruction_files_define_future_and_current_state() -> None:
    authority = _authority()
    current_state = authority["current_state"]

    assert authority["decision"] == 57
    assert current_state["canonical_instruction_file"]["path"] == (
        "skills/agentera/capabilities/<name>/instructions.md"
    )
    assert current_state["canonical_instruction_file"]["status"] == (
        "future_canonical_not_yet_implemented"
    )
    assert current_state["compatibility_instruction_file"]["path"] == (
        "skills/agentera/capabilities/<name>/prose.md"
    )
    assert current_state["compatibility_instruction_file"]["status"] == (
        "current_supported_compatibility"
    )
    assert current_state["validator_requirement"]["current_required_path"] == "prose.md"
    assert current_state["validator_requirement"]["future_required_path"] == "instructions.md"


def test_first_invocation_read_values_and_obligation_are_documented() -> None:
    first_read = _authority()["first_invocation_read"]

    assert first_read["field_status"] == "future_metadata_not_yet_implemented"
    assert list(first_read["allowed_values"]) == ["full", "compact_startup", "skip"]
    assert first_read["default_future_rule"] == "full"
    assert "read `instructions.md` in full" in first_read["full_read_obligation"]
    assert first_read["allowed_values"]["full"]["obligation"] == (
        "full_instruction_file_read_required"
    )
    assert first_read["allowed_values"]["compact_startup"]["obligation"] == (
        "compact_contract_must_name_covered_guidance_and_escalation_rules"
    )
    assert first_read["allowed_values"]["skip"]["obligation"] == (
        "requires_explicit_contract_justification"
    )


def test_compact_startup_exception_has_escalation_boundaries() -> None:
    exception = _authority()["compact_startup_exception"]

    assert exception["status"] == "future_exception_boundary_documented_not_implemented"
    assert "A machine-readable startup contract is available through supported state access." in exception[
        "allowed_when"
    ]
    assert "The compact contract states when the agent must escalate to a full instruction-file read." in exception[
        "allowed_when"
    ]
    assert "The compact contract is missing, incomplete, stale, or contradictory." in exception[
        "not_allowed_when"
    ]
    assert "Safety rails, validation, exit semantics, or cross-capability boundaries are ambiguous." in exception[
        "not_allowed_when"
    ]


def test_implementation_state_keeps_later_work_explicitly_unsupported() -> None:
    state = _authority()["implementation_state"]

    assert state == {
        "instructions_md_files": "not_renamed",
        "validators_require_instructions_md": False,
        "first_invocation_read_cli_metadata": False,
        "first_invocation_read_schema_metadata": False,
        "runtime_first_invocation_behavior": False,
        "descriptors_rewritten_to_instructions_md": False,
        "package_metadata_rewritten_to_instructions_md": False,
    }


def test_compatibility_references_and_later_todos_are_preserved() -> None:
    authority = _authority()
    preserve = authority["compatibility_preservation"]["preserve_current_references_until_later_todo"]
    todos = authority["compatibility_preservation"]["later_implementation_todos"]

    assert "skills/agentera/capabilities/*/prose.md paths" in preserve
    assert "skills/agentera/capability_schema_contract.yaml directory requirements" in preserve
    assert "runtime descriptors and generated agent guidance that point to `prose.md`" in preserve
    assert "archived v1/v2 migration records and progress evidence" in preserve
    assert "Rename all capability `prose.md` files to `instructions.md`" in todos[
        "rename_files"
    ]
    assert "Add `first_invocation_read` metadata" in todos["metadata_feature"]
    assert "Prove capability directories require `instructions.md`" in todos[
        "validation_regression"
    ]


def test_surface_inventory_classifies_decision_57_surfaces() -> None:
    inventory = _authority()["surface_inventory"]

    assert inventory == {
        "decision_57": "future_canonical_contract_source",
        "todo_sequence": "separates_docs_rename_metadata_and_validation_work",
        "docs_vocabulary": "delegates_to_this_authority",
        "readme": "concise_user_facing_current_and_future_authoring_seam",
        "capability_schema_contract": "current_compatibility_validator_reference",
        "runtime_descriptors": "current_compatibility_prose_md_pointers",
        "capability_prose_files": "current_compatibility_instruction_files",
    }


def test_vocabulary_docs_delegate_instruction_contract_to_yaml() -> None:
    vocabulary = (REPO_ROOT / "docs" / "vocabulary.md").read_text(encoding="utf-8")
    section = vocabulary.split("### Capability instruction contract", 1)[1].split(
        "## Invocation and routing grammar", 1
    )[0]

    assert "references/cli/capability-instruction-contract.yaml" in section
    assert "machine-readable authority" in section
    assert "future canonical `instructions.md`" in section
    assert "current `prose.md` compatibility" in section
    assert "future `first_invocation_read` values" in section
    assert "does not emit\n`first_invocation_read` metadata" in section
    assert "Do not replace this with a parallel Markdown table" in section
    assert "| Value |" not in section
    assert "| Mode |" not in section


def test_readme_explains_current_compatibility_without_claiming_metadata() -> None:
    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")

    assert "references/cli/capability-instruction-contract.yaml" in readme
    assert "Every capability has `prose.md`" in readme
    assert "future contract renames" in readme
    assert "`first_invocation_read`" in readme
    assert "future metadata is not emitted by the CLI" in readme


def test_source_indexes_point_to_instruction_contract_authority() -> None:
    vocabulary = (REPO_ROOT / "docs" / "vocabulary.md").read_text(encoding="utf-8")
    docs = yaml.safe_load((REPO_ROOT / ".agentera" / "docs.yaml").read_text(encoding="utf-8"))

    assert (
        "| `references/cli/capability-instruction-contract.yaml` | Decision 57 capability instruction-file and first-invocation read contract authority. |"
        in vocabulary
    )
    assert any(
        item["path"] == "references/cli/capability-instruction-contract.yaml"
        for item in docs["index"]
    )
    delegation = _authority()["docs_delegation"]
    assert delegation["document"] == "docs/vocabulary.md"
    assert delegation["authority_path"] == "references/cli/capability-instruction-contract.yaml"
    assert delegation["must_not_duplicate_large_table"] is True
