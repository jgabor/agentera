"""Regression tests for evaluator-handoff citation contract.

Authority: references/cli/capability-instruction-contract.yaml#evaluator_handoff
Ported minimally from packages/cli/src/registries/evaluatorHandoffContract.ts.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACT_PATH = REPO_ROOT / "references" / "cli" / "capability-instruction-contract.yaml"
SAMPLE_REPORT_PATH = REPO_ROOT / "tests" / "fixtures" / "oracle" / "inspektera-evaluation-report.json"
EVALUATOR_HANDOFF_REPORT_SCHEMA_VERSION = "agentera.inspekteraEvaluationReport.v1"


def _load_yaml_mapping(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def load_evaluator_handoff_contract(contract_path: Path = CONTRACT_PATH) -> dict[str, Any]:
    data = _load_yaml_mapping(contract_path)
    handoff = data.get("evaluator_handoff")
    if not isinstance(handoff, dict):
        raise ValueError(f"evaluator_handoff section missing in {contract_path}")
    row_schema = handoff.get("row_schema") if isinstance(handoff.get("row_schema"), dict) else {}
    citation_formats = (
        row_schema.get("citation_formats") if isinstance(row_schema.get("citation_formats"), dict) else {}
    )
    file_line = citation_formats.get("file_line") if isinstance(citation_formats.get("file_line"), dict) else {}
    not_applicable = (
        citation_formats.get("not_applicable")
        if isinstance(citation_formats.get("not_applicable"), dict)
        else {}
    )
    warn_verify = (
        row_schema.get("warn_verify_command")
        if isinstance(row_schema.get("warn_verify_command"), dict)
        else {}
    )
    pattern_source = str(file_line.get("pattern") or r"^[^:\s]+:\d+$")
    return {
        "path": str(contract_path),
        "status": str(handoff.get("status") or "unknown").strip(),
        "report_schema_version": str(handoff.get("report_schema_version") or EVALUATOR_HANDOFF_REPORT_SCHEMA_VERSION).strip(),
        "citation_required_for": [
            str(value) for value in (row_schema.get("citation_required_for") or ["WARN", "FAIL"])
        ],
        "file_line_pattern": re.compile(pattern_source),
        "not_applicable_prefix": str(not_applicable.get("prefix") or "not-applicable:").strip(),
        "min_not_applicable_reason_length": int(not_applicable.get("min_reason_length") or 8),
        "warn_verify_command_required": warn_verify.get("required_when") == "file_line_citation",
        "warn_verify_command_prefixes": [
            str(value) for value in (warn_verify.get("allowed_prefixes") or ["grep", "git show"])
        ],
    }


def is_file_line_citation(citation: str, contract: dict[str, Any]) -> bool:
    return bool(contract["file_line_pattern"].match(citation))


def is_not_applicable_citation(citation: str, contract: dict[str, Any]) -> bool:
    prefix = contract["not_applicable_prefix"]
    if not citation.startswith(prefix):
        return False
    reason = citation[len(prefix) :].strip()
    return len(reason) >= contract["min_not_applicable_reason_length"]


def is_valid_citation(citation: str, contract: dict[str, Any]) -> bool:
    trimmed = citation.strip()
    if not trimmed:
        return False
    return is_file_line_citation(trimmed, contract) or is_not_applicable_citation(trimmed, contract)


def is_allowed_verify_command(command: str, contract: dict[str, Any]) -> bool:
    trimmed = command.strip()
    return any(trimmed.startswith(prefix) for prefix in contract["warn_verify_command_prefixes"])


def validate_evaluation_report_row(row: dict[str, Any], index: int, contract: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    label = f"rows[{index}]"
    status = str(row.get("status") or "").strip().upper()
    criterion = str(row.get("criterion") or "").strip()
    evidence = str(row.get("evidence") or "").strip()

    if not criterion:
        errors.append(f"{label}: missing criterion")
    if not status:
        errors.append(f"{label}: missing status")
    if not evidence:
        errors.append(f"{label}: missing evidence")

    if status not in contract["citation_required_for"]:
        return errors

    citation = str(row.get("citation") or "").strip()
    if not citation:
        errors.append(f"{label}: WARN/FAIL row missing citation")
        return errors
    if not is_valid_citation(citation, contract):
        errors.append(
            f"{label}: citation must be file:line (e.g. TODO.md:15) or not-applicable: <reason> "
            f"(min {contract['min_not_applicable_reason_length']} chars)"
        )
        return errors

    if (
        status == "WARN"
        and contract["warn_verify_command_required"]
        and is_file_line_citation(citation, contract)
    ):
        verify_command = str(row.get("verify_command") or "").strip()
        if not verify_command:
            errors.append(f"{label}: WARN row with file:line citation missing verify_command")
        elif not is_allowed_verify_command(verify_command, contract):
            errors.append(f"{label}: verify_command must start with grep or git show")

    return errors


def validate_evaluation_report(report: dict[str, Any], contract: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    schema_version = str(report.get("schemaVersion") or "").strip()
    if schema_version and schema_version != contract["report_schema_version"]:
        errors.append(f"schemaVersion must be {contract['report_schema_version']}")
    rows = report.get("rows")
    if not isinstance(rows, list) or not rows:
        errors.append("rows must be a non-empty array")
        return errors
    for index, row in enumerate(rows):
        if isinstance(row, dict):
            errors.extend(validate_evaluation_report_row(row, index, contract))
    return errors


def verify_warn_citation_at_line(row: dict[str, Any], repo_root: Path) -> tuple[bool, str]:
    citation = str(row.get("citation") or "").strip()
    verify_command = str(row.get("verify_command") or "").strip()
    match = re.match(r"^([^:\s]+):(\d+)$", citation)
    if not match:
        return True, "not-applicable citation skips line verification"
    if not verify_command:
        return False, "missing verify_command for file:line citation"
    line_number = int(match.group(2))
    try:
        completed = subprocess.run(
            verify_command,
            cwd=repo_root,
            shell=True,
            check=False,
            capture_output=True,
            text=True,
        )
        output = completed.stdout
        line_ref = f"{line_number}:"
        line_ref_alt = f"{line_number}-"
        if line_ref in output or any(line.startswith(line_ref_alt) for line in output.splitlines()):
            return True, "verify_command output references cited line"
        return False, f"verify_command output does not reference line {line_number} for {match.group(1)}"
    except OSError as exc:
        return False, f"verify_command failed: {exc}"


class TestEvaluatorHandoffContractLoader:
    def test_loads_citation_requirements_from_contract_yaml(self):
        contract = load_evaluator_handoff_contract()
        assert contract["status"] == "implemented"
        assert contract["report_schema_version"] == EVALUATOR_HANDOFF_REPORT_SCHEMA_VERSION
        assert contract["citation_required_for"] == ["WARN", "FAIL"]
        assert contract["warn_verify_command_required"] is True
        assert contract["warn_verify_command_prefixes"] == ["grep", "git show"]

    def test_accepts_file_line_and_not_applicable_citations(self):
        contract = load_evaluator_handoff_contract()
        assert is_valid_citation("TODO.md:15", contract)
        assert is_valid_citation(
            "not-applicable: runtime-only metric with no file anchor",
            contract,
        )
        assert not is_valid_citation("prose only", contract)
        assert not is_valid_citation("not-applicable: short", contract)

    def test_fails_validation_when_warn_fail_rows_lack_citation(self):
        contract = load_evaluator_handoff_contract()
        errors = validate_evaluation_report(
            {
                "schemaVersion": EVALUATOR_HANDOFF_REPORT_SCHEMA_VERSION,
                "rows": [
                    {"criterion": "test", "status": "WARN", "evidence": "missing citation"},
                    {"criterion": "test2", "status": "FAIL", "evidence": "also missing"},
                ],
            },
            contract,
        )
        assert any("missing citation" in error for error in errors)
        assert len(errors) >= 2

    def test_fails_validation_when_warn_row_with_file_line_lacks_verify_command(self):
        contract = load_evaluator_handoff_contract()
        errors = validate_evaluation_report(
            {
                "rows": [
                    {
                        "criterion": "test",
                        "status": "WARN",
                        "evidence": "found issue",
                        "citation": "TODO.md:1",
                    }
                ]
            },
            contract,
        )
        assert any("missing verify_command" in error for error in errors)

    def test_passes_validation_for_sample_inspektera_evaluation_report_fixture(self):
        contract = load_evaluator_handoff_contract()
        report = json.loads(SAMPLE_REPORT_PATH.read_text(encoding="utf-8"))
        errors = validate_evaluation_report(report, contract)
        assert errors == []


class TestInspekteraEvaluationReportCitationRegression:
    def test_every_warn_fail_entry_in_sample_report_carries_valid_citation(self):
        contract = load_evaluator_handoff_contract()
        report = json.loads(SAMPLE_REPORT_PATH.read_text(encoding="utf-8"))
        warn_fail_rows = [
            row
            for row in report["rows"]
            if str(row.get("status", "")).upper() in {"WARN", "FAIL"}
        ]
        assert warn_fail_rows
        for row in warn_fail_rows:
            assert is_valid_citation(str(row.get("citation", "")), contract), row

    def test_re_verifies_warn_file_line_citations_with_fixture_verify_command(self):
        contract = load_evaluator_handoff_contract()
        report = json.loads(SAMPLE_REPORT_PATH.read_text(encoding="utf-8"))
        warn_rows = [
            row
            for row in report["rows"]
            if str(row.get("status", "")).upper() == "WARN"
            and ":" in str(row.get("citation", ""))
            and row.get("verify_command")
        ]
        assert warn_rows
        for row in warn_rows:
            ok, message = verify_warn_citation_at_line(row, REPO_ROOT)
            assert ok, message


class TestOrkestreraValidationContractPresence:
    def test_orkestrera_validation_v10_and_contract_evaluator_handoff_present(self):
        validation = yaml.safe_load(
            (REPO_ROOT / "skills/agentera/capabilities/orkestrera/schemas/validation.yaml").read_text(
                encoding="utf-8"
            )
        )
        rules = validation.get("VALIDATION") if isinstance(validation, dict) else {}
        v10 = rules.get(10) if isinstance(rules, dict) else None
        assert isinstance(v10, dict)
        assert v10.get("id") == "V10"
        assert "evaluator_handoff" in str(v10.get("description", ""))

        contract = _load_yaml_mapping(CONTRACT_PATH)
        handoff = contract.get("evaluator_handoff")
        assert isinstance(handoff, dict)
        assert handoff.get("status") == "implemented"
