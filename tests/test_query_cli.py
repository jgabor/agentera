"""Tests for scripts/agentera CLI (query and prime commands).

Proportionality: 1 pass + 1 fail per state command (last-phase, decisions,
health, todo) plus prime command. Edge cases for empty artifacts,
missing artifacts, and filter-no-match.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = str(REPO_ROOT / "scripts" / "agentera")
SCHEMAS_SRC = REPO_ROOT / "skills" / "agentera" / "schemas" / "artifacts"
CONTRACT_PATH = REPO_ROOT / "references" / "cli" / "agent-ready-state-contract.yaml"


def _run(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
    env = None
    if cwd is not None:
        import os
        agentera_home = REPO_ROOT if args and args[0] in {"hej", "prime"} else cwd
        env = {
            **os.environ,
            "AGENTERA_HOME": str(agentera_home),
            "XDG_DATA_HOME": str(cwd / ".xdg"),
            "PROFILERA_PROFILE_DIR": str(cwd / ".xdg" / "agentera"),
        }
    return subprocess.run(
        [sys.executable, CLI, *args],
        capture_output=True,
        text=True,
        cwd=cwd,
        env=env,
    )


def _run_installed(app_home: Path, *args: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, CLI, *args],
        capture_output=True,
        text=True,
        cwd=cwd,
        env={
            **os.environ,
            "AGENTERA_HOME": str(app_home),
            "XDG_DATA_HOME": str(cwd / ".xdg"),
            "PROFILERA_PROFILE_DIR": str(cwd / ".xdg" / "agentera"),
        },
    )



def _run_prime_context(capability: str, *, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return _run("prime", "--context", capability, "--format", "json", cwd=cwd)


def _prime_startup_capsule(data: dict) -> dict:
    return data["capability_context"]


def _flat_capability_context(data: dict) -> dict:
    capsule = _prime_startup_capsule(data)
    context = capsule.get("context", {})
    state = capsule.get("state", {})
    flat = {
        "capability": capsule.get("capability"),
        "declared_state_needs": state.get("declared_read_needs", []),
        "declared_write_targets": state.get("declared_write_targets", []),
        "artifact_inventory": state.get("artifact_inventory", {}),
        "included_state_families": state.get("included", []),
        "missing_state_families": state.get("missing", []),
        "cli_fallback": state.get("fallback_commands", []),
        "raw_artifact_read_policy": capsule.get("raw_artifact_read_policy"),
        "schema_error": state.get("schema_error"),
    }
    if context.get("first_invocation_read") is not None:
        flat["first_invocation_read"] = context["first_invocation_read"]
    planning = context.get("planning_context")
    if isinstance(planning, dict) and planning.get("startup_contract") is not None:
        flat["startup_contract"] = planning["startup_contract"]
    return flat


def _prime_bespoke_context(data: dict, name: str):
    if name in data:
        return data[name]
    capsule = _prime_startup_capsule(data)
    return capsule.get("context", {}).get(name)


def _install_schema_surface(app_home: Path) -> Path:
    schemas_dir = app_home / "app" / "skills" / "agentera" / "schemas" / "artifacts"
    schemas_dir.mkdir(parents=True, exist_ok=True)
    for schema_file in SCHEMAS_SRC.glob("*.yaml"):
        (schemas_dir / schema_file.name).write_text(schema_file.read_text(encoding="utf-8"), encoding="utf-8")
    return schemas_dir


def _install_runtime_surface(app_home: Path) -> Path:
    app_root = app_home / "app"
    for directory in (
        "scripts",
        "skills",
        "references",
        "hooks",
        "agents",
        ".agents/plugins",
        ".codex-plugin",
        ".cursor-plugin",
        ".cursor",
        ".claude-plugin",
        ".github/hooks",
        ".github/plugin",
        ".opencode/commands",
        ".opencode/agents",
        ".opencode/plugins",
    ):
        source = REPO_ROOT / directory
        if source.exists():
            shutil.copytree(source, app_root / directory)
    for filename in (
        "README.md",
        "UPGRADE.md",
        "CHANGELOG.md",
        "DESIGN.md",
        "LICENSE",
        "pyproject.toml",
        "uv.lock",
        "registry.json",
        "plugin.json",
        ".opencode/package.json",
    ):
        source = REPO_ROOT / filename
        if source.exists():
            target = app_root / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    (app_root / ".agentera-bundle.json").write_text(json.dumps({"version": "2.3.5"}), encoding="utf-8")
    return app_root / "scripts" / "agentera"


@pytest.fixture()
def project(tmp_path: Path):
    dst = tmp_path / "skills" / "agentera" / "schemas" / "artifacts"
    dst.mkdir(parents=True, exist_ok=True)
    for f in SCHEMAS_SRC.glob("*.yaml"):
        (dst / f.name).write_text(f.read_text())
    return tmp_path


def _write_artifact(project: Path, rel: str, data: dict) -> Path:
    p = project / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(yaml.dump(data, default_flow_style=False))
    return p


def _write_fixture_artifact(project: Path, fixture: dict) -> Path:
    rel = fixture["path"].replace("<name>", "test-objective")
    return _write_artifact(project, rel, fixture["data"])


def _seed_inspektera_evidence_context(
    project: Path,
    *,
    acceptance: list[str] | None = None,
    progress_verified: str | None = "evidence context tests passed",
    docs_last_audit: str | None = None,
    health_timestamp: str | None = None,
    docs_conventions: dict | None = None,
    decisions: dict | None = None,
) -> None:
    _write_artifact(project, ".agentera/plan.yaml", {
        "header": {"title": "2.3.10 Inspektera Evidence Context Source Contract", "status": "active"},
        "tasks": [
            {"number": 1, "name": "Inventory", "status": "complete", "evidence": ["done"]},
            {
                "number": 2,
                "name": "Focused evidence-context regression coverage",
                "status": "pending",
                "depends_on": [1],
                "acceptance": acceptance if acceptance is not None else ["emit context"],
            },
        ],
    })
    _write_artifact(project, ".agentera/progress.yaml", {
        "cycles": [{
            "number": 10,
            "timestamp": health_timestamp or date.today().isoformat(),
            "verified": progress_verified,
        }],
    })
    _write_artifact(project, ".agentera/docs.yaml", {
        "last_audit": docs_last_audit or date.today().isoformat(),
        "mapping": [{"artifact": "PLAN.md", "path": ".agentera/plan.yaml"}],
        "index": [{"document": "Plan", "path": ".agentera/plan.yaml"}],
        "conventions": docs_conventions if docs_conventions is not None else {
            "semver_policy": {"feat": "minor"},
            "version_files": ["pyproject.toml"],
        },
    })
    _write_artifact(project, ".agentera/health.yaml", {
        "audits": [{
            "number": 12,
            "timestamp": health_timestamp or date.today().isoformat(),
            "trajectory": "stable",
            "grades": {"Architecture": "B"},
        }],
    })
    _write_artifact(project, "TODO.md", {
        "entries": [{"severity": "normal", "status": "open", "description": "Track 2.3.10 evidence context"}],
    })
    if decisions is not None:
        _write_artifact(project, ".agentera/decisions.yaml", decisions)


def _write_startup_benchmark_fixture(
    app_home: Path,
    *,
    latest: dict | None = None,
    history_rows: list[dict] | None = None,
    history_text: str | None = None,
) -> Path:
    benchmark_dir = app_home / "benchmarks" / "startup-state"
    benchmark_dir.mkdir(parents=True, exist_ok=True)
    report = latest if latest is not None else {
        "contract_version": "startup-state-analysis-v1",
        "generated_at": "2026-05-15T10:00:00+00:00",
        "benchmark_mode": "full_boundary_snapshot",
        "benchmark_previous_watermark_at": None,
        "benchmark_window_started_after": "2026-05-12T15:50:13+00:00",
        "benchmark_watermark_at": "2026-05-15T09:59:59+00:00",
        "runtime_coverage": [
            {"runtime": "opencode", "status": "ok", "reason": "records_extracted", "record_count": 18, "candidate_count": 1, "error_count": 0},
            {"runtime": "claude-code", "status": "degraded", "reason": "schema_divergent", "record_count": 0, "candidate_count": 2, "error_count": 1},
        ],
        "total_records": 18,
        "total_state_sequences": 9,
        "state_sequences_with_raw_after_cli": 4,
        "state_sequences_with_redundant_raw_access": 3,
        "total_cli_state_calls": 11,
        "total_raw_artifact_access_after_cli": 5,
        "total_redundant_raw_artifact_accesses": 4,
        "raw_after_cli_sequence_rate": 0.4444,
        "redundant_raw_sequence_rate": 0.3333,
        "cli_state_command_counts": {"agentera plan": 4, "agentera docs": 2},
        "raw_artifact_access_after_cli_counts": {"PLAN.md": 3, "/home/private/PLAN.md": 1},
        "redundant_raw_artifact_access_counts": {"PLAN.md": 2},
        "per_capability_state_counts": {"optimera": 4},
        "token_estimator_version": "approx_bytes_div_4_v1",
        "estimated_raw_after_cli_tokens": 621,
        "estimated_redundant_raw_tokens": 533,
        "estimated_raw_after_cli_tokens_by_artifact": {"PLAN.md": 400},
        "estimated_redundant_raw_tokens_by_artifact": {"PLAN.md": 300},
        "estimated_tokens_saved_vs_previous": None,
        "estimated_tokens_saved_vs_previous_null_reason": "previous_missing_token_estimates",
        "startup_recommendation": {
            "action": "targeted_capability_guidance_fixes",
            "measured_trigger": "raw_artifact_access_after_cli_hotspot",
            "rationale": "Raw artifact access follows CLI state, but evidence is narrow.",
        },
        "implementation_recommended": False,
    }
    (benchmark_dir / "latest-report.json").write_text(json.dumps(report, sort_keys=True) + "\n", encoding="utf-8")
    if history_text is not None:
        (benchmark_dir / "runs.jsonl").write_text(history_text, encoding="utf-8")
    else:
        rows = history_rows if history_rows is not None else [{
            "contract_version": "startup-state-analysis-v1",
            "generated_at": report["generated_at"],
            "agentera_version": "2.3.11",
            "git_commit": "0123456789abcdef0123456789abcdef01234567",
            "runtime_scope": ["opencode", "claude-code"],
            "benchmark_mode": report["benchmark_mode"],
            "total_state_sequences": report["total_state_sequences"],
            "raw_after_cli_rate": report["raw_after_cli_sequence_rate"],
            "redundant_raw_access_rate": report["redundant_raw_sequence_rate"],
            "startup_recommendation_action": report["startup_recommendation"]["action"],
        }]
        (benchmark_dir / "runs.jsonl").write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8")
    return benchmark_dir


# ---------------------------------------------------------------------------
# prime
# ---------------------------------------------------------------------------


class TestPrime:
    @pytest.fixture(scope="class")
    def prime_result(self):
        result = _run("prime")
        assert result.returncode == 0
        return result

    @pytest.fixture(scope="class")
    def prime_guidance_result(self):
        result = _run("prime", "--guidance")
        assert result.returncode == 0
        return result

    def test_default_outputs_orientation_briefing(self, prime_result):
        assert "agentera prime" in prime_result.stdout
        assert "app_home: status=" in prime_result.stdout
        assert "next_action:" in prime_result.stdout
        assert "source_contract:" in prime_result.stdout

    def test_guidance_outputs_static_prose(self, prime_guidance_result):
        assert "agentera state plan" in prime_guidance_result.stdout
        assert "native" in prime_guidance_result.stdout.lower()

    def test_prime_idempotent(self):
        first = _run("prime")
        second = _run("prime")
        assert first.returncode == 0
        assert second.returncode == 0
        assert first.stdout == second.stdout

    def test_guidance_has_routing_and_recovery(self, prime_guidance_result):
        assert "recovery" in prime_guidance_result.stdout.lower()
        assert "stale" in prime_guidance_result.stdout.lower()
        assert "missing" in prime_guidance_result.stdout.lower()

    def test_prime_no_args(self, prime_result):
        assert len(prime_result.stdout) > 100


# ---------------------------------------------------------------------------
# last-phase
# ---------------------------------------------------------------------------


class TestLastPhase:
    def test_pass_returns_phase(self, project):
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [
                {"number": 1, "phase": "build", "what": "first", "commit": "a"},
                {"number": 2, "phase": "audit", "what": "second", "commit": "b"},
            ],
        })
        r = _run("query", "last-phase", cwd=project)
        assert r.returncode == 0
        assert "audit" in r.stdout

    def test_fail_missing_artifact(self, project):
        r = _run("query", "last-phase", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""

    def test_empty_artifact(self, project):
        _write_artifact(project, ".agentera/progress.yaml", {})
        r = _run("query", "last-phase", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""


# ---------------------------------------------------------------------------
# decisions
# ---------------------------------------------------------------------------


class TestDecisions:
    def test_pass_returns_decisions(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": 1,
                    "question": "Runtime support?",
                    "choice": "Python",
                    "confidence": "firm",
                    "context": "Need runtime",
                    "reasoning": "Stdlib",
                },
            ],
        })
        r = _run("decisions", cwd=project)
        assert r.returncode == 0
        assert "number=1" in r.stdout
        assert "firm" in r.stdout

    def test_fail_missing_artifact(self, project):
        r = _run("decisions", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""

    def test_json_decisions_missing_artifact_boundary_is_explicit(self, project):
        r = _run("decisions", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        contract = data["source_contract"]
        assert data["status"] == "empty"
        assert data["entries"] == []
        assert data["source"]["exists"] is False
        assert contract["complete_for_returned_full_detail"] is False
        assert contract["complete_for_normal_deliberation_context"] is False
        assert contract["completeness"]["source_exists"] is False
        assert contract["missing_artifact_boundary"]["applies_when"] == "source.exists=false"
        assert contract["missing_artifact_boundary"]["raw_artifact_read_required"] is False
        assert contract["decision_context_truth_table"]["missing_or_unavailable_artifact"] == {
            "full_detail_complete": False,
            "normal_deliberation_context_complete": False,
            "raw_artifact_read_required": False,
            "meaning": "No decision state is available from the CLI result; use CLI fallback or diagnostics before raw artifact repair.",
        }

    def test_filter_topic_match(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": 1,
                    "question": "Runtime support?",
                    "choice": "Python",
                    "confidence": "firm",
                    "context": "Need runtime support",
                    "reasoning": "Stdlib",
                },
                {
                    "number": 2,
                    "question": "Color scheme?",
                    "choice": "Blue",
                    "confidence": "provisional",
                    "context": "Design",
                    "reasoning": "Looks nice",
                },
            ],
        })
        r = _run("decisions", "--topic", "runtime", cwd=project)
        assert r.returncode == 0
        assert "number=1" in r.stdout
        assert "number=2" not in r.stdout

    def test_filter_topic_no_match(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": 1,
                    "question": "Runtime?",
                    "choice": "Python",
                    "confidence": "firm",
                    "context": "Engine",
                    "reasoning": "Stdlib",
                },
            ],
        })
        r = _run("decisions", "--topic", "nonexistent", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""

    def test_json_decisions_include_source_contract_and_context_fields(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": 1,
                    "date": "2026-05-14",
                    "question": "Expose decision context?",
                    "context": "Agents need structured deliberation state.",
                    "alternatives": [{"name": "CLI", "status": "chosen"}],
                    "choice": "Expose structured context through the decisions command.",
                    "reasoning": "Routine state commands should avoid raw artifact reads.",
                    "confidence": "firm",
                    "feeds_into": "PLAN.md, TODO.md#DEC-1",
                    "satisfaction": {
                        "state": "user_confirmed_satisfied",
                        "user_confirmation": {"confirmed_by": "Jonathan", "confirmed_at": "2026-05-15"},
                    },
                },
            ],
        })

        r = _run("decisions", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        entry = data["entries"][0]
        assert entry["outcome"] == entry["choice"]
        assert entry["reasoning"] == "Routine state commands should avoid raw artifact reads."
        assert entry["alternatives"] == [{"name": "CLI", "status": "chosen"}]
        assert entry["confidence"] == "firm"
        assert entry["feeds_into"] == "PLAN.md, TODO.md#DEC-1"
        assert entry["downstream_consequence_references"] == [
            {"source_field": "feeds_into", "reference": "PLAN.md"},
            {"source_field": "feeds_into", "reference": "TODO.md#DEC-1"},
        ]
        assert entry["context_complete"] is True
        assert entry["missing_fields"] == []
        assert entry["compacted"] is False
        assert entry["caveats"] == []

        contract = data["source_contract"]
        assert contract["artifact"] == "DECISIONS.md"
        assert contract["complete_for_returned_decisions"] is True
        assert contract["complete_for_decision_context"] is True
        assert contract["complete_for_returned_full_detail"] is True
        assert contract["complete_for_normal_deliberation_context"] is True
        assert contract["raw_artifact_reads_required"] is False
        assert "complete_for_normal_deliberation_context" in contract["raw_artifact_read_policy"]
        assert "normal deliberation context" in contract["raw_artifact_read_policy"]
        assert "historical compacted gaps are exposed" in contract["raw_artifact_read_policy"]
        assert "no raw decision artifact read is required" in contract["fallback_behavior"]["normal"]
        assert contract["normal_deliberation_context"]["legacy_full_detail_signal"] == "complete_for_decision_context"
        assert contract["decision_context_truth_table"]["full_detail_entries"] == {
            "full_detail_complete": True,
            "normal_deliberation_context_complete": True,
            "raw_artifact_read_required": False,
        }
        assert contract["raw_artifact_access_boundary"]["normal_deliberation"] == "skip raw `.agentera/decisions.yaml` reads when complete_for_normal_deliberation_context=true"
        assert "outcome" in contract["included_fields"]
        assert "downstream_consequence_references" in contract["included_fields"]
        assert contract["completeness"]["entries_with_missing_fields"] == 0
        assert contract["completeness"]["normal_deliberation_context"] is True

    def test_filtered_json_decisions_keep_source_contract_and_guarantees(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": 1,
                    "date": "2026-05-14",
                    "question": "Runtime source contract?",
                    "context": "Runtime agents need filtered decisions.",
                    "alternatives": [{"name": "JSON", "status": "chosen"}],
                    "choice": "Use JSON source contract.",
                    "reasoning": "Filtered results need the same guarantees.",
                    "confidence": "firm",
                    "feeds_into": ["scripts/agentera"],
                    "satisfaction": {
                        "state": "user_confirmed_satisfied",
                        "user_confirmation": {"confirmed_by": "Jonathan", "confirmed_at": "2026-05-15"},
                    },
                },
                {
                    "number": 2,
                    "date": "2026-05-14",
                    "question": "Unrelated color?",
                    "context": "Design only.",
                    "alternatives": [{"name": "Blue", "status": "chosen"}],
                    "choice": "Blue",
                    "reasoning": "Readable.",
                    "confidence": "firm",
                    "feeds_into": ["DESIGN.md"],
                    "satisfaction": {
                        "state": "user_confirmed_satisfied",
                        "user_confirmation": {"confirmed_by": "Jonathan", "confirmed_at": "2026-05-15"},
                    },
                },
            ],
        })

        r = _run("decisions", "--topic", "runtime", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["filters"] == {"topic": "runtime"}
        assert [entry["number"] for entry in data["entries"]] == [1]
        assert data["entries"][0]["context_complete"] is True
        assert data["source_contract"]["filters"] == {"topic": "runtime"}
        assert data["source_contract"]["complete_for_returned_decisions"] is True
        assert data["source_contract"]["complete_for_normal_deliberation_context"] is True
        assert data["source_contract"]["filtered_result_boundary"]["raw_artifact_read_required"] is False

    def test_filtered_json_decisions_no_match_is_not_missing_artifact(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": 1,
                    "date": "2026-05-14",
                    "question": "Runtime source contract?",
                    "context": "Runtime agents need filtered decisions.",
                    "alternatives": [{"name": "JSON", "status": "chosen"}],
                    "choice": "Use JSON source contract.",
                    "reasoning": "Filtered results need the same guarantees.",
                    "confidence": "firm",
                    "feeds_into": ["scripts/agentera"],
                    "satisfaction": {
                        "state": "user_confirmed_satisfied",
                        "user_confirmation": {"confirmed_by": "Jonathan", "confirmed_at": "2026-05-15"},
                    },
                },
            ],
        })

        r = _run("decisions", "--topic", "nonexistent", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        contract = data["source_contract"]
        assert data["status"] == "ok"
        assert data["entries"] == []
        assert data["source"]["exists"] is True
        assert contract["complete_for_returned_full_detail"] is True
        assert contract["complete_for_normal_deliberation_context"] is True
        assert contract["completeness"]["filtered_no_match"] is True
        assert contract["filtered_result_boundary"]["normal_behavior"] == "Treat the result as no matching returned decisions, not as missing decision state."
        assert contract["decision_context_truth_table"]["filtered_no_match"]["meaning"] == "The artifact exists, but no returned decisions matched the filter."

    def test_json_decisions_surface_legacy_missing_satisfaction_as_review_needed(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": 1,
                    "date": "2026-05-14",
                    "question": "Legacy decision?",
                    "context": "Old entries predate satisfaction state.",
                    "alternatives": [{"name": "Keep valid", "status": "chosen"}],
                    "choice": "Keep valid.",
                    "reasoning": "Legacy history must not be reconstructed.",
                    "confidence": "firm",
                    "feeds_into": "PLAN.md",
                },
            ],
        })

        r = _run("decisions", "--format", "json", cwd=project)

        assert r.returncode == 0
        entry = json.loads(r.stdout)["entries"][0]
        assert entry["satisfaction"] == {
            "state": None,
            "evidence": None,
            "user_confirmation": None,
            "review_needed": True,
            "source": "missing_legacy_state",
            "caveats": ["Missing legacy satisfaction state is not treated as satisfied."],
        }
        assert entry["context_complete"] is False
        assert any("missing legacy state" in caveat for caveat in entry["caveats"])

    def test_json_decisions_expose_satisfaction_state_metadata_and_caveats(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": 1,
                    "date": "2026-05-14",
                    "question": "Open satisfaction?",
                    "context": "Open decisions require review.",
                    "alternatives": [{"name": "Track", "status": "chosen"}],
                    "choice": "Track satisfaction on the entry.",
                    "reasoning": "The entry owns satisfaction.",
                    "confidence": "firm",
                    "feeds_into": "PLAN.md",
                    "satisfaction": {"state": "open"},
                },
                {
                    "number": 2,
                    "date": "2026-05-14",
                    "question": "Provisional satisfaction?",
                    "context": "Agents may attach provisional evidence.",
                    "alternatives": [{"name": "Evidence", "status": "chosen"}],
                    "choice": "Expose evidence without user confirmation.",
                    "reasoning": "Evidence is not user confirmation.",
                    "confidence": "firm",
                    "feeds_into": "tests",
                    "satisfaction": {
                        "state": "provisionally_satisfied",
                        "evidence": "Focused CLI tests pass.",
                    },
                },
                {
                    "number": 3,
                    "date": "2026-05-14",
                    "question": "Confirmed satisfaction?",
                    "context": "Only the user may confirm satisfaction.",
                    "alternatives": [{"name": "Confirm", "status": "chosen"}],
                    "choice": "Expose user confirmation metadata.",
                    "reasoning": "Downstream artifacts do not prove acceptance.",
                    "confidence": "firm",
                    "feeds_into": "CHANGELOG.md",
                    "satisfaction": {
                        "state": "user_confirmed_satisfied",
                        "user_confirmation": {"confirmed_by": "Jonathan", "confirmed_at": "2026-05-15"},
                    },
                },
            ],
        })

        r = _run("decisions", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        entries = {entry["number"]: entry for entry in data["entries"]}
        assert entries[1]["satisfaction"] == {
            "state": "open",
            "evidence": None,
            "user_confirmation": None,
            "review_needed": True,
            "source": "decision.satisfaction",
            "caveats": ["Satisfaction state is open and requires review."],
        }
        assert entries[2]["satisfaction"]["evidence"] == "Focused CLI tests pass."
        assert entries[2]["satisfaction"]["user_confirmation"] is None
        assert entries[2]["satisfaction"]["review_needed"] is True
        assert "requires user confirmation" in " ".join(entries[2]["satisfaction"]["caveats"])
        assert entries[3]["satisfaction"]["user_confirmation"] == {
            "confirmed_by": "Jonathan",
            "confirmed_at": "2026-05-15",
        }
        assert entries[3]["satisfaction"]["review_needed"] is False
        assert entries[3]["satisfaction"]["caveats"] == []
        assert data["source_contract"]["satisfaction_context"]["owner"] == "decision entry"
        assert "Do not infer satisfaction" in data["source_contract"]["satisfaction_context"]["non_inference_policy"]
        assert data["source_contract"]["completeness"]["entries_requiring_satisfaction_review"] == 2
        assert data["source_contract"]["completeness"]["user_confirmed_satisfied_entries"] == 1
        assert data["source_contract"]["complete_for_normal_deliberation_context"] is True
        assert data["source_contract"]["satisfaction_review_boundary"]["raw_artifact_read_required"] is False
        assert data["source_contract"]["decision_context_truth_table"]["satisfaction_review_needed"]["carry_forward"] == ["satisfaction.review_needed", "caveats"]

    def test_json_decisions_do_not_confirm_satisfaction_from_downstream_reference(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": 1,
                    "date": "2026-05-14",
                    "question": "Downstream reference without satisfaction?",
                    "context": "A generated file exists downstream.",
                    "alternatives": [{"name": "No inference", "status": "chosen"}],
                    "choice": "Do not infer user confirmation.",
                    "reasoning": "Only user confirmation can satisfy the decision.",
                    "confidence": "firm",
                    "feeds_into": "scripts/agentera",
                },
            ],
        })

        r = _run("decisions", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        entry = data["entries"][0]
        assert entry["downstream_consequence_references"] == [
            {"source_field": "feeds_into", "reference": "scripts/agentera"},
        ]
        assert entry["satisfaction"]["state"] is None
        assert entry["satisfaction"]["review_needed"] is True
        assert entry["satisfaction"].get("user_confirmation") is None
        assert data["source_contract"]["completeness"]["user_confirmed_satisfied_entries"] == 0
        assert "Missing, open, provisional, or unconfirmed satisfaction requires review" in data["source_contract"]["fallback_behavior"]["satisfaction"]

    def test_json_decisions_do_not_fabricate_downstream_references(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": 1,
                    "date": "2026-05-14",
                    "question": "Missing downstream?",
                    "context": "No explicit structured references.",
                    "alternatives": [{"name": "None", "status": "chosen"}],
                    "choice": "Do not infer.",
                    "reasoning": "Fabricated references are worse than null.",
                    "confidence": "firm",
                },
            ],
        })

        r = _run("decisions", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        entry = data["entries"][0]
        assert entry["downstream_consequence_references"] is None
        assert entry["context_complete"] is False
        assert "feeds_into" in entry["missing_fields"]
        assert any("No explicit downstream consequence references were present" in caveat for caveat in entry["caveats"])
        assert data["source_contract"]["completeness"]["entries_without_downstream_references"] == 1
        assert data["source_contract"]["complete_for_normal_deliberation_context"] is True
        assert data["source_contract"]["missing_full_detail_boundary"]["raw_artifact_read_required"] is False
        assert "missing_fields/caveats" in data["source_contract"]["missing_full_detail_boundary"]["normal_behavior"]

    def test_json_compacted_decision_is_marked_incomplete(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [],
            "archive": [
                {"summary": "Decision 1 (2026-05-14): summary-only compacted decision"},
            ],
        })

        r = _run("decisions", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        entry = data["entries"][0]
        assert entry["number"] == 1
        assert entry["date"] == "2026-05-14"
        assert entry["compacted"] is True
        assert entry["context_complete"] is False
        assert "question" in entry["missing_fields"]
        assert "reasoning" in entry["missing_fields"]
        assert "outcome" in entry["missing_fields"]
        assert entry["downstream_consequence_references"] is None
        assert data["source_contract"]["complete_for_returned_decisions"] is False
        assert data["source_contract"]["complete_for_decision_context"] is False
        assert data["source_contract"]["complete_for_returned_full_detail"] is False
        assert data["source_contract"]["complete_for_normal_deliberation_context"] is True
        assert data["source_contract"]["completeness"]["compacted_entries"] == 1
        assert "missing_fields" in data["source_contract"]["raw_artifact_read_policy"]
        assert "unavailable" in data["source_contract"]["fallback_behavior"]["compacted_history"]
        assert "git history" not in data["source_contract"]["fallback_behavior"]["compacted_history"]
        assert data["source_contract"]["compacted_history_boundary"]["raw_artifact_read_required"] is False
        assert data["source_contract"]["decision_context_truth_table"]["compacted_archive_entries"]["carry_forward"] == ["missing_fields", "compacted", "caveats"]

    def test_json_compacted_decision_keeps_retained_outcome_fields(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [],
            "archive": [
                {
                    "summary": "Decision 2 (2026-05-14): Keep structured compact outcome",
                    "number": 2,
                    "date": "2026-05-14",
                    "choice": "Keep structured compact outcome",
                    "outcome": "Keep structured compact outcome",
                    "feeds_into": "scripts/agentera",
                    "satisfaction": {
                        "state": "user_confirmed_satisfied",
                        "user_confirmation": {"confirmed_by": "Jonathan", "confirmed_at": "2026-05-15"},
                    },
                },
            ],
        })

        r = _run("decisions", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        entry = data["entries"][0]
        assert entry["compacted"] is True
        assert entry["outcome"] == "Keep structured compact outcome"
        assert "outcome" not in entry["missing_fields"]
        assert entry["downstream_consequence_references"] == [
            {"source_field": "feeds_into", "reference": "scripts/agentera"},
        ]
        assert entry["satisfaction"]["state"] == "user_confirmed_satisfied"
        assert entry["satisfaction"]["review_needed"] is False
        assert entry["context_complete"] is False
        assert "reasoning" in entry["missing_fields"]

    def test_compaction_check_and_gate_report_protected_overflow_pressure(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": number,
                    "date": "2026-05-15",
                    "question": f"Decision {number}?",
                    "choice": "Keep under review.",
                    "satisfaction": {"state": "open"},
                }
                for number in range(1, 12)
            ],
            "archive": [],
        })

        compact = _run("compact", "--mode", "check", "--format", "json", cwd=project)
        gate = _run("gate", "--format", "json", cwd=project)

        assert compact.returncode == 1, compact.stdout
        assert gate.returncode == 1, gate.stdout
        for result in (compact, gate):
            payload = json.loads(result.stdout)
            decision_op = next(op for op in payload["operations"] if op["artifact"] == "DECISIONS.md")
            assert payload["status"] == "fail"
            assert payload["summary"]["protected_overflow_count"] == 1
            assert decision_op["action"] == "protected_overflow"
            assert decision_op["protected_overflow_count"] == 1
            assert "protected-overflow review pressure" in decision_op["message"]

    def test_filtered_json_decisions_can_match_compacted_summary(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [],
            "archive": [
                {"summary": "Decision 3 (2026-05-14): Historical routing contract"},
            ],
        })

        r = _run("decisions", "--topic", "routing", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert [entry["number"] for entry in data["entries"]] == [3]
        assert data["entries"][0]["compacted"] is True
        assert data["source_contract"]["filters"] == {"topic": "routing"}

    def test_decision_compact_fields_agree_with_schema_and_cli_contract(self):
        schema = yaml.safe_load((SCHEMAS_SRC / "decisions.yaml").read_text(encoding="utf-8"))
        archive_fields = {
            entry["field"]
            for entry in schema["ARCHIVE"].values()
            if isinstance(entry, dict) and "field" in entry
        }

        assert {"summary", "number", "date", "choice", "outcome", "feeds_into"}.issubset(archive_fields)
        assert "outcome" in archive_fields
        assert "feeds_into" in archive_fields


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------


class TestHealth:
    def test_pass_returns_health(self, project):
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [
                {
                    "number": 1,
                    "date": "2026-05-01",
                    "trajectory": "stable",
                    "grades": {
                        "architecture_alignment": "B",
                        "coupling_health": "C",
                    },
                    "dimensions": ["architecture_alignment", "coupling_health"],
                },
            ],
        })
        r = _run("health", cwd=project)
        assert r.returncode == 0
        assert "stable" in r.stdout
        assert "coupling" in r.stdout

    def test_health_summary_uses_newest_audit_first(self, project):
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [
                {
                    "number": 20,
                    "date": "2026-05-05",
                    "trajectory": "current",
                    "grades": {"Freshness": "B"},
                },
                {
                    "number": 10,
                    "date": "2026-04-20",
                    "trajectory": "stale",
                    "grades": {"Freshness": "D"},
                },
            ],
        })

        r = _run("health", cwd=project)

        assert r.returncode == 0
        assert "Audit 20: current" in r.stdout
        assert "Audit 10" not in r.stdout
        assert "Freshness: B" in r.stdout
        assert "Freshness: D" not in r.stdout

    def test_health_json_uses_highest_audit_number_when_list_ascending(self, project):
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [
                {
                    "number": 11,
                    "date": "2026-04-24",
                    "trajectory": "old",
                    "grades": {"Freshness": "D"},
                },
                {
                    "number": 20,
                    "date": "2026-05-05",
                    "trajectory": "current",
                    "grades": {"Freshness": "B"},
                },
            ],
        })

        r = _run("health", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["entries"][0]["number"] == 20
        assert data["entries"][0]["date"] == "2026-05-05"
        assert data["entries"][0]["trajectory"] == "current"

    def test_fail_missing_artifact(self, project):
        r = _run("health", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""

    def test_filter_dimension_match(self, project):
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [
                {
                    "number": 1,
                    "date": "2026-05-01",
                    "trajectory": "stable",
                    "grades": {
                        "architecture_alignment": "B",
                        "coupling_health": "C",
                    },
                    "dimensions": ["architecture_alignment", "coupling_health"],
                    "dimensions_detail": [
                        {
                            "name": "coupling_health",
                            "grade": "C",
                            "summary": "Tight coupling in hooks",
                            "findings": [
                                {
                                    "heading": "Hooks import common",
                                    "severity": "warning",
                                },
                            ],
                        },
                    ],
                },
            ],
        })
        r = _run("health", "--dimension", "coupling", cwd=project)
        assert r.returncode == 0
        assert "coupling" in r.stdout

    def test_filter_dimension_no_match(self, project):
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [
                {
                    "number": 1,
                    "grades": {"architecture_alignment": "B"},
                },
            ],
        })
        r = _run("health", "--dimension", "nonexistent", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""


# ---------------------------------------------------------------------------
# todo
# ---------------------------------------------------------------------------


class TestTodo:
    def test_pass_returns_todos(self, project):
        (project / "TODO.md").write_text(
            "# TODO\n\n"
            "## \u21f6 Critical\n\n"
            "- [ ] Fix the broken build\n\n"
            "## \u2192 Normal\n\n"
            "- [ ] Add more tests\n\n"
            "## Resolved\n\n"
            "- [x] Done\n"
        )
        r = _run("todo", cwd=project)
        assert r.returncode == 0
        assert "broken build" in r.stdout
        assert "more tests" in r.stdout

    def test_fail_missing_todo(self, project):
        r = _run("todo", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""

    def test_filter_severity_critical(self, project):
        (project / "TODO.md").write_text(
            "# TODO\n\n"
            "## \u21f6 Critical\n\n"
            "- [ ] Fix the broken build\n\n"
            "## \u2192 Normal\n\n"
            "- [ ] Add more tests\n\n"
            "## Resolved\n\n"
            "- [x] Done\n"
        )
        r = _run("todo", "--severity", "critical", cwd=project)
        assert r.returncode == 0
        assert "broken build" in r.stdout
        assert "more tests" not in r.stdout

    def test_filter_severity_no_match(self, project):
        (project / "TODO.md").write_text(
            "# TODO\n\n"
            "## \u2192 Normal\n\n"
            "- [ ] Add more tests\n\n"
            "## Resolved\n\n"
            "- [x] Done\n"
        )
        r = _run("todo", "--severity", "critical", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""


# ---------------------------------------------------------------------------
# generic query (schema auto-discovery)
# ---------------------------------------------------------------------------


class TestGenericQuery:
    def _write_custom_schema_and_artifact(self, project):
        schemas_dir = project / "skills" / "agentera" / "schemas" / "artifacts"
        (schemas_dir / "custom_thing.yaml").write_text(yaml.dump({
            "meta": {
                "name": "custom_thing",
                "version": "1.0.0",
                "description": "A custom artifact",
                "path": ".agentera/custom_thing.yaml",
            },
            "ENTRY": {
                "1": {
                    "id": "CT1",
                    "field": "title",
                    "type": "string",
                    "required": True,
                },
                "2": {
                    "id": "CT2",
                    "field": "status",
                    "type": "string",
                    "required": True,
                },
            },
        }))
        _write_artifact(project, ".agentera/custom_thing.yaml", {
            "entries": [
                {"title": "My thing", "status": "active"},
            ],
        })

    def test_auto_discovered_artifact(self, project):
        self._write_custom_schema_and_artifact(project)
        r = _run("query", "custom_thing", cwd=project)
        assert r.returncode == 0
        assert "title=My thing" in r.stdout

    def test_installed_app_model_resolves_schemas_without_project_copy(self, tmp_path):
        app_home = tmp_path / "agentera-home"
        project = tmp_path / "project"
        project.mkdir()
        _install_schema_surface(app_home)
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 1, "phase": "build", "what": "Installed schema discovery works"}],
        })

        r = _run_installed(app_home, "progress", cwd=project)

        assert r.returncode == 0
        assert "Installed schema discovery works" in r.stdout
        assert not (project / "skills" / "agentera" / "schemas" / "artifacts").exists()

    def test_installed_describe_reports_platform_home_despite_legacy_env(self, tmp_path):
        home = tmp_path / "home"
        app_home = home / ".local" / "share" / "agentera"
        cli = _install_runtime_surface(app_home)
        project = tmp_path / "project"
        project.mkdir()
        legacy_default = home / ".agents" / "agentera"

        r = subprocess.run(
            [sys.executable, str(cli), "describe", "--format", "json"],
            capture_output=True,
            text=True,
            cwd=project,
            env={
                **os.environ,
                "HOME": str(home),
                "AGENTERA_HOME": str(legacy_default),
                "XDG_DATA_HOME": str(home / ".local" / "share"),
                "PROFILERA_PROFILE_DIR": str(project / ".xdg" / "agentera"),
            },
        )

        assert r.returncode == 0, r.stderr
        app_model = json.loads(r.stdout)["source"]["app_model"]
        assert app_model["appHome"] == str(app_home)
        assert app_model["appHomeSource"] == "default app home"
        assert app_model["managedAppRoot"] == str(app_home / "app")
        assert app_model["skillRoot"] == str(app_home / "app" / "skills" / "agentera")

    def test_installed_describe_without_env_uses_custom_app_home(self, tmp_path):
        app_home = tmp_path / "custom-agentera"
        cli = _install_runtime_surface(app_home)
        project = tmp_path / "project"
        project.mkdir()
        home = tmp_path / "home"

        r = subprocess.run(
            [sys.executable, str(cli), "describe", "--format", "json"],
            capture_output=True,
            text=True,
            cwd=project,
            env={
                **os.environ,
                "HOME": str(home),
                "AGENTERA_HOME": "",
                "AGENTERA_DEFAULT_INSTALL_ROOT": "",
                "XDG_DATA_HOME": str(home / ".local" / "share"),
                "PROFILERA_PROFILE_DIR": str(project / ".xdg" / "agentera"),
            },
        )

        assert r.returncode == 0, r.stderr
        app_model = json.loads(r.stdout)["source"]["app_model"]
        assert app_model["appHome"] == str(app_home)
        assert app_model["appHomeSource"] == "installed app"
        assert app_model["managedAppRoot"] == str(app_home / "app")

    def test_new_schema_auto_supported(self, project):
        self._write_custom_schema_and_artifact(project)
        r = _run("query", "custom_thing", cwd=project)
        assert r.returncode == 0
        assert "active" in r.stdout

    def test_new_schema_json_format_is_pipeable(self, project):
        self._write_custom_schema_and_artifact(project)
        r = _run("query", "custom_thing", "--format", "json", cwd=project)
        assert r.returncode == 0
        assert json.loads(r.stdout) == [{"title": "My thing", "status": "active"}]

    def test_new_schema_yaml_format_is_pipeable(self, project):
        self._write_custom_schema_and_artifact(project)
        r = _run("query", "custom_thing", "--format", "yaml", cwd=project)
        assert r.returncode == 0
        assert yaml.safe_load(r.stdout) == [{"title": "My thing", "status": "active"}]


# ---------------------------------------------------------------------------
# artifact-specific summaries
# ---------------------------------------------------------------------------


class TestArtifactSpecificSummaries:
    def test_plan_summary_uses_docs_mapping_override(self, project):
        _write_artifact(project, ".agentera/docs.yaml", {
            "mapping": [
                {
                    "artifact": "PLAN.md",
                    "path": "custom/state/plan.yaml",
                },
            ],
        })
        _write_artifact(project, "custom/state/plan.yaml", {
            "header": {
                "title": "Mapped plan",
                "status": "active",
                "created": "2026-05-05",
            },
            "what": "Use the mapped path.",
            "tasks": [
                {"number": 1, "name": "Done", "status": "complete"},
                {"number": 2, "name": "Next", "status": "pending"},
            ],
        })
        r = _run("plan", cwd=project)
        assert r.returncode == 0
        assert "title=Mapped plan" in r.stdout
        assert "complete=1" in r.stdout
        assert "pending=1" in r.stdout

    def test_plan_json_declares_complete_plan_artifact_contract(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {
                "title": "No raw plan read",
                "status": "active",
                "created": "2026-05-14",
                "critic_issues": "1 found, 1 addressed, 0 dismissed",
            },
            "what": "Expose enough plan state through the CLI.",
            "why": "Avoid redundant PLAN.md reads after agentera plan.",
            "constraints": "No raw artifact fallback for normal startup.",
            "scope": {"included": ["plan summary"], "excluded": ["new CLI commands"]},
            "design": "Use source_contract metadata on the existing plan command.",
            "previous_plan_archived": ".agentera/archive/PLAN-old.yaml",
            "tasks": [
                {
                    "number": 1,
                    "name": "Contract",
                    "depends_on": [],
                    "status": "pending",
                    "acceptance": ["GIVEN plan output WHEN read THEN raw plan is unnecessary"],
                    "evidence": {"artifact": "PLAN.md"},
                },
            ],
            "overall_acceptance": ["No redundant plan artifact read is needed."],
            "surprises": [],
        })

        r = _run("plan", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["summary"]["constraints"] == "No raw artifact fallback for normal startup."
        assert data["summary"]["scope"]["included"] == ["plan summary"]
        assert data["summary"]["design"] == "Use source_contract metadata on the existing plan command."
        assert data["summary"]["overall_acceptance"] == ["No redundant plan artifact read is needed."]
        assert data["entries"][0]["acceptance"] == ["GIVEN plan output WHEN read THEN raw plan is unnecessary"]
        assert data["entries"][0]["evidence"] == {"artifact": "PLAN.md"}
        contract = data["source_contract"]
        assert contract["artifact"] == "PLAN.md"
        assert contract["canonical_artifact_label"] == "PLAN.md"
        assert contract["persisted_artifact_path"].endswith(".agentera/plan.yaml")
        assert contract["complete_for_plan_artifact"] is True
        assert contract["complete_for_normal_startup_evaluation"] is True
        assert contract["raw_artifact_reads_required"] is False
        assert contract["missing_state"] == []
        assert "task evidence" in contract["included_state"]
        assert "constraints" in contract["summary_fields"]
        assert "previous_plan_archived" in contract["summary_fields"]
        assert contract["complete_state"]["normal_startup_evaluation"] is True
        assert "overall_acceptance" in contract["complete_state"]["summary"]
        assert "acceptance" in contract["complete_state"]["entries"]
        assert "evidence" in contract["complete_state"]["entries"]
        assert (
            contract["raw_artifact_access_boundary"]["normal_read_only_startup_evaluation"]
            == "skip raw plan artifact reads when complete_for_plan_artifact is true"
        )
        assert "artifact writes" in contract["raw_artifact_access_boundary"]["allowed_raw_artifact_uses"]
        assert "archival" in contract["raw_artifact_read_policy"]
        assert "defensive" in contract["raw_artifact_read_policy"]

        sparse = _run("plan", "--format", "json", "--fields", "source_contract", cwd=project)
        assert sparse.returncode == 0
        sparse_data = json.loads(sparse.stdout)
        assert sparse_data["command"] == "plan"
        assert sparse_data["status"] == "ok"
        assert sparse_data["source_contract"]["complete_for_plan_artifact"] is True
        assert sparse_data["source_contract"]["complete_for_normal_startup_evaluation"] is True
        assert "entries" not in sparse_data

    def test_legacy_plan_entries_do_not_claim_complete_plan_artifact_contract(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "entries": [
                {
                    "title": "Legacy task",
                    "status": "pending",
                },
            ],
        })

        r = _run("plan", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["summary"] == {"legacy_entries": True}
        contract = data["source_contract"]
        assert contract["complete_for_plan_artifact"] is False
        assert contract["complete_for_normal_startup_evaluation"] is False
        assert contract["complete_state"]["normal_startup_evaluation"] is False
        assert contract["missing_state"] == ["current PLAN.md task artifact shape"]
        assert contract["fallback"] == ["agentera docs --format json"]

    def test_progress_summary_surfaces_verification_and_next(self, project):
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [
                {
                    "number": 7,
                    "timestamp": "2026-05-05 12:00",
                    "type": "fix",
                    "phase": "build",
                    "what": "Closed the query gap.",
                    "verified": "pytest query passed",
                    "next": "Remeasure tokens",
                },
            ],
        })
        r = _run("progress", cwd=project)
        assert r.returncode == 0
        assert "phase=build" in r.stdout
        assert "verified: pytest query passed" in r.stdout
        assert "next: Remeasure tokens" in r.stdout

    def test_progress_summary_uses_newest_cycle_first(self, project):
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [
                {
                    "number": 9,
                    "timestamp": "2026-05-05 12:00",
                    "type": "feat",
                    "phase": "build",
                    "what": "Newest work",
                },
                {
                    "number": 8,
                    "timestamp": "2026-05-05 11:00",
                    "type": "fix",
                    "phase": "build",
                    "what": "Older work",
                },
            ],
        })
        r = _run("progress", "--limit", "1", cwd=project)
        assert r.returncode == 0
        assert "number=9" in r.stdout
        assert "Newest work" in r.stdout
        assert "number=8" not in r.stdout

    def test_docs_summary_filters_status(self, project):
        _write_artifact(project, ".agentera/docs.yaml", {
            "last_audit": "2026-05-05 (test)",
            "mapping": [
                {"artifact": "PLAN.md", "path": ".agentera/plan.yaml", "producers": ["planera"]},
            ],
            "index": [
                {
                    "document": "README",
                    "path": "README.md",
                    "last_updated": "2026-05-05",
                    "status": "current",
                },
                {
                    "document": "Old notes",
                    "path": "docs/old.md",
                    "last_updated": "2026-01-01",
                    "status": "stale",
                },
            ],
        })
        r = _run("docs", "--status", "stale", cwd=project)
        assert r.returncode == 0
        assert "Docs: last_audit=2026-05-05 (test)" in r.stdout
        assert "document=Old notes" in r.stdout
        assert "README" not in r.stdout

        structured = _run("docs", "--format", "json", cwd=project)
        assert structured.returncode == 0
        data = json.loads(structured.stdout)
        assert data["summary"]["mapping"] == [
            {"artifact": "PLAN.md", "path": ".agentera/plan.yaml", "producers": ["planera"]},
        ]
        assert data["summary"]["source_contract"]["capability_startup_complete"] is True
        assert data["summary"]["source_contract"]["raw_artifact_reads_required"] is False

    def test_objective_and_experiments_use_active_objective(self, project):
        objective_dir = project / ".agentera" / "optimera" / "token-budget"
        objective_dir.mkdir(parents=True)
        (objective_dir / "objective.yaml").write_text(yaml.dump({
            "header": {
                "title": "Token budget",
                "status": "active",
            },
            "objective": {
                "description": "Reduce fixed prompt tokens.",
                "target": "20% reduction",
                "measurement": "count_tokens",
            },
        }))
        (objective_dir / "experiments.yaml").write_text(yaml.dump({
            "experiments": [
                {
                    "number": 1,
                    "date": "2026-05-05",
                    "label": "query seam",
                    "status": "kept",
                    "metric": {
                        "primary_value": "12000",
                        "delta_vs_baseline": "-11%",
                    },
                },
            ],
        }))

        objective = _run("objective", cwd=project)
        experiments = _run("experiments", cwd=project)

        assert objective.returncode == 0
        assert "title=Token budget" in objective.stdout
        assert "target: 20% reduction" in objective.stdout
        assert experiments.returncode == 0
        assert "number=1" in experiments.stdout
        assert "metric: primary_value=12000" in experiments.stdout


# ---------------------------------------------------------------------------
# hej
# ---------------------------------------------------------------------------


class TestHej:
    def _write_bundle_root(self, root: Path, marker_version: str = "1.0.0") -> Path:
        (root / "scripts").mkdir(parents=True)
        (root / "scripts" / "agentera").write_text("subcommand: hej\n", encoding="utf-8")
        (root / "skills" / "agentera").mkdir(parents=True)
        (root / "skills" / "agentera" / "SKILL.md").write_text("# agentera\n", encoding="utf-8")
        (root / "registry.json").write_text('{"skills":[{"version":"1.0.0"}]}\n', encoding="utf-8")
        (root / ".agentera-bundle.json").write_text(
            json.dumps({"version": marker_version}),
            encoding="utf-8",
        )
        return root

    def test_first_run_empty_project_routes_to_visionera(self, project):
        r = _run("hej", cwd=project)

        assert r.returncode == 0
        assert "app_home: status=up_to_date" in r.stdout
        assert "mode: fresh" in r.stdout
        assert "capability=visionera" in r.stdout
        assert "reason=fresh project direction" in r.stdout

    def test_stale_bundle_is_reported_by_hej_without_preflight(self, project):
        install_root = self._write_bundle_root(project / "bundle", marker_version="1.0.0")

        r = _run("hej", "--install-root", str(install_root), "--expected-version", "2.0.0", cwd=project)

        assert r.returncode == 0
        assert "app_home: status=migration_needed" in r.stdout
        assert "app migration needed" in r.stdout
        assert "agentera upgrade --install-root" in r.stdout
        assert str(install_root) in r.stdout

    def test_stale_bundle_structured_output_has_repair_contract(self, project):
        install_root = self._write_bundle_root(project / "bundle", marker_version="1.0.0")

        r = _run("hej", "--install-root", str(install_root), "--expected-version", "2.0.0", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        bundle = data["bundle"]
        app_home = data["app_home"]
        assert bundle["status"] == "migration_needed"
        assert bundle["expectedVersion"] == "2.0.0"
        assert bundle["markerVersion"] == "1.0.0"
        assert bundle["dryRunCommand"].startswith("uvx --from git+https://github.com/jgabor/agentera")
        assert "--only bundle" not in bundle["dryRunCommand"]
        assert "agentera upgrade --install-root" in bundle["dryRunCommand"]
        assert bundle["applyCommand"].endswith("--yes")
        assert bundle["approval"] == f"approve app files repair for {install_root}"
        assert bundle["appHome"] == str(install_root)
        assert "installRoot" not in bundle
        assert "installRootSource" not in bundle
        assert bundle["managedAppRoot"] == str(install_root / "app")
        assert bundle["userDataRoot"] == str(install_root)
        assert app_home == {
            "status": "migration_needed",
            "home": str(install_root),
            "source": "explicit --install-root",
            "managed_app_root": str(install_root / "app"),
            "user_data_root": str(install_root),
        }

    def test_version_mismatch_reports_update_needed_not_repair(self, project):
        app_home = project / "app-home"
        self._write_bundle_root(app_home / "app", marker_version="1.0.0")

        r = _run("hej", "--install-root", str(app_home), "--expected-version", "2.0.0", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["bundle"]["status"] == "outdated"
        assert data["app_home"]["status"] == "outdated"
        assert data["bundle"]["signals"] == [{
            "status": "outdated",
            "kind": "version_mismatch",
            "expected": "2.0.0",
            "actual": "1.0.0",
            "message": "Agentera app files are valid but need an update to the expected version",
        }]
        assert any("app files outdated" in item for item in data["attention"])
        assert all("repair" not in item for item in data["attention"])

    def test_version_mismatch_text_guidance_uses_update_wording(self, project):
        app_home = project / "app-home"
        self._write_bundle_root(app_home / "app", marker_version="1.0.0")

        r = _run("hej", "--install-root", str(app_home), "--expected-version", "2.0.0", cwd=project)

        assert r.returncode == 0
        assert "app_home: status=outdated" in r.stdout
        assert "normal: app files outdated; run agentera upgrade" in r.stdout
        assert "repair" not in r.stdout

    def test_visible_skill_version_can_mark_bundle_stale_without_preflight(self, project):
        install_root = self._write_bundle_root(project / "bundle", marker_version="1.0.0")
        visible = project / "visible-skill"
        visible.mkdir()
        visible.joinpath("SKILL.md").write_text('---\nversion: "9.0.0"\n---\n# agentera\n', encoding="utf-8")
        env = {
            **os.environ,
            "AGENTERA_HOME": str(REPO_ROOT),
            "AGENTERA_VISIBLE_SKILL_ROOT": str(visible),
            "XDG_DATA_HOME": str(project / ".xdg"),
            "PROFILERA_PROFILE_DIR": str(project / ".xdg" / "agentera"),
        }

        r = subprocess.run(
            [sys.executable, CLI, "hej", "--install-root", str(install_root), "--format", "json"],
            capture_output=True,
            text=True,
            cwd=project,
            env=env,
        )

        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["bundle"]["status"] == "migration_needed"
        assert data["bundle"]["expectedVersion"] == "9.0.0"
        assert data["bundle"]["expectedVersionSource"] == str(visible)

    def test_runtime_injected_legacy_default_does_not_outrank_platform_home(self, project):
        home = project / "home"
        legacy_default = home / ".agents" / "agentera"
        platform_home = home / ".local" / "share" / "agentera"
        env = {
            **os.environ,
            "AGENTERA_HOME": str(legacy_default),
            "XDG_DATA_HOME": str(home / ".local" / "share"),
            "PROFILERA_PROFILE_DIR": str(project / ".xdg" / "agentera"),
        }

        r = subprocess.run(
            [sys.executable, CLI, "hej", "--home", str(home), "--format", "json"],
            capture_output=True,
            text=True,
            cwd=project,
            env=env,
        )

        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        assert data["app_home"]["home"] == str(platform_home)
        assert data["app_home"]["source"] == "default app home"
        assert data["bundle"]["status"] == "repair_needed"
        assert data["bundle"]["signals"][0]["kind"] == "missing_bundle"
        assert not legacy_default.exists()

    def test_valid_custom_environment_home_remains_authoritative(self, project):
        home = project / "home"
        custom = project / "custom-agentera"
        self._write_bundle_root(custom / "app", marker_version="2.0.0")
        env = {
            **os.environ,
            "AGENTERA_HOME": str(custom),
            "XDG_DATA_HOME": str(home / ".local" / "share"),
            "PROFILERA_PROFILE_DIR": str(project / ".xdg" / "agentera"),
        }

        r = subprocess.run(
            [sys.executable, CLI, "hej", "--home", str(home), "--expected-version", "2.0.0", "--format", "json"],
            capture_output=True,
            text=True,
            cwd=project,
            env=env,
        )

        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        assert data["app_home"] == {
            "status": "up_to_date",
            "home": str(custom),
            "source": "AGENTERA_HOME",
            "managed_app_root": str(custom / "app"),
            "user_data_root": str(custom),
        }

    def test_missing_custom_environment_home_blocks_without_fallback(self, project):
        home = project / "home"
        custom = project / "missing-custom-agentera"
        platform_home = home / ".local" / "share" / "agentera"
        env = {
            **os.environ,
            "AGENTERA_HOME": str(custom),
            "XDG_DATA_HOME": str(home / ".local" / "share"),
            "PROFILERA_PROFILE_DIR": str(project / ".xdg" / "agentera"),
        }

        r = subprocess.run(
            [sys.executable, CLI, "hej", "--home", str(home), "--format", "json"],
            capture_output=True,
            text=True,
            cwd=project,
            env=env,
        )

        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        assert data["app_home"]["status"] == "manual_review_needed"
        assert data["app_home"]["home"] == str(custom)
        assert data["app_home"]["source"] == "AGENTERA_HOME"
        assert data["bundle"]["dryRunCommand"] is None
        assert data["bundle"]["applyCommand"] is None
        assert not custom.exists()
        assert not platform_home.exists()

    def test_saved_context_without_vision_routes_to_resonera(self, project):
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 1, "what": "Direction prompt abandoned"}],
        })

        r = _run("hej", cwd=project)

        assert r.returncode == 0
        assert "mode: returning" in r.stdout
        assert "object=Direction clarification" in r.stdout
        assert "capability=resonera" in r.stdout
        assert "capability=visionera" not in r.stdout

    def test_vision_only_state_does_not_route_to_visionera(self, project):
        _write_artifact(project, ".agentera/vision.yaml", {
            "principles": [{"name": "Clear direction", "description": "Route from saved intent."}],
        })

        r = _run("hej", cwd=project)

        assert r.returncode == 0
        assert "mode: returning" in r.stdout
        assert "capability=planera" in r.stdout
        assert "capability=visionera" not in r.stdout

    def test_returning_v2_composite_briefing(self, project):
        profile = project / ".xdg" / "agentera" / "PROFILE.md"
        profile.parent.mkdir(parents=True)
        profile.write_text("# Profile\n")
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "CLI shape", "status": "active"},
            "tasks": [
                {"number": 1, "name": "Parser", "status": "complete", "acceptance": ["parsed"]},
                {"number": 2, "name": "Composite hej", "status": "pending", "depends_on": [1], "acceptance": ["briefed"], "evidence": {"gap": "startup"}},
            ],
        })
        _write_artifact(project, ".agentera/docs.yaml", {
            "last_audit": "2026-05-05 (test)",
            "mapping": [{"artifact": "PLAN.md", "path": ".agentera/plan.yaml"}],
            "coverage": {"stale": "none"},
            "index": [],
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [
                {"number": 3, "timestamp": "2026-05-05", "type": "test", "phase": "build", "verified": "pytest passed"},
            ],
        })
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [
                {
                    "number": 3,
                    "trajectory": "stable",
                    "grades": {"architecture_alignment": "B", "coupling_health": "C"},
                },
            ],
        })
        _write_artifact(project, ".agentera/optimera/tokens/objective.yaml", {
            "header": {"title": "Token budget", "status": "active"},
            "objective": {"measurement": "prompt_tokens", "target": "20% reduction"},
        })
        _write_artifact(project, "TODO.md", {
            "entries": [
                {"severity": "normal", "status": "open", "description": "Update docs"},
            ],
        })

        r = _run("hej", cwd=project)

        assert r.returncode == 0
        assert "mode: returning" in r.stdout
        assert "profile: loaded" in r.stdout
        assert "health: audit=3" in r.stdout
        assert "issues: critical=0 | degraded=0 | normal=1 | annoying=0" in r.stdout
        assert "plan: status=active | progress=1/2" in r.stdout
        assert "objective: active" in r.stdout
        assert "attention:" in r.stdout
        assert "object=PLAN Task 2: Composite hej" in r.stdout
        assert "capability=orkestrera" in r.stdout
        assert "app_home: status=up_to_date" in r.stdout
        assert "source_contract:" in r.stdout
        assert "fields=app_home,mode,profile,v1_migration,health,issues,plan,docs,progress,objective,state_presence,attention,decision_attention,next_action,orchestration_context,closeout_context,evidence_context" in r.stdout
        assert "render=caller-owned README-style prime orientation dashboard" in r.stdout
        assert "access=single installed CLI call; app/v1/profile safety included; no preflight glob/read/import/doctor calls" in r.stdout
        assert "capability_startup_complete=true" in r.stdout
        assert "raw_artifact_reads_required=false" in r.stdout
        assert "missing_state=none" in r.stdout
        assert "confidence_caveats=representative benchmark evidence exists" in r.stdout
        assert "cli_fallback=agentera plan --format json; agentera docs --format json; agentera progress --format json" in r.stdout
        assert "┌─┐┌─┐┌─┐" not in r.stdout
        assert "render=hej dashboard | status=complete" not in r.stdout

        structured = _run("hej", "--format", "json", cwd=project)
        assert structured.returncode == 0
        assert "Deprecation: agentera hej is deprecated; use agentera prime" in structured.stderr
        data = json.loads(structured.stdout)
        assert data["command"] == "prime"
        assert data["source_contract"]["capability_startup"]["complete_for_capability_startup"] is True
        assert data["source_contract"]["capability_startup"]["missing_state"] == []
        assert data["plan"]["tasks"][1]["depends_on"] == [1]
        assert data["plan"]["tasks"][1]["acceptance"] == ["briefed"]
        assert data["plan"]["tasks"][1]["evidence"] == {"gap": "startup"}
        assert data["docs"]["mapping"] == [{"artifact": "PLAN.md", "path": ".agentera/plan.yaml"}]
        assert data["docs"]["source_contract"]["capability_startup_complete"] is True
        assert data["progress"]["latest_verification"] == "pytest passed"

    def test_hej_surfaces_bounded_decision_satisfaction_attention_without_next_action_change(self, project):
        decisions_path = _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {"number": 1, "question": "Legacy missing satisfaction?", "choice": "Review legacy."},
                {"number": 2, "question": "Open satisfaction?", "choice": "Keep open.", "satisfaction": {"state": "open"}},
                {
                    "number": 3,
                    "question": "Provisional satisfaction?",
                    "choice": "Needs user confirmation.",
                    "satisfaction": {"state": "provisionally_satisfied", "evidence": "Tests passed."},
                },
                {
                    "number": 4,
                    "question": "Unconfirmed satisfied?",
                    "choice": "Missing confirmation metadata.",
                    "satisfaction": {"state": "user_confirmed_satisfied"},
                },
                {
                    "number": 5,
                    "question": "Confirmed satisfied?",
                    "choice": "Done.",
                    "satisfaction": {
                        "state": "user_confirmed_satisfied",
                        "user_confirmation": {"confirmed_by": "Jonathan", "confirmed_at": "2026-05-15"},
                    },
                },
                {
                    "number": 6,
                    "question": "Explicit review needed?",
                    "choice": "Still review.",
                    "satisfaction": {
                        "state": "user_confirmed_satisfied",
                        "user_confirmation": {"confirmed_by": "Jonathan", "confirmed_at": "2026-05-15"},
                        "review_needed": True,
                    },
                },
            ],
        })
        before = decisions_path.read_text(encoding="utf-8")
        _write_artifact(project, "TODO.md", {
            "entries": [{"severity": "normal", "status": "open", "description": "Implement next TODO"}],
        })

        r = _run("hej", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        assert decisions_path.read_text(encoding="utf-8") == before
        data = json.loads(r.stdout)
        decision_attention = data["decision_attention"]
        assert decision_attention["type"] == "decision_satisfaction_review"
        assert decision_attention["count"] == 5
        assert decision_attention["max_entries"] == 3
        assert decision_attention["bounded"] is True
        assert len(decision_attention["entries"]) == 3
        assert decision_attention["states"] == {
            "missing": 1,
            "open": 1,
            "provisionally_satisfied": 1,
            "unconfirmed_user_confirmed_satisfied": 2,
        }
        assert [entry["number"] for entry in decision_attention["entries"]] == [1, 2, 3]
        assert any("decisions need satisfaction review" in item for item in data["attention"])
        decision_index = next(i for i, item in enumerate(data["attention"]) if "decisions need satisfaction review" in item)
        todo_index = next(i for i, item in enumerate(data["attention"]) if "TODO:" in item)
        assert decision_index < todo_index
        assert len(data["attention"]) <= 6
        assert data["next_action"]["capability"] == "realisera"
        assert data["next_action"]["reason"] == "highest-priority open TODO"

    def test_hej_next_action_uses_satisfaction_review_not_follow_substring(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": 58,
                    "question": "Naming boundary?",
                    "choice": "Single-name protocol.",
                    "reasoning": "Agents are easier to follow when names are unique.",
                    "satisfaction": {
                        "state": "user_confirmed_satisfied",
                        "user_confirmation": {"confirmed_by": "user", "confirmed_at": "2026-05-23"},
                    },
                },
                {
                    "number": 56,
                    "question": "TypeScript CLI rewrite?",
                    "choice": "Defer.",
                    "satisfaction": {"state": "open"},
                },
            ],
        })

        r = _run("hej", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        assert data["next_action"]["capability"] == "resonera"
        assert data["next_action"]["object"] == "DECISION 56 follow-up"
        assert data["decision_attention"]["count"] == 1

    def test_hej_omits_decision_attention_when_all_decisions_are_confirmed(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": 1,
                    "question": "Confirmed?",
                    "choice": "Done.",
                    "satisfaction": {
                        "state": "user_confirmed_satisfied",
                        "user_confirmation": {"confirmed_by": "Jonathan", "confirmed_at": "2026-05-15"},
                    },
                },
            ],
        })

        r = _run("hej", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        assert data["decision_attention"] is None
        assert all("decisions need satisfaction review" not in item for item in data["attention"])

    def test_hej_text_renders_decision_attention(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {"number": 1, "question": "Needs review?", "choice": "Open.", "satisfaction": {"state": "open"}},
            ],
        })

        r = _run("hej", cwd=project)

        assert r.returncode == 0, r.stderr
        assert "attention:" in r.stdout
        assert "normal: decisions need satisfaction review (1; open=1); Decision 1: Needs review?" in r.stdout

    def test_hej_capability_context_names_included_and_missing_state_families(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Capability context", "status": "active"},
            "tasks": [{"number": 1, "name": "Build", "status": "pending"}],
        })
        _write_artifact(project, ".agentera/docs.yaml", {
            "mapping": [{"artifact": "PLAN.md", "path": ".agentera/plan.yaml"}],
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 1, "timestamp": "2026-05-14", "verified": "seeded"}],
        })

        r = _run("prime", "--context", "orkestrera", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        context = _flat_capability_context(data)
        first_read = context["first_invocation_read"]
        assert context["capability"] == "orkestrera"
        assert first_read["value"] == "full"
        assert first_read["instruction_target"]["path"] == "skills/agentera/capabilities/orkestrera/instructions.md"
        assert first_read["instruction_target"]["exists"] is True
        assert first_read["obligation_summary"] == "full_instruction_file_read_required"
        assert first_read["runtime_enforcement"] is False
        assert first_read["provenance"]["authority_path"] == "references/cli/capability-instruction-contract.yaml"
        assert first_read["provenance"]["decision"] == 57
        assert context["declared_state_needs"] == [
            "plan",
            "progress",
            "health",
            "decisions",
            "vision",
            "profile",
            "docs",
        ]
        assert context["declared_write_targets"] == ["plan", "todo"]
        assert context["artifact_inventory"] == {
            "read_needs": ["plan", "progress", "health", "decisions", "vision", "profile", "docs"],
            "write_targets": ["plan", "todo"],
        }
        assert {"plan", "progress", "health", "docs"}.issubset(context["included_state_families"])
        assert context["missing_state_families"] == ["decisions", "vision", "profile"]
        assert context["cli_fallback"] == ["agentera decisions --format json"]
        assert "before raw file access" in context["raw_artifact_read_policy"]
        assert "agentera planera" not in r.stdout
        assert "agentera realisera" not in r.stdout

    def test_hej_without_capability_context_keeps_full_dashboard_envelope(self, project):
        _write_artifact(project, ".agentera/docs.yaml", {
            "mapping": [{"artifact": "PLAN.md", "path": ".agentera/plan.yaml"}],
        })

        r = _run("hej", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        assert "Deprecation: agentera hej is deprecated; use agentera prime" in r.stderr
        data = json.loads(r.stdout)
        assert data["command"] == "prime"
        assert "plan" in data
        assert "docs" in data
        assert "source_contract" in data
        assert "capability_context" not in data

    def test_hej_capability_context_slim_profile_emits_startup_capsule(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Slim capability context", "status": "active"},
            "tasks": [{"number": 1, "name": "Build", "status": "pending"}],
        })
        _write_artifact(project, ".agentera/docs.yaml", {
            "mapping": [{"artifact": "PLAN.md", "path": ".agentera/plan.yaml"}],
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 1, "timestamp": "2026-05-14", "verified": "seeded"}],
        })

        r = _run("prime", "--context", "orkestrera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        assert list(data) == ["command", "status", "capability_context"]
        context = data["capability_context"]
        assert context["schemaVersion"] == "agentera.capabilityContext.v1"
        assert context["capability"] == "orkestrera"
        assert context["state"]["declared_write_targets"] == ["plan", "todo"]
        assert context["state"]["included"] == ["plan", "progress", "health", "docs"]
        assert context["state"]["missing"] == ["decisions", "vision", "profile"]
        assert context["state"]["fallback_commands"] == ["agentera decisions --format json"]
        assert context["state"]["artifact_inventory"]["write_targets"] == ["plan", "todo"]
        assert context["profile"]["status"] == "not found"
        assert "profile-derived state is unavailable" in context["profile"]["caveats"][0]
        assert "plan" not in data
        assert "source_contract" not in data

    def test_hej_capability_context_slim_profile_nests_existing_bespoke_contexts(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Slim bespoke contexts", "status": "active"},
            "tasks": [{"number": 1, "name": "Build", "status": "pending", "acceptance": ["works"]}],
        })
        _write_artifact(project, ".agentera/docs.yaml", {
            "mapping": [{"artifact": "PLAN.md", "path": ".agentera/plan.yaml"}],
            "conventions": {"semver_policy": {"fix": "patch"}, "version_files": ["pyproject.toml"]},
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 1, "timestamp": "2026-05-14", "verified": "seeded"}],
        })
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [{"number": 1, "trajectory": "stable", "grades": {"Architecture": "B"}}],
        })
        _write_artifact(project, "TODO.md", {"entries": []})

        expected = {
            "realisera": "execution_context",
            "optimera": "benchmark_context",
            "inspektera": "evidence_context",
            "dokumentera": "closeout_context",
            "orkestrera": "orchestration_context",
        }
        for capability, context_key in expected.items():
            r = _run("prime", "--context", capability, "--format", "json", cwd=project)

            assert r.returncode == 0, r.stderr
            data = json.loads(r.stdout)
            context = data["capability_context"]
            assert list(data) == ["command", "status", "capability_context"]
            assert context["capability"] == capability
            assert context_key in context["context"]
            assert context["context"][context_key]["capability"] == capability
            assert "source_contract" in context["context"][context_key]
            assert "profile-derived state is unavailable" in context["profile"]["caveats"][0]

    def test_hej_capability_context_slim_profile_adds_generic_capability_builders(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Slim generic contexts", "status": "active"},
            "tasks": [{"number": 1, "name": "Plan", "status": "pending", "acceptance": ["planned"]}],
        })
        _write_artifact(project, ".agentera/docs.yaml", {
            "mapping": [{"artifact": "PLAN.md", "path": ".agentera/plan.yaml"}],
            "conventions": {"semver_policy": {"fix": "patch"}, "version_files": ["pyproject.toml"]},
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 1, "timestamp": "2026-05-14", "verified": "seeded"}],
        })
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [{"number": 1, "trajectory": "stable", "grades": {"Architecture": "B"}}],
        })
        _write_artifact(project, "TODO.md", {"entries": [{"title": "Known issue", "severity": "normal"}]})

        expected = {
            "visionera": "vision_startup_context",
            "resonera": "deliberation_context",
            "inspirera": "research_context",
            "planera": "planning_context",
            "profilera": "profile_context",
            "visualisera": "design_context",
        }
        for capability, context_key in expected.items():
            r = _run("prime", "--context", capability, "--format", "json", cwd=project)

            assert r.returncode == 0, r.stderr
            context = json.loads(r.stdout)["capability_context"]["context"]
            assert context_key in context
            generic = context[context_key]
            assert "profile" in generic
            assert generic["profile"]["status"] == "not found"

        planera = json.loads(_run(
            "prime",
            "--context",
            "planera",
            "--format",
            "json",
            cwd=project,
        ).stdout)["capability_context"]["context"]["planning_context"]
        assert planera["startup_contract"]["schemaVersion"] == "agentera.planeraStartup.v1"
        assert planera["docs"]["version_policy"]["semver_policy"] == {"fix": "patch"}
        assert planera["todo"]["open_count"] == 1

    def test_hej_capability_context_rejected_in_3_0(self, project):
        r = _run("hej", "--format", "json", "--capability-context", "orkestrera", cwd=project)

        assert r.returncode == 2
        assert "unrecognized arguments: --capability-context" in r.stderr

    def test_prime_context_rejects_unsupported_sparse_field_without_partial_stdout(self, project):
        r = _run(
            "prime",
            "--context",
            "orkestrera",
            "--format",
            "json",
            "--fields",
            "raw_yaml",
            cwd=project,
        )

        assert r.returncode == 1
        assert r.stdout == ""
        assert "unsupported field 'raw_yaml' for prime" in r.stderr

    def test_hej_planera_context_exposes_compact_startup_contract(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Planera context", "status": "active"},
            "tasks": [{"number": 1, "name": "Plan", "status": "pending"}],
        })
        _write_artifact(project, ".agentera/docs.yaml", {
            "mapping": [{"artifact": "PLAN.md", "path": ".agentera/plan.yaml"}],
        })

        r = _run("prime", "--context", "planera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        context = _flat_capability_context(data)
        contract = context["startup_contract"]
        first_read = context["first_invocation_read"]
        assert context["capability"] == "planera"
        assert "plan_archive" not in context["declared_state_needs"]
        assert "plan_archive" not in context["missing_state_families"]
        assert context["declared_write_targets"] == ["plan", "plan_archive"]
        assert first_read["value"] == "compact_startup"
        assert first_read["instruction_target"]["path"] == "skills/agentera/capabilities/planera/instructions.md"
        assert first_read["obligation_summary"] == "compact_contract_must_name_covered_guidance_and_escalation_rules"
        assert first_read["provenance"]["authority_path"] == "references/cli/capability-instruction-contract.yaml"
        assert contract["schemaVersion"] == "agentera.planeraStartup.v1"
        assert contract["canonical_surface"] == "agentera prime --context planera --format json"
        assert contract["bounded"] is True
        assert contract["instructions_runtime_read_required"] is False
        assert contract["planning"]["levels"] == ["skip", "light", "full"]
        assert contract["planning"]["required_steps"] == ["orient", "specify", "review", "audit", "write", "handoff"]
        assert contract["planning"]["full_plan_review_required"] is True
        assert contract["planning"]["pre_write_self_audit_required"] is True
        assert contract["cli_first_orientation"]["current_plan_command"] == "agentera plan --format json"
        assert contract["cli_first_orientation"]["complete_plan_contract_key"] == "source_contract.complete_for_plan_artifact"
        assert "normal read-only startup" in contract["artifact_access_boundaries"]["skip_raw_plan_artifact_when"]
        assert "writing a new plan" in contract["artifact_access_boundaries"]["raw_plan_artifact_allowed_for"]
        archive_confirmation = contract["artifact_access_boundaries"]["completed_plan_archive_confirmation"]
        assert "implicit" in archive_confirmation["direct_planera_invocation"]
        assert "does not require a separate pre-write confirmation" in archive_confirmation["direct_planera_invocation"]
        assert "Plan approval is still required" in archive_confirmation["human_initiated_plan_write"]
        assert "active or incomplete plan is not implicit" in archive_confirmation["active_or_incomplete_plan"]
        assert "editing Planera behavior or instructions" in contract["instructions_authority"]["read_planera_instructions_when"]
        assert contract["unsupported_command_boundary"]["forbidden_examples"] == []
        assert contract["unsupported_command_boundary"]["capability_cli_commands_added"] is True
        assert contract["seam_decision"]["selected"] == "prime --context"
        assert {entry["surface"] for entry in contract["seam_decision"]["not_changed"]} == {
            "agentera schema --format json",
            "dispatcher guidance",
        }

    def test_planera_compact_startup_context_does_not_require_instruction_file(self, tmp_path):
        app_home = tmp_path / "app-home"
        _install_runtime_surface(app_home)
        planera_instructions = app_home / "app" / "skills" / "agentera" / "capabilities" / "planera" / "instructions.md"
        planera_instructions.unlink()
        project = tmp_path / "project"
        project.mkdir()
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "No instruction read", "status": "active"},
            "tasks": [{"number": 1, "name": "Plan", "status": "pending"}],
        })
        _write_artifact(project, ".agentera/docs.yaml", {
            "mapping": [{"artifact": "PLAN.md", "path": ".agentera/plan.yaml"}],
        })

        r = _run_installed(app_home, "prime", "--context", "planera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        context = _flat_capability_context(data)
        contract = context["startup_contract"]
        first_read = context["first_invocation_read"]
        assert first_read["value"] == "compact_startup"
        assert first_read["instruction_target"]["exists"] is False
        assert contract["instructions_runtime_read_required"] is False
        assert contract["canonical_surface"] == "agentera prime --context planera --format json"

    def test_hej_capability_context_missing_artifact_schema_reports_error_without_state_needs(self, tmp_path):
        app_home = tmp_path / "app-home"
        _install_runtime_surface(app_home)
        artifacts_path = app_home / "app" / "skills" / "agentera" / "capabilities" / "planera" / "schemas" / "artifacts.yaml"
        artifacts_path.unlink()
        project = tmp_path / "project"
        project.mkdir()

        r = _run_installed(app_home, "prime", "--context", "planera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _flat_capability_context(json.loads(r.stdout))
        assert context["schema_error"] == "No capability artifact schema found for planera."
        assert context["declared_state_needs"] == []
        assert context["declared_write_targets"] == []
        assert context["missing_state_families"] == []

    def test_hej_capability_context_malformed_artifact_schema_reports_error_without_fabricated_needs(self, tmp_path):
        app_home = tmp_path / "app-home"
        _install_runtime_surface(app_home)
        artifacts_path = app_home / "app" / "skills" / "agentera" / "capabilities" / "planera" / "schemas" / "artifacts.yaml"
        artifacts_path.write_text(
            yaml.dump({
                "ARTIFACTS": {
                    1: {"artifact_id": "decisions", "local_role": "observes"},
                    2: "not a mapping",
                    3: {"local_role": "consumes"},
                },
            }),
            encoding="utf-8",
        )
        project = tmp_path / "project"
        project.mkdir()

        r = _run_installed(app_home, "prime", "--context", "planera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _flat_capability_context(json.loads(r.stdout))
        assert "unsupported local_role 'observes'" in context["schema_error"]
        assert "entry 2 is not a mapping" in context["schema_error"]
        assert "entry 3 is missing artifact_id" in context["schema_error"]
        assert context["declared_state_needs"] == []
        assert context["declared_write_targets"] == []
        assert context["included_state_families"] == []
        assert context["missing_state_families"] == []

    def test_compact_startup_exception_is_limited_to_planera(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Compact exception boundary", "status": "active"},
            "tasks": [{"number": 1, "name": "Boundary", "status": "pending"}],
        })

        capabilities = sorted(
            path.name
            for path in (REPO_ROOT / "skills" / "agentera" / "capabilities").iterdir()
            if path.is_dir()
        )
        contexts = {}
        for capability in capabilities:
            result = _run("prime", "--context", capability, "--format", "json", cwd=project)
            assert result.returncode == 0, result.stderr
            contexts[capability] = _flat_capability_context(json.loads(result.stdout))

        assert contexts["planera"]["first_invocation_read"]["value"] == "compact_startup"
        assert contexts["planera"]["startup_contract"]["instructions_runtime_read_required"] is False
        for capability, context in contexts.items():
            if capability == "planera":
                continue
            assert context["first_invocation_read"]["value"] == "full"
            assert "startup_contract" not in context

    def test_hej_orkestrera_context_reports_ready_blocked_and_selected_tasks(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Orchestration", "status": "active"},
            "tasks": [
                {"number": 1, "name": "Done", "status": "complete"},
                {
                    "number": 2,
                    "name": "Ready",
                    "status": "pending",
                    "depends_on": [1],
                    "acceptance": ["ready accepted"],
                    "evidence": [{"cycle": 7, "note": "ready evidence"}],
                },
                {
                    "number": 3,
                    "name": "Blocked",
                    "status": "pending",
                    "depends_on": [2],
                    "acceptance": ["blocked accepted"],
                },
            ],
        })
        _write_artifact(project, ".agentera/docs.yaml", {
            "mapping": [{"artifact": "PLAN.md", "path": ".agentera/plan.yaml"}],
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 7, "timestamp": "2026-05-14", "verified": "focused tests passed"}],
        })
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [{"number": 2, "trajectory": "stable", "grades": {"architecture_alignment": "B"}}],
        })
        _write_artifact(project, "TODO.md", {
            "entries": [{"severity": "normal", "status": "open", "description": "Track orchestration"}],
        })

        r = _run("prime", "--context", "orkestrera", "--format", "json", cwd=project)

        assert r.returncode == 0
        assert "agentera orkestrera" not in r.stdout
        data = json.loads(r.stdout)
        context = _prime_bespoke_context(data, "orchestration_context")
        assert context["capability"] == "orkestrera"
        assert context["task_queue"]["dependency_ready_tasks"][0]["number"] == 2
        assert context["task_queue"]["dependency_ready_tasks"][0]["acceptance_count"] == 1
        assert context["task_queue"]["dependency_ready_tasks"][0]["evidence_count"] == 1
        assert context["task_queue"]["blocked_tasks"][0]["number"] == 3
        assert context["task_queue"]["blocked_tasks"][0]["blocked_reasons"] == ["dependency 2 is pending"]
        assert context["selected_next_task"]["number"] == 2
        assert context["selected_next_action"]["capability"] == "orkestrera"
        verification = context["progress_verification"]
        assert verification["status"] == "available"
        assert verification["cycle"] == {"number": 7, "timestamp": "2026-05-14"}
        assert verification["verified_present"] is True
        assert verification["latest_progress_verification_pointer"] == {
            "source_family": "progress",
            "command": "agentera progress --format json",
            "cycle_number": 7,
            "field": "verified",
        }
        assert verification["caveats"] == []
        retry_state = context["retry_state"]
        assert retry_state["status"] == "not_recorded"
        assert retry_state["source_provenance"]["source_family"] == "progress"
        assert retry_state["source_provenance"]["command"] == "agentera progress --format json"
        assert "attempt_count" not in retry_state
        handoff = context["evaluator_handoff"]
        assert handoff["status"] == "ready"
        assert handoff["task"] == {"number": 2, "name": "Ready", "status": "pending"}
        assert handoff["acceptance_criteria"] == ["ready accepted"]
        assert handoff["evidence_requirements"] == [{"cycle": 7, "note": "ready evidence"}]
        assert handoff["latest_progress_verification_pointer"] == verification["latest_progress_verification_pointer"]
        assert "Retry attempt state is not recorded; no attempt count is exposed." in handoff["evaluation_caveats"]
        contract = context["source_contract"]
        assert contract["complete_for_orchestration_context"] is False
        assert contract["raw_artifact_reads_required"] is False
        assert "last-resort diagnostics" in contract["raw_artifact_read_policy"]
        assert contract["missing_state_families"] == ["decisions", "vision", "profile"]
        assert contract["fallback_commands"] == ["agentera decisions --format json"]
        assert "profile-derived state is unavailable in prime --context response." in contract["caveats"]
        assert "latest progress verification summary" in contract["owns"]
        assert "retry_state provenance" in contract["owns"]
        assert "evaluator handoff inputs" in contract["owns"]
        assert contract["deferred"] == []

    def test_hej_orkestrera_context_can_be_complete_when_declared_needs_are_in_startup_envelope(self, project):
        app_home = project / "app-home"
        _install_runtime_surface(app_home)
        artifacts_path = app_home / "app" / "skills" / "agentera" / "capabilities" / "orkestrera" / "schemas" / "artifacts.yaml"
        artifacts = yaml.safe_load(artifacts_path.read_text(encoding="utf-8"))
        artifacts["ARTIFACTS"] = {
            key: value
            for key, value in artifacts["ARTIFACTS"].items()
            if value.get("artifact_id") in {"plan", "progress", "health", "todo", "docs"}
        }
        artifacts_path.write_text(yaml.dump(artifacts, default_flow_style=False), encoding="utf-8")
        profile = project / ".xdg" / "agentera" / "PROFILE.md"
        profile.parent.mkdir(parents=True)
        profile.write_text("# Fresh profile\n", encoding="utf-8")
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Complete context", "status": "active"},
            "tasks": [
                {"number": 1, "name": "Ready", "status": "pending", "acceptance": ["selected"], "evidence": ["observable"]},
            ],
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 1, "timestamp": "2026-05-14", "verified": "complete path verified"}],
        })
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [{"number": 1, "trajectory": "stable", "grades": {"architecture_alignment": "B"}}],
        })
        _write_artifact(project, ".agentera/docs.yaml", {
            "mapping": [{"artifact": "PLAN.md", "path": ".agentera/plan.yaml"}],
        })
        _write_artifact(project, "TODO.md", {
            "entries": [{"severity": "normal", "status": "open", "description": "Track validation"}],
        })

        r = _run_installed(app_home, "prime", "--context", "orkestrera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "orchestration_context")
        contract = context["source_contract"]
        assert context["selected_next_task"]["number"] == 1
        assert context["task_queue"]["blocked_tasks"] == []
        assert context["progress_verification"]["verified_present"] is True
        assert context["retry_state"]["status"] == "not_recorded"
        assert "attempt_count" not in context["retry_state"]
        assert context["evaluator_handoff"]["status"] == "ready"
        assert context["state_family_caveats"] == []
        assert context["fallback_commands"] == []
        assert contract["complete_for_orchestration_context"] is True
        assert contract["raw_artifact_reads_required"] is False
        assert "raw artifact reads are last-resort diagnostics" in contract["raw_artifact_read_policy"]
        assert "agentera orkestrera" not in json.dumps(context)

    def test_hej_orkestrera_context_preserves_compacted_decision_fallback_caveat(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Decision caveat", "status": "active"},
            "tasks": [{"number": 1, "name": "Ready", "status": "pending", "acceptance": ["selected"]}],
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 1, "timestamp": "2026-05-14", "verified": "selected"}],
        })
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [],
            "archive": [{"summary": "Decision 9 (2026-05-14): compacted orchestration caveat"}],
        })

        context_result = _run("prime", "--context", "orkestrera", "--format", "json", cwd=project)
        decisions_result = _run("decisions", "--format", "json", cwd=project)

        assert context_result.returncode == 0
        context = _prime_bespoke_context(json.loads(context_result.stdout), "orchestration_context")
        assert "agentera decisions --format json" in context["fallback_commands"]
        assert "decisions state is not included in prime --context startup context." in context["evaluator_handoff"]["evaluation_caveats"]
        assert context["source_contract"]["complete_for_orchestration_context"] is False
        assert context["source_contract"]["raw_artifact_reads_required"] is False
        assert decisions_result.returncode == 0
        decisions = json.loads(decisions_result.stdout)
        assert decisions["entries"][0]["compacted"] is True
        assert decisions["entries"][0]["context_complete"] is False
        assert decisions["source_contract"]["complete_for_returned_decisions"] is False
        assert decisions["source_contract"]["complete_for_normal_deliberation_context"] is True
        assert decisions["source_contract"]["completeness"]["compacted_entries"] == 1
        assert decisions["source_contract"]["compacted_history_boundary"]["raw_artifact_read_required"] is False

    def test_hej_orkestrera_context_caveats_latest_progress_without_verified(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Progress caveat", "status": "active"},
            "tasks": [
                {"number": 1, "name": "Done", "status": "complete"},
                {"number": 2, "name": "Ready", "status": "pending", "depends_on": [1], "acceptance": ["audit ready"]},
            ],
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 8, "timestamp": "2026-05-14", "type": "fix", "phase": "build"}],
        })

        r = _run("prime", "--context", "orkestrera", "--format", "json", cwd=project)

        assert r.returncode == 0
        context = _prime_bespoke_context(json.loads(r.stdout), "orchestration_context")
        verification = context["progress_verification"]
        assert verification["status"] == "available"
        assert verification["cycle"] == {"number": 8, "timestamp": "2026-05-14", "type": "fix", "phase": "build"}
        assert verification["verified_present"] is False
        assert verification["caveats"] == ["Latest progress cycle has no non-empty verified evidence."]
        assert "Latest progress cycle has no non-empty verified evidence." in context["evaluator_handoff"]["evaluation_caveats"]

    def test_hej_orkestrera_context_caveats_missing_progress(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Missing progress", "status": "active"},
            "tasks": [{"number": 1, "name": "Ready", "status": "pending", "acceptance": ["selected"]}],
        })

        r = _run("prime", "--context", "orkestrera", "--format", "json", cwd=project)

        assert r.returncode == 0
        context = _prime_bespoke_context(json.loads(r.stdout), "orchestration_context")
        verification = context["progress_verification"]
        assert verification["status"] == "unavailable"
        assert verification["source_provenance"] == {
            "source_family": "progress",
            "command": "agentera progress --format json",
        }
        assert verification["cycle"] is None
        assert verification["verified_present"] is False
        assert verification["latest_progress_verification_pointer"] is None
        assert verification["caveats"] == ["No progress cycles are recorded in CLI progress state."]
        assert "agentera progress --format json" in context["fallback_commands"]
        assert "No progress cycles are recorded in CLI progress state." in context["evaluator_handoff"]["evaluation_caveats"]

    def test_hej_orkestrera_context_lists_fallbacks_when_state_is_incomplete(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Incomplete", "status": "active"},
            "tasks": [{"number": 1, "name": "Ready", "status": "pending"}],
        })

        r = _run("prime", "--context", "orkestrera", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        context = _prime_bespoke_context(data, "orchestration_context")
        assert context["selected_next_task"]["number"] == 1
        assert context["source_contract"]["complete_for_orchestration_context"] is False
        assert context["fallback_commands"] == [
            "agentera decisions --format json",
            "agentera progress --format json",
            "agentera health --format json",
            "agentera docs --format json",
            "agentera todo --format json",
        ]
        assert "raw artifact reads are last-resort diagnostics" in context["source_contract"]["raw_artifact_read_policy"]
        assert "agentera orkestrera" not in json.dumps(context)

    def test_hej_dokumentera_closeout_context_reports_required_closeout_state(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "2.3.9 Dokumentera Closeout Context Source Contract", "status": "active"},
            "tasks": [{"number": 1, "name": "Closeout", "status": "pending"}],
        })
        mapping = [
            {"artifact": "TODO.md", "path": "TODO.md"},
            {"artifact": "CHANGELOG.md", "path": "CHANGELOG.md"},
            {"artifact": "PROGRESS.md", "path": ".agentera/progress.yaml"},
            {"artifact": "DOCS.md", "path": ".agentera/docs.yaml"},
        ]
        _write_artifact(project, ".agentera/docs.yaml", {
            "conventions": {
                "version_files": ["pyproject.toml"],
                "version_files_registry": "references/adapters/package-registry.yaml docs_targets.version_files",
                "semver_policy": {"feat": "minor", "fix": "patch", "docs/chore/test": "no bump"},
            },
            "mapping": mapping,
            "coverage": {"tests": "Benchmark evidence is retained through CLI-visible startup summaries."},
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 9, "timestamp": "2026-05-15", "verified": "closeout context tests passed"}],
        })
        _write_artifact(project, "TODO.md", {
            "entries": [{"severity": "normal", "status": "open", "description": "Track 2.3.9 closeout"}],
        })
        (project / "CHANGELOG.md").write_text(
            "# Changelog\n\n## [Unreleased]\n\n- Prior closeout remains visible; the 2.3.9+ train stays deferred.\n",
            encoding="utf-8",
        )

        r = _run("prime", "--context", "dokumentera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        assert "agentera dokumentera" not in r.stdout
        data = json.loads(r.stdout)
        capability_context = _flat_capability_context(data)
        assert capability_context["capability"] == "dokumentera"
        assert "changelog" in capability_context["declared_state_needs"]
        assert "agentera query changelog --format json" in capability_context["cli_fallback"]

        context = _prime_bespoke_context(data, "closeout_context")
        assert context["capability"] == "dokumentera"
        assert context["artifact_mappings"]["entries"] == mapping
        assert context["version_policy"]["semver_policy"]["fix"] == "patch"
        assert context["todo_blockers"]["open_count"] == 1
        assert context["todo_blockers"]["items"][0]["text"] == "Track 2.3.9 closeout"
        assert context["changelog_boundary"]["selected_target_version"] == "2.3.9"
        assert context["changelog_boundary"]["selected_target_recorded"] is False
        assert context["changelog_boundary"]["unreleased_present"] is True
        assert context["changelog_boundary"]["source_provenance"]["internal_source"] == "CLI-resolved CHANGELOG.md heading scan"
        assert context["progress_evidence"]["cycle"] == {"number": 9, "timestamp": "2026-05-15"}
        assert context["progress_evidence"]["verified_present"] is True
        assert context["progress_evidence"]["non_empty_evidence_present"] is True
        assert context["progress_evidence"]["non_empty_evidence_fields"] == ["verified"]
        assert context["benchmark_evidence"]["status"] == "available"
        assert context["benchmark_evidence"]["non_empty_evidence_present"] is True
        assert context["benchmark_evidence"]["user_local_benchmark_reads_required"] is False
        assert context["release_boundary"]["local_metadata_evidence"]["status"] == "not_recorded"
        assert context["release_boundary"]["publication_evidence"]["remote_push"] == "not_recorded_in_cli_state"
        assert context["release_boundary"]["publication_evidence"]["remote_checks_performed"] is False
        assert context["release_boundary"]["app_refresh_evidence"]["refresh"] == "not_recorded_in_cli_state"
        assert "agentera query --list-artifacts --format json" in context["fallback_commands"]
        assert "agentera decisions --format json" in context["fallback_commands"]
        contract = context["source_contract"]
        assert contract["complete_for_closeout_context"] is True
        assert contract["caveated"] is True
        assert contract["raw_artifact_reads_required"] is False
        assert "raw artifact reads are last-resort diagnostics" in contract["raw_artifact_read_policy"]
        assert "changelog" in contract["closeout_state_families"]
        assert contract["missing_required_closeout_state"] == []
        assert "local metadata/tag versus publication boundary" in contract["owns"]
        assert "provenance pointers and non-empty evidence flags" in contract["owns"]
        assert "truthful completeness flag" in contract["owns"]

    def test_hej_dokumentera_closeout_context_marks_required_missing_state_incomplete(self, project):
        r = _run("prime", "--context", "dokumentera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "closeout_context")
        contract = context["source_contract"]
        assert contract["complete_for_closeout_context"] is False
        assert set(contract["missing_required_closeout_state"]) == {
            "artifact_mappings",
            "version_policy",
            "todo_blockers",
            "changelog_boundary",
            "progress_evidence",
        }
        assert contract["raw_artifact_reads_required"] is False
        assert context["fallback_commands"][:5] == [
            "agentera todo --format json",
            "agentera docs --format json",
            "agentera progress --format json",
            "agentera query changelog --format json",
            "agentera query --list-artifacts --format json",
        ]
        assert "agentera dokumentera" not in json.dumps(context)

    def test_hej_dokumentera_closeout_context_caveats_unavailable_benchmark_evidence(self, project):
        _write_artifact(project, ".agentera/docs.yaml", {
            "conventions": {"semver_policy": {"feat": "minor", "fix": "patch"}},
            "mapping": [{"artifact": "DOCS.md", "path": ".agentera/docs.yaml"}],
            "coverage": {"tests": "Focused tests passed."},
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 3, "timestamp": "2026-05-15", "verified": "tests passed"}],
        })
        _write_artifact(project, "TODO.md", {"entries": []})
        (project / "CHANGELOG.md").write_text("# Changelog\n\n## [Unreleased]\n", encoding="utf-8")

        r = _run("prime", "--context", "dokumentera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "closeout_context")
        assert context["benchmark_evidence"]["status"] == "unavailable"
        assert context["benchmark_evidence"]["history_scope"] == "not_exposed_by_supported_cli_state"
        assert context["benchmark_evidence"]["user_local_benchmark_reads_required"] is False
        assert "do not read user-local benchmark files" in context["benchmark_evidence"]["caveats"][0]
        assert context["source_contract"]["complete_for_closeout_context"] is True
        assert context["source_contract"]["caveated"] is True

    def test_hej_dokumentera_closeout_context_distinguishes_local_tag_from_publication(self, project):
        subprocess.run(["git", "init"], cwd=project, capture_output=True, text=True, check=True)
        blob = subprocess.run(
            ["git", "hash-object", "-w", "--stdin"],
            cwd=project,
            input="tag target\n",
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        subprocess.run(["git", "tag", "v2.3.9", blob], cwd=project, capture_output=True, text=True, check=True)
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "2.3.9 Dokumentera Closeout Context Source Contract", "status": "active"},
            "tasks": [{"number": 1, "name": "Closeout", "status": "pending"}],
        })
        _write_artifact(project, ".agentera/docs.yaml", {
            "conventions": {"semver_policy": {"feat": "minor", "fix": "patch"}},
            "mapping": [{"artifact": "DOCS.md", "path": ".agentera/docs.yaml"}],
            "coverage": {"tests": "Benchmark evidence is retained through CLI-visible summaries."},
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 3, "timestamp": "2026-05-15", "verified": "tests passed"}],
        })
        _write_artifact(project, "TODO.md", {"entries": []})
        (project / "CHANGELOG.md").write_text(
            "# Changelog\n\n## [Unreleased]\n\n## [2.3.9] - local closeout\n",
            encoding="utf-8",
        )

        r = _run("prime", "--context", "dokumentera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        release_boundary = _prime_bespoke_context(json.loads(r.stdout), "closeout_context")["release_boundary"]
        assert release_boundary["local_metadata_evidence"]["status"] == "recorded"
        assert release_boundary["local_tag_evidence"]["status"] == "available"
        assert release_boundary["local_tag_evidence"]["tag"] == "v2.3.9"
        assert release_boundary["local_tag_evidence"]["object_type"] == "blob"
        assert release_boundary["publication_evidence"]["package_publication"] == "not_recorded_in_cli_state"
        assert release_boundary["publication_evidence"]["remote_push"] == "not_recorded_in_cli_state"
        assert release_boundary["publication_evidence"]["remote_checks_performed"] is False

    def test_hej_dokumentera_closeout_context_blocks_stale_protected_decisions(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "2.3.9 Dokumentera Closeout Context Source Contract", "status": "active"},
            "tasks": [{"number": 1, "name": "Closeout", "status": "pending"}],
        })
        _write_artifact(project, ".agentera/docs.yaml", {
            "conventions": {"version_files": ["pyproject.toml"], "semver_policy": {"fix": "patch"}},
            "mapping": [{"artifact": "DOCS.md", "path": ".agentera/docs.yaml"}],
            "coverage": {"tests": "Benchmark evidence is retained through CLI-visible summaries."},
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 3, "timestamp": "2026-05-15", "verified": "tests passed"}],
        })
        _write_artifact(project, "TODO.md", {"entries": []})
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": index,
                    "date": "2026-05-14",
                    "question": f"Protected decision {index}?",
                    "context": "Compaction pressure fixture.",
                    "alternatives": ["Review", "Defer"],
                    "choice": "Review",
                    "reasoning": "Open satisfaction is protected from compaction.",
                    "confidence": 80,
                    "feeds_into": ["PLAN Task 4"],
                    "satisfaction": {"state": "open"},
                }
                for index in range(1, 12)
            ],
        })
        (project / "CHANGELOG.md").write_text("# Changelog\n\n## [Unreleased]\n", encoding="utf-8")

        r = _run("prime", "--context", "dokumentera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "closeout_context")
        pressure = context["decision_review_pressure"]
        assert pressure["status"] == "review_required"
        assert pressure["summary"]["protected_overflow_count"] == 1
        assert any("10/40/50 compaction budget" in caveat for caveat in pressure["caveats"])
        assert context["source_contract"]["complete_for_closeout_context"] is False
        assert "decision_review_pressure" in context["source_contract"]["missing_required_closeout_state"]
        assert any("10/40/50 compaction budget" in caveat for caveat in context["state_family_caveats"])

    def test_hej_dokumentera_closeout_context_does_not_fabricate_decision_review_pressure(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "2.3.9 Dokumentera Closeout Context Source Contract", "status": "active"},
            "tasks": [{"number": 1, "name": "Closeout", "status": "pending"}],
        })
        _write_artifact(project, ".agentera/docs.yaml", {
            "conventions": {"version_files": ["pyproject.toml"], "semver_policy": {"fix": "patch"}},
            "mapping": [{"artifact": "DOCS.md", "path": ".agentera/docs.yaml"}],
            "coverage": {"tests": "Benchmark evidence is retained through CLI-visible summaries."},
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 3, "timestamp": "2026-05-15", "verified": "tests passed"}],
        })
        _write_artifact(project, "TODO.md", {"entries": []})
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": 1,
                    "date": "2026-05-14",
                    "question": "Protected but not stale?",
                    "context": "Review date has not elapsed.",
                    "alternatives": ["Review later", "Close"],
                    "choice": "Review later",
                    "reasoning": "Open satisfaction is protected but not stale.",
                    "confidence": 75,
                    "feeds_into": ["PLAN Task 4"],
                    "satisfaction": {"state": "open", "review_date": "2999-01-01"},
                }
            ],
        })
        (project / "CHANGELOG.md").write_text("# Changelog\n\n## [Unreleased]\n", encoding="utf-8")

        r = _run("prime", "--context", "dokumentera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "closeout_context")
        assert context["decision_review_pressure"]["status"] == "available"
        assert context["decision_review_pressure"]["caveats"] == []
        assert context["source_contract"]["complete_for_closeout_context"] is True
        assert "decision_review_pressure" not in context["source_contract"]["missing_required_closeout_state"]
        assert not any("10/40/50 compaction budget" in caveat for caveat in context["state_family_caveats"])

    def test_dokumentera_capability_command_emits_routing_guidance(self, project):
        r = _run("dokumentera", cwd=project)

        assert r.returncode == 0
        assert "startup context: agentera prime --context dokumentera --format json" in r.stdout

    def test_hej_inspektera_evidence_context_reports_required_evidence_state(self, project):
        _seed_inspektera_evidence_context(project)

        r = _run("prime", "--context", "inspektera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        assert "agentera inspektera" not in r.stdout
        data = json.loads(r.stdout)
        context = _prime_bespoke_context(data, "evidence_context")
        assert set(context) == {
            "capability",
            "evaluation_target",
            "plan_criteria",
            "progress_verification",
            "docs_state",
            "health_state",
            "todo_state",
            "protected_state_checks",
            "version_checks",
            "decision_context",
            "decision_review_pressure",
            "residual_risks",
            "state_family_caveats",
            "fallback_commands",
            "source_contract",
        }
        assert context["capability"] == "inspektera"
        assert context["evaluation_target"]["status"] == "selected"
        assert context["evaluation_target"]["task"] == {"number": 2, "name": "Focused evidence-context regression coverage", "status": "pending"}
        assert context["evaluation_target"]["selection_reason"] == "first_dependency_ready_pending_task"
        assert context["evaluation_target"]["source_provenance"] == {
            "source_family": "plan",
            "command": "agentera plan --format json",
            "field": "entries.depends_on",
        }
        assert context["plan_criteria"]["criteria"] == ["emit context"]
        assert context["plan_criteria"]["source_provenance"] == {
            "source_family": "plan",
            "command": "agentera plan --format json",
            "field": "entries.acceptance",
        }
        assert context["plan_criteria"]["non_empty_evidence_present"] is True
        assert context["plan_criteria"]["non_empty_evidence_fields"] == ["criteria"]
        assert context["progress_verification"]["verified_present"] is True
        assert context["progress_verification"]["source_provenance"] == {
            "source_family": "progress",
            "command": "agentera progress --format json",
        }
        assert context["progress_verification"]["non_empty_evidence_present"] is True
        assert context["docs_state"]["mapping_entries"] == 1
        assert context["docs_state"]["source_provenance"] == {
            "source_family": "docs",
            "command": "agentera docs --format json",
        }
        assert context["docs_state"]["non_empty_evidence_present"] is True
        assert context["health_state"]["audit_number"] == 12
        assert context["health_state"]["source_provenance"] == {
            "source_family": "health",
            "command": "agentera health --format json",
        }
        assert context["health_state"]["non_empty_evidence_present"] is True
        assert context["todo_state"]["open_count"] == 1
        assert context["todo_state"]["source_provenance"] == {
            "source_family": "todo",
            "command": "agentera todo --format json",
        }
        assert context["todo_state"]["non_empty_evidence_present"] is True
        assert context["protected_state_checks"]["status"] == "not_checked_by_design"
        assert context["protected_state_checks"]["checks"][0]["status"] == "not_checked_by_design"
        assert context["version_checks"]["status"] == "requires_manual_check"
        assert context["version_checks"]["source_provenance"] == {
            "source_family": "docs",
            "command": "agentera docs --format json",
            "field": "summary.conventions",
        }
        assert context["decision_review_pressure"]["status"] == "unavailable"
        assert context["decision_review_pressure"]["caveats"] == []
        version_statuses = {check["name"]: check["status"] for check in context["version_checks"]["checks"]}
        assert version_statuses["docs_version_policy"] == "verified_local"
        assert version_statuses["version_files"] == "verified_local"
        assert version_statuses["publication_evidence"] == "requires_manual_check"
        assert version_statuses["installed_app_refresh"] == "not_checked_by_design"
        assert "Retry attempt state is not recorded; no attempt count is exposed." in context["residual_risks"]["items"]
        assert context["residual_risks"]["attributed_item_count"] >= 1
        assert "agentera plan --format json" in context["fallback_commands"]
        assert "agentera decisions --format json" in context["fallback_commands"]
        contract = context["source_contract"]
        assert contract["complete_for_evidence_context"] is True
        assert contract["caveated"] is True
        assert contract["raw_artifact_reads_required"] is False
        assert "raw artifact reads are last-resort diagnostics" in contract["raw_artifact_read_policy"]
        assert contract["required_evidence_state"] == {
            "evaluation_target": True,
            "plan_criteria": True,
            "progress_verification": True,
            "docs_state": True,
            "health_state": True,
            "todo_state": True,
            "source_contract": True,
        }
        assert contract["missing_required_evidence_state"] == []
        assert "truthful completeness metadata" in contract["owns"]
        assert "attributed residual risks" in contract["owns"]
        assert "Task 3 provenance, protected-state, and residual-risk semantics" not in contract["deferred"]
        assert "Task 4 Inspektera guidance and schema integration" not in contract["deferred"]

    def test_hej_inspektera_complete_context_keeps_startup_guidance_cli_first(self, project):
        _seed_inspektera_evidence_context(project)

        r = _run(
            "prime",
            "--context",
            "inspektera",
            "--format",
            "json",
            "--fields",
            "evidence_context,source_contract",
            cwd=project,
        )

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "evidence_context")
        contract = context["source_contract"]
        assert contract["complete_for_evidence_context"] is True
        assert contract["missing_required_evidence_state"] == []
        assert contract["raw_artifact_reads_required"] is False
        assert "last-resort diagnostics" in contract["raw_artifact_read_policy"]
        assert all(command.startswith("agentera ") for command in contract["fallback_commands"])
        assert not any(".agentera/" in command or command.endswith(".md") for command in contract["fallback_commands"])

        prose = (REPO_ROOT / "skills" / "agentera" / "capabilities" / "inspektera" / "instructions.md").read_text(encoding="utf-8")
        assert "If `evidence_context.source_contract.complete_for_evidence_context` is true" in prose
        assert "do not read raw PLAN, PROGRESS, DOCS, HEALTH, TODO, or DECISIONS artifacts" in prose
        assert "Raw artifact reads are last-resort diagnostics" in prose
        assert "Read HEALTH.md, TODO.md, and PROGRESS.md in parallel" not in prose
        assert "before raw plan, progress, docs, health, TODO, or decisions artifacts" in prose
        orient_step = prose.split("## Step 1: Orient", 1)[1].split("## Step 2:", 1)[0]
        for raw_startup_marker in ("HEALTH.md", "DECISIONS.md", "TODO.md", "PROGRESS.md", "PLAN.md"):
            assert raw_startup_marker not in orient_step
        for cli_first_marker in (
            "evidence_context.health_state",
            "evidence_context.decision_context",
            "evidence_context.todo_state",
            "evidence_context.progress_verification",
            "evidence_context.evaluation_target",
            "evidence_context.plan_criteria",
        ):
            assert cli_first_marker in orient_step

    def test_hej_inspektera_evidence_context_marks_missing_required_state_incomplete(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Missing progress", "status": "active"},
            "tasks": [{"number": 1, "name": "Ready", "status": "pending", "acceptance": ["selected"]}],
        })
        _write_artifact(project, ".agentera/docs.yaml", {
            "mapping": [{"artifact": "PLAN.md", "path": ".agentera/plan.yaml"}],
        })
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [{"number": 1, "trajectory": "stable", "grades": {"Architecture": "B"}}],
        })
        _write_artifact(project, "TODO.md", {
            "entries": [{"severity": "normal", "status": "open", "description": "Track evidence"}],
        })

        r = _run("prime", "--context", "inspektera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "evidence_context")
        contract = context["source_contract"]
        assert contract["complete_for_evidence_context"] is False
        assert contract["missing_required_evidence_state"] == ["progress_verification"]
        assert context["progress_verification"]["status"] == "unavailable"
        assert "No progress cycles are recorded in CLI progress state." in contract["caveats"]
        assert contract["raw_artifact_reads_required"] is False
        assert "agentera progress --format json" in contract["fallback_commands"]
        assert "agentera inspektera" not in json.dumps(context)

    def test_hej_inspektera_evidence_context_marks_missing_plan_criteria_incomplete(self, project):
        _seed_inspektera_evidence_context(project, acceptance=[])

        r = _run("prime", "--context", "inspektera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "evidence_context")
        contract = context["source_contract"]
        assert context["plan_criteria"] == {
            "status": "incomplete",
            "source_provenance": {
                "source_family": "plan",
                "command": "agentera plan --format json",
                "field": "entries.acceptance",
            },
            "target": {"number": 2, "name": "Focused evidence-context regression coverage", "status": "pending"},
            "criteria": [],
            "criteria_count": 0,
            "non_empty_evidence_present": False,
            "non_empty_evidence_fields": [],
            "caveats": ["Selected evaluation target has no acceptance criteria in CLI plan state."],
        }
        assert contract["complete_for_evidence_context"] is False
        assert contract["missing_required_evidence_state"] == ["plan_criteria"]
        assert "agentera plan --format json" in contract["fallback_commands"]
        assert "Selected evaluation target has no acceptance criteria in CLI plan state." in contract["caveats"]

    def test_hej_inspektera_evidence_context_preserves_stale_docs_and_health_caveats(self, project):
        _seed_inspektera_evidence_context(
            project,
            docs_last_audit="2026-01-01",
            health_timestamp="2026-01-01",
        )

        r = _run("prime", "--context", "inspektera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "evidence_context")
        contract = context["source_contract"]
        assert context["docs_state"]["status"] == "available"
        assert context["docs_state"]["current_state"] == "stale"
        assert context["health_state"]["status"] == "available"
        assert context["health_state"]["current_state"] == "stale"
        assert contract["complete_for_evidence_context"] is True
        assert contract["missing_required_evidence_state"] == []
        assert any(caveat.startswith("Docs evidence is stale") for caveat in contract["caveats"])
        assert any(caveat.startswith("Health evidence is stale") for caveat in contract["caveats"])

    def test_hej_inspektera_evidence_context_reports_protected_state_as_unknown_by_design(self, project):
        _seed_inspektera_evidence_context(project)

        r = _run("prime", "--context", "inspektera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        protected = _prime_bespoke_context(json.loads(r.stdout), "evidence_context")["protected_state_checks"]
        assert protected["status"] == "not_checked_by_design"
        assert protected["allowed_status_values"] == [
            "verified_local",
            "not_checked_by_design",
            "requires_manual_check",
            "unavailable",
        ]
        assert protected["source_provenance"] == {
            "source_family": "evidence_context",
            "command": "agentera prime --context inspektera --format json",
            "field": "protected_state_checks",
        }
        assert {check["name"] for check in protected["checks"]} == {"vision_state", "objective_state"}
        assert all(check["checked"] is False for check in protected["checks"])
        assert all(check["status"] == "not_checked_by_design" for check in protected["checks"])
        assert "Protected-state boundaries are reported without reading or modifying vision or objective state." in protected["caveats"]

    def test_hej_inspektera_evidence_context_preserves_attributed_decision_and_profile_caveats(self, project):
        profile = project / ".xdg" / "agentera" / "PROFILE.md"
        profile.parent.mkdir(parents=True)
        profile.write_text("<!-- Generated: 2026-04-01 -->\n# Profile\n", encoding="utf-8")
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Residual risks", "status": "active"},
            "tasks": [{"number": 1, "name": "Ready", "status": "pending", "acceptance": ["selected"]}],
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 1, "timestamp": "2026-05-15", "verified": "tests passed"}],
        })
        _write_artifact(project, ".agentera/docs.yaml", {
            "mapping": [{"artifact": "PLAN.md", "path": ".agentera/plan.yaml"}],
            "conventions": {"semver_policy": {"fix": "patch"}, "version_files": ["pyproject.toml"]},
        })
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [{"number": 1, "trajectory": "stable", "grades": {"Architecture": "B"}}],
        })
        _write_artifact(project, "TODO.md", {"entries": []})
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [],
            "archive": [{"summary": "Decision 9 (2026-05-14): compacted evidence caveat"}],
        })

        r = _run("prime", "--context", "inspektera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "evidence_context")
        decision_context = context["decision_context"]
        assert decision_context["status"] == "caveated"
        assert decision_context["summary"]["compacted_entries"] == 1
        assert "Compacted archive decisions are not expanded" in " ".join(decision_context["caveats"])
        caveats = context["state_family_caveats"]
        assert any("profile-derived state is stale" in caveat for caveat in caveats)
        assert any("Compacted archive decisions" in caveat for caveat in caveats)

    def test_hej_inspektera_evidence_context_attributes_stale_protected_decision_review_pressure(self, project):
        _seed_inspektera_evidence_context(project, decisions={
            "decisions": [{
                "number": 7,
                "date": "2026-05-14",
                "question": "Review old protected decision?",
                "context": "Review date elapsed.",
                "alternatives": ["Review", "Defer"],
                "choice": "Review",
                "reasoning": "Open satisfaction needs user review.",
                "confidence": 75,
                "feeds_into": ["PLAN Task 4"],
                "satisfaction": {"state": "open", "review_date": "2026-01-01"},
            }],
        })

        r = _run("prime", "--context", "inspektera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "evidence_context")
        pressure = context["decision_review_pressure"]
        assert pressure["status"] == "review_required"
        assert pressure["stale_protected_decisions"][0]["reason"] == "review_date_elapsed"
        assert "satisfaction.review_date elapsed" in pressure["caveats"][0]
        assert any("satisfaction.review_date elapsed" in caveat for caveat in context["state_family_caveats"])

    def test_hej_inspektera_evidence_context_does_not_fabricate_decision_review_warnings(self, project):
        _seed_inspektera_evidence_context(project, decisions={
            "decisions": [{
                "number": 8,
                "date": "2026-05-14",
                "question": "Future protected review?",
                "context": "Review date has not elapsed.",
                "alternatives": ["Review later", "Close"],
                "choice": "Review later",
                "reasoning": "Open satisfaction is protected but not stale.",
                "confidence": 75,
                "feeds_into": ["PLAN Task 4"],
                "satisfaction": {"state": "open", "review_date": "2999-01-01"},
            }],
        })

        r = _run("prime", "--context", "inspektera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "evidence_context")
        assert context["decision_review_pressure"]["status"] == "available"
        assert context["decision_review_pressure"]["caveats"] == []
        assert "decision_review_pressure" not in json.dumps(context["residual_risks"])

    def test_hej_optimera_benchmark_context_reports_retained_benchmark_summary(self, project):
        app_home = project / "app-home"
        _install_runtime_surface(app_home)
        benchmark_dir = _write_startup_benchmark_fixture(app_home)

        r = _run_installed(app_home, "prime", "--context", "optimera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        assert "agentera optimera" not in r.stdout
        data = json.loads(r.stdout)
        capability_context = _flat_capability_context(data)
        assert capability_context["capability"] == "optimera"
        assert "benchmark_context" in capability_context["included_state_families"]
        assert "optimera_harness" not in capability_context["declared_state_needs"]
        assert "optimera_harness" not in capability_context["missing_state_families"]
        assert "optimera_harness" in capability_context["declared_write_targets"]
        context = _prime_bespoke_context(data, "benchmark_context")
        context_text = json.dumps(context, sort_keys=True)
        assert str(app_home) not in context_text
        assert str(benchmark_dir) not in context_text
        assert "raw_benchmark_report_bodies" in context_text
        assert context["source_contract"]["complete_for_benchmark_context"] is True
        assert context["source_contract"]["raw_artifact_reads_required"] is False
        assert "last-resort direct latest-report.json" in context["source_contract"]["raw_artifact_read_policy"]
        assert context["latest_report"]["total_state_sequences"] == 9
        assert context["history_summary"]["row_count"] == 1
        assert "git_commit" not in context["history_summary"]["latest_row"]
        assert context["runtime_coverage"]["status"] == "degraded"
        assert context["state_access_metrics"]["raw_after_cli_sequence_rate"] == 0.4444
        assert context["state_access_metrics"]["raw_artifact_access_after_cli_counts"] == {"PLAN.md": 3}
        assert any("unsafe label" in caveat for caveat in context["state_access_metrics"]["caveats"])
        assert context["token_impact"]["estimated_redundant_raw_tokens"] == 533
        assert context["comparison"]["status"] == "not_comparable"
        assert context["comparison"]["null_reason"] == "previous_missing_token_estimates"
        assert context["recommendation"]["action"] == "targeted_capability_guidance_fixes"
        assert context["manual_refresh"]["status"] == "available"
        assert context["manual_refresh"]["execution_status"] == "not_run_by_design"

    def test_hej_optimera_benchmark_context_marks_missing_retained_files_incomplete(self, project):
        app_home = project / "app-home"
        _install_runtime_surface(app_home)

        r = _run_installed(app_home, "prime", "--context", "optimera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "benchmark_context")
        contract = context["source_contract"]
        assert contract["complete_for_benchmark_context"] is False
        assert "latest_report" in contract["missing_required_benchmark_state"]
        assert "history_summary" in contract["missing_required_benchmark_state"]
        assert context["latest_report"]["status"] == "missing"
        assert context["history_summary"]["status"] == "missing"
        assert context["manual_refresh"]["status"] == "requires_manual_run"
        assert "mage bench:startupState" == context["manual_refresh"]["command"]
        assert "agentera docs --format json" in context["fallback_commands"]
        assert contract["raw_artifact_reads_required"] is False

    def test_hej_optimera_benchmark_context_preserves_malformed_latest_report_boundary(self, project):
        app_home = project / "app-home"
        _install_runtime_surface(app_home)
        benchmark_dir = app_home / "benchmarks" / "startup-state"
        benchmark_dir.mkdir(parents=True)
        (benchmark_dir / "latest-report.json").write_text("{not json\n", encoding="utf-8")
        (benchmark_dir / "runs.jsonl").write_text(
            json.dumps({"generated_at": "2026-05-15T10:00:00+00:00", "runtime_scope": ["opencode"]}) + "\n",
            encoding="utf-8",
        )

        r = _run_installed(app_home, "prime", "--context", "optimera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "benchmark_context")
        assert context["latest_report"]["status"] == "malformed"
        assert context["source_contract"]["complete_for_benchmark_context"] is False
        assert "startup_benchmark_latest_report is malformed JSON." in context["source_contract"]["caveats"]
        assert context["manual_refresh"]["status"] == "requires_manual_run"

    def test_hej_optimera_benchmark_context_keeps_empty_history_caveated_not_raw(self, project):
        app_home = project / "app-home"
        _install_runtime_surface(app_home)
        _write_startup_benchmark_fixture(app_home, history_text="")

        r = _run_installed(app_home, "prime", "--context", "optimera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "benchmark_context")
        assert context["history_summary"]["status"] == "empty"
        assert context["source_contract"]["complete_for_benchmark_context"] is True
        assert context["source_contract"]["caveated"] is True
        assert context["history_summary"]["non_empty_evidence_present"] is False
        assert "direct retained benchmark file reads are last-resort diagnostics" in context["benchmark_source"]["normal_read_policy"]

    def test_hej_optimera_benchmark_context_caveats_skipped_or_missing_runtime_coverage(self, project):
        app_home = project / "app-home"
        _install_runtime_surface(app_home)
        _write_startup_benchmark_fixture(app_home, latest={
            "contract_version": "startup-state-analysis-v1",
            "generated_at": "2026-05-15T10:00:00+00:00",
            "benchmark_mode": "full_boundary_snapshot",
            "runtime_coverage": [
                {"runtime": "none", "status": "skipped", "reason": "no_runtime_stores_approved", "record_count": 0},
                {"runtime": "codex", "status": "missing", "reason": "runtime_store_missing", "record_count": 0},
            ],
            "total_records": 0,
            "total_state_sequences": 1,
            "state_sequences_with_raw_after_cli": 0,
            "state_sequences_with_redundant_raw_access": 0,
            "raw_after_cli_sequence_rate": 0,
            "redundant_raw_sequence_rate": 0,
            "cli_state_command_counts": {},
            "raw_artifact_access_after_cli_counts": {},
            "redundant_raw_artifact_access_counts": {},
            "per_capability_state_counts": {},
            "token_estimator_version": "approx_bytes_div_4_v1",
            "estimated_raw_after_cli_tokens": 0,
            "estimated_redundant_raw_tokens": 0,
            "estimated_raw_after_cli_tokens_by_artifact": {},
            "estimated_redundant_raw_tokens_by_artifact": {},
            "estimated_tokens_saved_vs_previous": None,
            "estimated_tokens_saved_vs_previous_null_reason": "previous_row_missing",
            "startup_recommendation": {"action": "close_without_implementation", "measured_trigger": "none"},
            "implementation_recommended": False,
        })

        r = _run_installed(app_home, "prime", "--context", "optimera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "benchmark_context")
        assert context["runtime_coverage"]["status"] == "degraded"
        assert "skipped" in context["runtime_coverage"]["status_counts"]
        assert "missing" in context["runtime_coverage"]["status_counts"]
        assert any("missing, skipped" in caveat for caveat in context["runtime_coverage"]["caveats"])
        assert context["source_contract"]["complete_for_benchmark_context"] is True

    def test_hej_optimera_benchmark_context_bounds_recommendation_privacy(self, project):
        app_home = project / "app-home"
        _install_runtime_surface(app_home)
        private_path = str(app_home / "benchmarks" / "startup-state" / "latest-report.json")
        _write_startup_benchmark_fixture(app_home, latest={
            "contract_version": private_path,
            "generated_at": private_path,
            "benchmark_mode": private_path,
            "benchmark_previous_watermark_at": private_path,
            "benchmark_window_started_after": private_path,
            "benchmark_watermark_at": private_path,
            "runtime_coverage": [{"runtime": "opencode", "status": "ok", "reason": "records_extracted", "record_count": 1}],
            "total_records": 1,
            "total_state_sequences": 1,
            "state_sequences_with_raw_after_cli": 1,
            "state_sequences_with_redundant_raw_access": 1,
            "raw_after_cli_sequence_rate": 1,
            "redundant_raw_sequence_rate": 1,
            "cli_state_command_counts": {},
            "raw_artifact_access_after_cli_counts": {},
            "redundant_raw_artifact_access_counts": {},
            "per_capability_state_counts": {},
            "token_estimator_version": private_path,
            "estimated_raw_after_cli_tokens": 8,
            "estimated_redundant_raw_tokens": 8,
            "estimated_raw_after_cli_tokens_by_artifact": {},
            "estimated_redundant_raw_tokens_by_artifact": {},
            "estimated_tokens_saved_vs_previous": None,
            "estimated_tokens_saved_vs_previous_null_reason": "previous_row_missing",
            "startup_recommendation": {
                "action": "custom_action_with_private_data",
                "measured_trigger": private_path,
                "rationale": f"raw body mentioned {private_path}",
            },
            "implementation_recommended": False,
        })

        r = _run_installed(app_home, "prime", "--context", "optimera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "benchmark_context")
        context_text = json.dumps(context, sort_keys=True)
        assert private_path not in context_text
        assert context["latest_report"]["contract_version"] is None
        assert context["latest_report"]["generated_at"] is None
        assert context["latest_report"]["benchmark_mode"] is None
        assert context["latest_report"]["benchmark_window"] == {
            "previous_watermark_at": None,
            "window_started_after": None,
            "watermark_at": None,
        }
        assert context["history_summary"]["latest_row"]["generated_at"] is None
        assert context["history_summary"]["latest_row"]["benchmark_mode"] is None
        assert context["history_summary"]["latest_row"]["startup_recommendation_action"] is None
        assert context["token_impact"]["token_estimator_version"] is None
        assert context["recommendation"]["action"] == "omitted_by_privacy_boundary"
        assert context["recommendation"]["measured_trigger"] == "omitted_by_privacy_boundary"
        assert context["recommendation"]["rationale"] is None
        assert context["recommendation"]["rationale_present"] is True
        assert any("not emitted" in caveat for caveat in context["recommendation"]["caveats"])

    def test_sparse_hej_benchmark_context_field_selection_uses_supported_seam(self, project):
        app_home = project / "app-home"
        _install_runtime_surface(app_home)
        _write_startup_benchmark_fixture(app_home)
        contract = yaml.safe_load(CONTRACT_PATH.read_text(encoding="utf-8"))
        available = contract["field_selection"]["fields_by_command"]["hej"]["fields"]

        r = _run_installed(
            app_home,
            "prime",
            "--context",
            "optimera",
            "--format",
            "json",
            "--fields",
            "benchmark_context",
            cwd=project,
        )

        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        assert list(data) == ["command", "status", "benchmark_context"]
        assert set(data).issubset(set(available) | {"command", "status"})
        assert _prime_bespoke_context(data, "benchmark_context")["source_contract"]["complete_for_benchmark_context"] is True
        assert "agentera optimera" not in r.stdout

    def test_sparse_hej_rejects_unsupported_benchmark_context_field_without_partial_stdout(self, project):
        app_home = project / "app-home"
        _install_runtime_surface(app_home)
        _write_startup_benchmark_fixture(app_home)

        r = _run_installed(
            app_home,
            "prime",
            "--context",
            "optimera",
            "--format",
            "json",
            "--fields",
            "benchmark_context,raw_yaml",
            cwd=project,
        )

        assert r.returncode == 1
        assert r.stdout == ""
        assert "unsupported field 'raw_yaml'" in r.stderr
        assert "benchmark_context" in r.stderr

    def test_optimera_capability_command_emits_routing_guidance(self, project):
        r = _run("optimera", cwd=project)

        assert r.returncode == 0
        assert "startup context: agentera prime --context optimera --format json" in r.stdout
        assert "not a routine state read" in r.stdout

    def test_hej_realisera_execution_context_reports_plan_driven_startup(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "2.3.12 Realisera Execution Context Source Contract", "status": "active"},
            "constraints": "Do not add `agentera realisera` or `agentera build`.",
            "tasks": [
                {"number": 1, "name": "Done", "status": "complete"},
                {
                    "number": 2,
                    "name": "Execution context output contract",
                    "status": "pending",
                    "depends_on": [1],
                    "acceptance": ["emit execution_context"],
                    "evidence": ["verify source contract"],
                },
            ],
        })
        _write_artifact(project, ".agentera/docs.yaml", {
            "mapping": [
                {"artifact": "PLAN.md", "path": ".agentera/plan.yaml"},
                {"artifact": "CHANGELOG.md", "path": "CHANGELOG.md"},
                {"artifact": "PROGRESS.md", "path": ".agentera/progress.yaml"},
            ],
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 10, "timestamp": "2026-05-15", "verified": "previous tests passed"}],
        })
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [{"number": 3, "trajectory": "stable", "grades": {"Architecture": "B"}}],
        })
        _write_artifact(project, "TODO.md", {
            "entries": [{"severity": "normal", "status": "open", "description": "Track execution context"}],
        })
        (project / "CHANGELOG.md").write_text("# Changelog\n\n## [Unreleased]\n", encoding="utf-8")

        r = _run(
            "prime",
            "--context",
            "realisera",
            "--format",
            "json",
            "--fields",
            "execution_context",
            cwd=project,
        )

        assert r.returncode == 0, r.stderr
        assert "agentera realisera" not in r.stdout
        assert "agentera build" not in r.stdout
        data = json.loads(r.stdout)
        meta = json.loads(_run("prime", "--context", "realisera", "--format", "json", cwd=project).stdout)
        capability_context = _flat_capability_context(meta)
        first_read = capability_context["first_invocation_read"]
        assert capability_context["capability"] == "realisera"
        assert first_read["value"] == "full"
        assert first_read["instruction_target"]["path"] == "skills/agentera/capabilities/realisera/instructions.md"
        assert first_read["obligation_summary"] == "full_instruction_file_read_required"
        assert first_read["provenance"]["authority_path"] == "references/cli/capability-instruction-contract.yaml"
        assert "agentera query changelog --format json" in capability_context["cli_fallback"]
        context = _prime_bespoke_context(data, "execution_context")
        assert context["mode"] == "plan_driven"
        assert context["work_selection"]["task"] == {"number": 2, "name": "Execution context output contract", "status": "pending"}
        assert context["constraints"]["plan_constraints_present"] is True
        assert context["acceptance_criteria"]["items"] == ["emit execution_context"]
        assert context["plan_task"]["evidence_summary"] == {"count": 1, "items": ["verify source contract"]}
        assert context["scope_boundary"]["source_scope"]["status"] == "unspecified"
        assert context["plan_completion_sweep"]["mutation_allowed"] is False
        assert context["changelog_boundary"]["unreleased_present"] is True
        assert context["source_contract"]["complete_for_execution_context"] is True
        assert context["source_contract"]["raw_artifact_reads_required"] is False
        assert "raw artifact reads are last-resort diagnostics" in context["source_contract"]["raw_artifact_read_policy"]
        assert "source-file scope is unspecified" in " ".join(context["source_contract"]["caveats"])

    def test_hej_realisera_execution_context_reports_incomplete_modes_and_fallbacks(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Blocked execution", "status": "active"},
            "tasks": [{"number": 1, "name": "Blocked", "status": "pending", "depends_on": [99]}],
        })

        r = _run("prime", "--context", "realisera", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        context = _prime_bespoke_context(json.loads(r.stdout), "execution_context")
        assert context["mode"] == "blocked_or_dependency_unready"
        assert context["source_contract"]["complete_for_execution_context"] is False
        assert set(context["source_contract"]["missing_required_execution_state"]) >= {
            "work_selection",
            "acceptance_criteria",
            "artifact_update_requirements",
            "changelog_boundary",
        }
        assert context["fallback_commands"][:5] == [
            "agentera query changelog --format json",
            "agentera decisions --format json",
            "agentera plan --format json",
            "agentera progress --format json",
            "agentera health --format json",
        ]
        assert "agentera realisera" not in json.dumps(context)
        assert "agentera build" not in json.dumps(context)

    def test_sparse_hej_realisera_execution_context_field_selection_uses_supported_seam(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Sparse execution", "status": "active"},
            "tasks": [{"number": 1, "name": "Ready", "status": "pending", "acceptance": ["selected"]}],
        })
        (project / "CHANGELOG.md").write_text("# Changelog\n\n## [Unreleased]\n", encoding="utf-8")
        contract = yaml.safe_load(CONTRACT_PATH.read_text(encoding="utf-8"))
        available = contract["field_selection"]["fields_by_command"]["hej"]["fields"]

        r = _run(
            "prime",
            "--context",
            "realisera",
            "--format",
            "json",
            "--fields",
            "execution_context",
            cwd=project,
        )

        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        assert list(data) == ["command", "status", "execution_context"]
        assert set(data).issubset(set(available) | {"command", "status"})
        assert _prime_bespoke_context(data, "execution_context")["source_contract"]["raw_artifact_reads_required"] is False

    def test_realisera_capability_command_emits_routing_guidance(self, project):
        realisera = _run("realisera", cwd=project)
        build = _run("build", cwd=project)

        assert realisera.returncode == 0
        assert "startup context: agentera prime --context realisera --format json" in realisera.stdout
        assert build.returncode == 2
        assert "invalid choice" in build.stderr

    def test_inspektera_capability_command_emits_routing_guidance(self, project):
        r = _run("inspektera", cwd=project)

        assert r.returncode == 0
        assert "startup context: agentera prime --context inspektera --format json" in r.stdout

    def test_fresh_hej_structured_output_explains_absent_state(self, project):
        r = _run("hej", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["mode"] == "fresh"
        assert data["plan"]["status"] == "absent"
        assert data["docs"]["status"] == "absent"
        assert data["progress"]["status"] == "absent"
        assert data["state_presence"]["any_active"] is False
        assert data["state_presence"]["absence"] == {
            "plan": "No active plan artifact is available from agentera plan.",
            "docs": "No docs mapping artifact is available from agentera docs.",
            "progress": "No progress cycles are available from agentera progress.",
        }

    def test_completed_plan_routes_to_open_todo_before_vision(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Done plan", "status": "complete"},
            "tasks": [
                {"number": 1, "name": "Finished", "status": "complete"},
            ],
        })
        _write_artifact(project, "TODO.md", {
            "entries": [
                {"severity": "normal", "status": "open", "description": "Add smoke coverage"},
            ],
        })

        r = _run("hej", cwd=project)

        assert r.returncode == 0
        assert "object=TODO: Add smoke coverage" in r.stdout
        assert "capability=realisera" in r.stdout
        assert "plan: status=complete" not in r.stdout
        assert "capability=visionera" not in r.stdout

    def test_complex_todo_routes_to_planera_before_realisera(self, project):
        _write_artifact(project, "TODO.md", {
            "entries": [
                {
                    "severity": "normal",
                    "status": "open",
                    "description": "Add first_invocation_read capability metadata and surface required instruction reads through agentera prime --context <name> --format json so agents can discover startup read obligations without raw directory guessing.",
                },
            ],
        })

        r = _run("hej", "--format", "json", cwd=project)

        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        assert data["next_action"]["capability"] == "planera"
        assert data["next_action"]["reason"] == "complex TODO needs planning"

    def test_completed_plan_without_open_work_does_not_surface_stale_plan(self, project):
        _write_artifact(project, ".agentera/vision.yaml", {
            "principles": [{"name": "Reliable state", "description": "Keep routing current."}],
        })
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Done plan", "status": "complete"},
            "tasks": [
                {"number": 1, "name": "Finished", "status": "complete"},
            ],
        })

        r = _run("hej", cwd=project)

        assert r.returncode == 0
        assert "plan: status=complete" not in r.stdout
        assert "object=VISION refresh" in r.stdout
        assert "capability=planera" in r.stdout
        assert "capability=visionera" not in r.stdout

    def test_incomplete_or_blocked_plan_remains_visible_to_hej(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Blocked plan", "status": "complete"},
            "tasks": [
                {"number": 1, "name": "Finished", "status": "complete"},
                {"number": 2, "name": "Blocked", "status": "blocked"},
            ],
        })

        r = _run("hej", cwd=project)

        assert r.returncode == 0
        assert "plan: status=complete | progress=1/2" in r.stdout
        assert "object=VISION refresh" in r.stdout
        assert "capability=planera" in r.stdout

    def test_closed_objective_is_not_selected_for_routing(self, project):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Done plan", "status": "complete"},
            "tasks": [
                {"number": 1, "name": "Finished", "status": "complete"},
            ],
        })
        _write_artifact(project, ".agentera/optimera/done/objective.yaml", {
            "header": {"title": "Done objective", "status": "closed"},
            "objective": {"measurement": "tokens", "target": "20% reduction"},
        })

        r = _run("hej", cwd=project)

        assert r.returncode == 0
        assert "objective: none active" in r.stdout
        assert "capability=optimera" not in r.stdout

    def test_v1_markdown_without_yaml_reports_upgrade_preview(self, project):
        legacy = project / ".agentera" / "PLAN.md"
        legacy.parent.mkdir(parents=True)
        legacy.write_text("# Plan\n")

        r = _run("hej", cwd=project)

        assert r.returncode == 0
        assert "v1 artifacts detected" in r.stdout
        assert 'uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --dry-run' in r.stdout
        assert ".agentera/PLAN.md" in r.stdout

    def test_v1_migration_structured_output_has_safe_commands(self, project):
        legacy = project / ".agentera" / "PLAN.md"
        legacy.parent.mkdir(parents=True)
        legacy.write_text("# Plan\n")

        r = _run("hej", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        migration = data["v1_migration"]
        assert migration["detected"] is True
        assert migration["affected_files"] == [".agentera/PLAN.md"]
        assert migration["dry_run_command"] == (
            'uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --dry-run'
        )
        assert migration["apply_command"] == (
            'uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --yes'
        )
        assert migration["requires_confirmation"] is True

    def _write_profile(self, project: Path, date_str: str) -> Path:
        profile_dir = project / ".xdg" / "agentera"
        profile_dir.mkdir(parents=True, exist_ok=True)
        profile = profile_dir / "PROFILE.md"
        profile.write_text(f"# Profile\n<!-- Generated: {date_str} -->\n")
        return profile

    def _profile_date(self, days_ago: int) -> str:
        return (date.today() - timedelta(days=days_ago)).isoformat()

    def test_stale_profile_shows_attention(self, project):
        self._write_profile(project, self._profile_date(days_ago=30))
        r = _run("hej", cwd=project)
        assert r.returncode == 0
        assert "profile: loaded" in r.stdout
        assert "profilera profile stale" in r.stdout
        assert "suggest running profilera" in r.stdout

    def test_stale_profile_in_structured_output(self, project):
        self._write_profile(project, self._profile_date(days_ago=30))
        r = _run("hej", "--format", "json", cwd=project)
        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["profile"]["status"] == "loaded"
        assert data["profile"]["stale"] is True
        assert data["profile"]["days_since_generated"] > 0
        assert data["profile"]["stale_threshold_days"] == 7
        assert "Run profilera" in data["profile"]["suggested_action"]

    def test_fresh_profile_no_stale_attention(self, project):
        self._write_profile(project, self._profile_date(days_ago=0))
        r = _run("hej", cwd=project)
        assert r.returncode == 0
        assert "profile: loaded" in r.stdout
        assert "profilera profile stale" not in r.stdout

    def test_fresh_profile_structured_output_shows_stale_false(self, project):
        self._write_profile(project, self._profile_date(days_ago=0))
        r = _run("hej", "--format", "json", cwd=project)
        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["profile"]["stale"] is False
        assert data["profile"]["days_since_generated"] <= 1

    def test_profile_missing_no_stale_output(self, project):
        r = _run("hej", cwd=project)
        assert r.returncode == 0
        assert "PROFILE.md not found" in r.stdout
        assert "suggest running profilera to generate PROFILE.md" in r.stdout

    def test_missing_profile_structured_output_has_suggested_action(self, project):
        r = _run("hej", "--format", "json", cwd=project)
        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["profile"]["status"] == "not found"
        assert data["profile"]["suggested_action"] == "Run profilera to generate PROFILE.md"

    def test_env_var_overrides_stale_threshold(self, project):
        self._write_profile(project, self._profile_date(days_ago=7))
        env = {
            **os.environ,
            "AGENTERA_HOME": str(REPO_ROOT),
            "XDG_DATA_HOME": str(project / ".xdg"),
            "PROFILERA_PROFILE_DIR": str(project / ".xdg" / "agentera"),
            "AGENTERA_PROFILERA_MAX_AGE_DAYS": "14",
        }
        r = subprocess.run(
            [sys.executable, CLI, "hej", "--format", "json"],
            capture_output=True, text=True, cwd=project, env=env,
        )
        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["profile"]["stale"] is False, f"Expected not stale with 14 day threshold, got {data}"
        assert data["profile"]["stale_threshold_days"] == 14

    def test_env_var_lower_threshold_triggers_stale(self, project):
        self._write_profile(project, self._profile_date(days_ago=1))
        env = {
            **os.environ,
            "AGENTERA_HOME": str(REPO_ROOT),
            "XDG_DATA_HOME": str(project / ".xdg"),
            "PROFILERA_PROFILE_DIR": str(project / ".xdg" / "agentera"),
            "AGENTERA_PROFILERA_MAX_AGE_DAYS": "1",
        }
        r = subprocess.run(
            [sys.executable, CLI, "hej", "--format", "json"],
            capture_output=True, text=True, cwd=project, env=env,
        )
        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["profile"]["stale"] is True, f"Expected stale with 1 day threshold, got {data}"
        assert "profilera profile stale" in r.stdout if r.stdout else ""

    def test_invalid_env_var_threshold_uses_default(self, project):
        self._write_profile(project, self._profile_date(days_ago=30))
        env = {
            **os.environ,
            "AGENTERA_HOME": str(REPO_ROOT),
            "XDG_DATA_HOME": str(project / ".xdg"),
            "PROFILERA_PROFILE_DIR": str(project / ".xdg" / "agentera"),
            "AGENTERA_PROFILERA_MAX_AGE_DAYS": "not-a-number",
        }
        r = subprocess.run(
            [sys.executable, CLI, "hej", "--format", "json"],
            capture_output=True, text=True, cwd=project, env=env,
        )
        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["profile"]["stale"] is True
        assert data["profile"]["stale_threshold_days"] == 7

    def test_stale_profile_generates_suggested_action(self, project):
        self._write_profile(project, self._profile_date(days_ago=30))
        r = _run("hej", "--format", "json", cwd=project)
        assert r.returncode == 0
        data = json.loads(r.stdout)
        attentions = data.get("attention", [])
        stale_attentions = [a for a in attentions if "profilera" in a]
        assert len(stale_attentions) > 0
        assert any("stale" in a for a in stale_attentions)
        assert any("suggest running profilera" in a for a in stale_attentions)

    def _write_health_audit(
        self,
        project: Path,
        number: int,
        audit_date: str,
        *,
        trajectory: str = "stable",
    ) -> None:
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [{
                "number": number,
                "date": audit_date,
                "trajectory": trajectory,
                "grades": {"Architecture": "B"},
            }],
        })

    def _write_progress_cycles(self, project: Path, timestamps: list[str]) -> None:
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [
                {
                    "number": index + 1,
                    "timestamp": timestamp,
                    "type": "build",
                    "phase": "build",
                }
                for index, timestamp in enumerate(timestamps)
            ],
        })

    def test_hej_health_uses_highest_audit_when_list_ascending(self, project):
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [
                {
                    "number": 11,
                    "date": "2026-04-24",
                    "trajectory": "old",
                    "grades": {"Architecture": "D"},
                },
                {
                    "number": 20,
                    "date": "2026-05-05",
                    "trajectory": "current",
                    "grades": {"Architecture": "B"},
                },
            ],
        })
        r = _run("hej", "--format", "json", cwd=project)
        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["health"]["number"] == 20
        assert data["health"]["date"] == "2026-05-05"

    def test_stale_health_audit_time_axis_shows_attention(self, project):
        old_date = (date.today() - timedelta(days=35)).isoformat()
        self._write_health_audit(project, 5, old_date)
        r = _run("hej", cwd=project)
        assert r.returncode == 0
        assert "inspektera audit stale" in r.stdout
        assert "suggest running inspektera" in r.stdout

    def test_stale_health_audit_time_axis_structured_output(self, project):
        old_date = (date.today() - timedelta(days=35)).isoformat()
        self._write_health_audit(project, 5, old_date)
        r = _run("hej", "--format", "json", cwd=project)
        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["health"]["stale"] is True
        assert data["health"]["days_since_audit"] >= 35
        assert data["health"]["stale_threshold_days"] == 30
        assert data["health"]["triggering_axis"] == "time"
        assert "Run inspektera" in data["health"]["suggested_action"]

    def test_fresh_health_audit_no_stale_attention(self, project):
        self._write_health_audit(project, 5, date.today().isoformat())
        r = _run("hej", cwd=project)
        assert r.returncode == 0
        assert "inspektera audit stale" not in r.stdout

    def test_stale_health_audit_cycles_axis(self, project):
        audit_date = (date.today() - timedelta(days=1)).isoformat()
        self._write_health_audit(project, 8, audit_date)
        self._write_progress_cycles(
            project,
            [f"{date.today().isoformat()} {hour:02d}:00" for hour in range(11)],
        )
        r = _run("hej", "--format", "json", cwd=project)
        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["health"]["stale"] is True
        assert data["health"]["triggering_axis"] == "cycles"
        assert data["health"]["cycles_since_audit"] >= 10

    def test_env_var_overrides_inspektera_age_threshold(self, project):
        old_date = (date.today() - timedelta(days=15)).isoformat()
        self._write_health_audit(project, 5, old_date)
        env = {
            **os.environ,
            "AGENTERA_HOME": str(REPO_ROOT),
            "AGENTERA_INSPEKTERA_MAX_AGE_DAYS": "14",
        }
        r = subprocess.run(
            [sys.executable, CLI, "hej", "--format", "json"],
            capture_output=True, text=True, cwd=project, env=env,
        )
        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["health"]["stale"] is True
        assert data["health"]["stale_threshold_days"] == 14
        assert data["health"]["triggering_axis"] == "time"

    def test_invalid_inspektera_env_threshold_uses_default(self, project):
        old_date = (date.today() - timedelta(days=15)).isoformat()
        self._write_health_audit(project, 5, old_date)
        env = {
            **os.environ,
            "AGENTERA_HOME": str(REPO_ROOT),
            "AGENTERA_INSPEKTERA_MAX_AGE_DAYS": "not-a-number",
        }
        r = subprocess.run(
            [sys.executable, CLI, "hej", "--format", "json"],
            capture_output=True, text=True, cwd=project, env=env,
        )
        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["health"]["stale"] is False
        assert data["health"]["stale_threshold_days"] == 30

    def test_stale_audit_next_action_suggests_inspektera(self, project):
        old_date = (date.today() - timedelta(days=35)).isoformat()
        self._write_health_audit(project, 7, old_date)
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"status": "active", "title": "completed plan"},
            "tasks": [{"number": 1, "name": "done", "status": "complete"}],
        })
        r = _run("hej", "--format", "json", cwd=project)
        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["next_action"]["capability"] == "inspektera"
        assert "Audit 7" in data["next_action"]["object"]

    def test_prime_inspektera_health_state_matches_hej_audit_date(self, project):
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [
                {"number": 11, "date": "2026-04-24", "trajectory": "old", "grades": {"Architecture": "D"}},
                {"number": 20, "date": "2026-05-05", "trajectory": "current", "grades": {"Architecture": "B"}},
            ],
        })
        hej = json.loads(_run("hej", "--format", "json", cwd=project).stdout)
        prime = json.loads(_run("prime", "--context", "inspektera", "--format", "json", cwd=project).stdout)
        evidence = prime["capability_context"]["context"]["evidence_context"]["health_state"]
        assert hej["health"]["number"] == 20
        assert evidence["audit_number"] == 20
        assert evidence["date"] == "2026-05-05"


# ---------------------------------------------------------------------------
# help
# ---------------------------------------------------------------------------


class TestHelp:
    def test_help_lists_commands(self):
        r = _run("--help")
        assert r.returncode == 0
        assert "prime" in r.stdout
        assert "hej" not in r.stdout
        assert "state" in r.stdout
        assert "report" in r.stdout
        assert "check" in r.stdout
        assert "Agent commands:" in r.stdout

    def test_query_help_lists_filters(self):
        r = _run("query", "--help")
        assert r.returncode == 0
        assert "topic" in r.stdout
        assert "severity" in r.stdout
        assert "dimension" in r.stdout

    @pytest.mark.parametrize(
        "args,routine",
        [
            (["plan"], "plan"),
            (["progress"], "progress"),
            (["plan", "--format", "json"], "plan"),
        ],
    )
    def test_query_routine_commands_are_not_compatibility_forms(self, project, args, routine):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Mapped plan", "status": "active"},
            "tasks": [],
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 1, "phase": "build", "what": "test"}],
        })
        r = _run("query", *args, cwd=project)
        assert r.returncode == 1
        assert f"Use `agentera {routine}`" in r.stderr


# ---------------------------------------------------------------------------
# artifact type coverage (1 test per type + --list-artifacts)
# ---------------------------------------------------------------------------

STATE_COMMAND_NAMES = {
    "decisions",
    "docs",
    "experiments",
    "health",
    "objective",
    "plan",
    "progress",
    "todo",
}


ARTIFACT_FIXTURES = {
    "changelog": {
        "path": "CHANGELOG.md",
        "data": {
            "entries": [
                {"version": "2.0.0", "date": "2026-05-04", "changes": ["Release v2.0.0"]},
            ],
        },
        "expected": "version=2.0.0",
    },
    "decisions": {
        "path": ".agentera/decisions.yaml",
        "data": {
            "decisions": [
                {"number": 1, "question": "Language?", "choice": "Python", "confidence": "firm"},
            ],
        },
        "expected": "number=1",
    },
    "design": {
        "path": "DESIGN.md",
        "data": {
            "entries": [
                {"category": "palette", "name": "primary", "value": "#111827"},
            ],
        },
        "expected": "category=palette",
    },
    "docs": {
        "path": ".agentera/docs.yaml",
        "data": {
            "entries": [
                {"last_audit": "2026-05-01", "status": "current"},
            ],
        },
        "expected": "status=current",
    },
    "experiments": {
        "path": ".agentera/optimera/<name>/experiments.yaml",
        "data": {
            "experiments": [
                {"number": 1, "label": "exp1", "status": "kept"},
            ],
        },
        "expected": "number=1",
    },
    "health": {
        "path": ".agentera/health.yaml",
        "data": {
            "audits": [
                {"number": 1, "date": "2026-05-01", "trajectory": "stable"},
            ],
        },
        "expected": "stable",
    },
    "objective": {
        "path": ".agentera/optimera/<name>/objective.yaml",
        "data": {
            "entries": [
                {"title": "Test objective", "status": "active"},
            ],
        },
        "expected": "title=Test objective",
    },
    "plan": {
        "path": ".agentera/plan.yaml",
        "data": {
            "entries": [
                {"status": "active", "title": "Test plan"},
            ],
        },
        "expected": "status=active",
    },
    "progress": {
        "path": ".agentera/progress.yaml",
        "data": {
            "cycles": [
                {"number": 1, "phase": "build", "what": "test"},
            ],
        },
        "expected": "phase=build",
    },
    "todo": {
        "path": "TODO.md",
        "data": {
            "entries": [
                {"severity": "critical", "description": "Fix bug", "status": "open"},
            ],
        },
        "expected": "severity=critical",
    },
    "vision": {
        "path": ".agentera/vision.yaml",
        "data": {
            "entries": [
                {"project_name": "test-project"},
            ],
        },
        "expected": "project_name=test-project",
    },
}


class TestArtifactTypeCoverage:
    @pytest.mark.parametrize(
        "artifact_name,fixture",
        [(k, v) for k, v in ARTIFACT_FIXTURES.items() if k not in STATE_COMMAND_NAMES],
        ids=[k for k in ARTIFACT_FIXTURES if k not in STATE_COMMAND_NAMES],
    )
    def test_query_by_name_returns_data(self, project, artifact_name, fixture):
        _write_fixture_artifact(project, fixture)
        r = _run("query", artifact_name, cwd=project)
        assert r.returncode == 0
        assert fixture["expected"] in r.stdout

    @pytest.mark.parametrize(
        "artifact_name,fixture",
        [(k, v) for k, v in ARTIFACT_FIXTURES.items() if k in STATE_COMMAND_NAMES],
        ids=[k for k in ARTIFACT_FIXTURES if k in STATE_COMMAND_NAMES],
    )
    def test_state_command_by_name_returns_data(self, project, artifact_name, fixture):
        _write_fixture_artifact(project, fixture)
        r = _run(artifact_name, cwd=project)
        assert r.returncode == 0
        assert fixture["expected"] in r.stdout

    def test_query_no_data_returns_clean(self, project):
        r = _run("plan", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""

    def test_list_artifacts(self, project):
        r = _run("query", "--list-artifacts", cwd=project)
        assert r.returncode == 0
        for name in ARTIFACT_FIXTURES:
            assert name in r.stdout

    def test_list_artifacts_json_format(self, project):
        r = _run("query", "--list-artifacts", "--format", "json", cwd=project)
        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["schemaVersion"] == "agentera.query.list_artifacts.v2"
        assert "session" not in data["names"]
        assert "plan" in data["names"]
        artifacts = {entry["name"]: entry for entry in data["artifacts"]}
        assert artifacts["plan"]["normal_read_command"] == "agentera plan --format json"
        assert artifacts["plan"]["path"]["mapped_path"] == ".agentera/plan.yaml"
        assert artifacts["plan"]["path"]["exists"] is False
        assert "artifact writes" in artifacts["plan"]["raw_access_boundary"]["allowed_raw_artifact_uses"]
        assert data["source_contract"]["raw_artifact_reads_required_for_discovery"] is False

    def test_list_artifacts_json_reports_docs_yaml_mapped_paths(self, project):
        _write_artifact(project, ".agentera/docs.yaml", {
            "mapping": [{"artifact": "PLAN.md", "path": "docs/state/plan.yaml"}],
        })
        _write_artifact(project, "docs/state/plan.yaml", {"header": {"status": "active"}, "tasks": []})

        r = _run("query", "--list-artifacts", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        artifacts = {entry["name"]: entry for entry in data["artifacts"]}
        plan = artifacts["plan"]
        assert plan["path"]["default_path"] == ".agentera/plan.yaml"
        assert plan["path"]["mapped_path"] == "docs/state/plan.yaml"
        assert plan["path"]["display_path"] == "docs/state/plan.yaml"
        assert plan["path"]["resolution_source"] == ".agentera/docs.yaml mapping"
        assert plan["path"]["exists"] is True
        assert plan["normal_read_command"] == "agentera plan --format json"


ROUTINE_STRUCTURED_COMMANDS = [
    "prime",
    "plan",
    "progress",
    "health",
    "todo",
    "decisions",
    "docs",
    "objective",
    "experiments",
]


class TestRoutineStructuredOutput:
    def _seed(self, project: Path, command: str) -> None:
        if command == "prime":
            return
        fixture = ARTIFACT_FIXTURES[command]
        _write_fixture_artifact(project, fixture)

    @pytest.mark.parametrize("command", ROUTINE_STRUCTURED_COMMANDS)
    def test_json_output_has_agent_ready_envelope(self, project, command):
        self._seed(project, command)

        r = _run(command, "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["command"] == command
        assert data["status"] in {"ok", "empty"}
        assert "source" in data
        if command == "prime":
            assert "next_action" in data
            assert "bundle" in data
            assert "v1_migration" in data
            assert "source_contract" in data
            assert data["source_contract"]["access"] == (
                "single installed CLI call; app/v1/profile safety included; no preflight glob/read/import/doctor calls during normal prime"
            )
            startup = data["source_contract"]["capability_startup"]
            assert startup["complete_for_capability_startup"] is True
            assert startup["raw_artifact_reads_required"] is False
            assert startup["missing_state"] == []
            assert startup["confidence_caveats"]
            assert startup["cli_fallback"] == [
                "agentera plan --format json",
                "agentera docs --format json",
                "agentera progress --format json",
            ]
            assert "capability_context" in data["source_contract"]
        else:
            assert isinstance(data["entries"], list)
            assert isinstance(data["counts"]["entries"], int)
            assert "exists" in data["source"]
            assert "path" in data["source"]

    @pytest.mark.parametrize("command", ROUTINE_STRUCTURED_COMMANDS)
    def test_yaml_output_is_parseable(self, project, command):
        self._seed(project, command)

        r = _run(command, "--format", "yaml", cwd=project)

        assert r.returncode == 0
        data = yaml.safe_load(r.stdout)
        assert data["command"] == command
        assert data["status"] in {"ok", "empty"}

    def test_json_output_serializes_yaml_date_scalars(self, project):
        progress = project / ".agentera" / "progress.yaml"
        progress.parent.mkdir(parents=True, exist_ok=True)
        progress.write_text(
            "cycles:\n"
            "- number: 1\n"
            "  timestamp: 2026-05-09\n"
            "  type: fix\n"
            "  phase: build\n"
            "  what: Date scalar regression\n"
            "  commit: pending\n",
            encoding="utf-8",
        )

        r = _run("progress", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["entries"][0]["timestamp"] == "2026-05-09"

    @pytest.mark.parametrize("command", [c for c in ROUTINE_STRUCTURED_COMMANDS if c != "prime"])
    def test_empty_json_state_is_explicit(self, project, command):
        r = _run(command, "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["command"] == command
        assert data["status"] == "empty"
        assert data["entries"] == []
        assert data["counts"]["entries"] == 0
        assert data["source"]["exists"] is False

    def test_sparse_routine_output_uses_contract_fields_with_context(self, project):
        self._seed(project, "plan")
        contract = yaml.safe_load(CONTRACT_PATH.read_text(encoding="utf-8"))
        available = contract["field_selection"]["fields_by_command"]["routine_state_commands"]["fields"]

        r = _run("plan", "--format", "json", "--fields", "summary,entries", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert list(data) == ["command", "status", "summary", "entries"]
        assert set(data).issubset(set(available))
        assert data["command"] == "plan"
        assert data["status"] == "ok"

    @pytest.mark.parametrize("command", ROUTINE_STRUCTURED_COMMANDS)
    def test_sparse_status_field_is_supported_for_every_routine_command(self, project, command):
        self._seed(project, command)

        r = _run(command, "--format", "json", "--fields", "status", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert list(data) == ["command", "status"]
        assert data["command"] == command
        assert data["status"] in {"ok", "empty"}

    def test_sparse_hej_output_uses_hej_contract_fields_with_context(self, project):
        contract = yaml.safe_load(CONTRACT_PATH.read_text(encoding="utf-8"))
        available = contract["field_selection"]["fields_by_command"]["hej"]["fields"]

        r = _run("hej", "--format", "yaml", "--fields", "mode,next_action", cwd=project)

        assert r.returncode == 0
        assert "Deprecation: agentera hej is deprecated; use agentera prime" in r.stderr
        data = yaml.safe_load(r.stdout)
        assert list(data) == ["command", "status", "mode", "next_action"]
        assert set(data).issubset(set(available))
        assert data["command"] == "prime"
        assert data["status"] == "ok"

    def test_sparse_hej_evidence_context_field_selection_uses_supported_seam(self, project):
        _seed_inspektera_evidence_context(project)
        contract = yaml.safe_load(CONTRACT_PATH.read_text(encoding="utf-8"))
        available = contract["field_selection"]["fields_by_command"]["hej"]["fields"]

        r = _run(
            "prime",
            "--context",
            "inspektera",
            "--format",
            "json",
            "--fields",
            "evidence_context",
            cwd=project,
        )

        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        assert list(data) == ["command", "status", "evidence_context"]
        assert set(data).issubset(set(available) | {"command", "status"})
        assert _prime_bespoke_context(data, "evidence_context")["source_contract"]["complete_for_evidence_context"] is True
        assert "agentera inspektera" not in r.stdout

    def test_sparse_hej_rejects_unsupported_evidence_context_field_without_partial_stdout(self, project):
        _seed_inspektera_evidence_context(project)
        contract = yaml.safe_load(CONTRACT_PATH.read_text(encoding="utf-8"))
        available = contract["field_selection"]["fields_by_command"]["hej"]["fields"]

        r = _run(
            "prime",
            "--context",
            "inspektera",
            "--format",
            "json",
            "--fields",
            "evidence_context,raw_yaml",
            cwd=project,
        )

        assert r.returncode == 1
        assert r.stdout == ""
        assert "unsupported field 'raw_yaml'" in r.stderr
        assert "Available fields: " in r.stderr
        assert "evidence_context" in r.stderr
        assert "raw_yaml" not in available

    def test_sparse_output_rejects_unsupported_field_without_partial_stdout(self, project):
        self._seed(project, "plan")
        contract = yaml.safe_load(CONTRACT_PATH.read_text(encoding="utf-8"))
        available = contract["field_selection"]["fields_by_command"]["routine_state_commands"]["fields"]

        r = _run("plan", "--format", "json", "--fields", "summary,raw_yaml", cwd=project)

        assert r.returncode == 1
        assert r.stdout == ""
        assert "unsupported field 'raw_yaml'" in r.stderr
        assert "Available fields: " + ", ".join(available) in r.stderr

    def test_sparse_output_rejects_unsafe_field_without_partial_stdout(self, project):
        self._seed(project, "plan")

        r = _run("plan", "--format", "json", "--fields", "summary,raw/yaml", cwd=project)

        assert r.returncode == 2
        assert r.stdout == ""
        assert "unsupported field" in r.stderr

    def test_text_output_without_field_selection_remains_human_readable(self, project):
        self._seed(project, "plan")

        r = _run("plan", cwd=project)

        assert r.returncode == 0
        assert "status=active" in r.stdout
        assert not r.stdout.lstrip().startswith("{")


class TestInputHardening:
    def test_query_rejects_path_like_artifact_name_without_reading(self, project):
        r = _run("query", "../progress", cwd=project)

        assert r.returncode == 2
        assert r.stdout == ""
        assert "path-like values are not artifact names" in r.stderr

    def test_query_rejects_control_character_filter(self, project):
        _write_fixture_artifact(project, ARTIFACT_FIXTURES["decisions"])

        r = _run("decisions", "--topic", "runtime\nunsafe", cwd=project)

        assert r.returncode == 2
        assert r.stdout == ""
        assert "topic contains control characters" in r.stderr

    def test_docs_yaml_mapping_rejects_project_escape(self, project):
        _write_fixture_artifact(project, ARTIFACT_FIXTURES["plan"])
        _write_artifact(project, ".agentera/docs.yaml", {
            "mapping": [{"artifact": "PLAN.md", "path": "../outside.yaml"}],
        })

        r = _run("plan", "--format", "json", cwd=project)

        assert r.returncode == 2
        assert r.stdout == ""
        assert "path contains traversal segments" in r.stderr

    def test_doctor_rejects_traversal_install_root(self, project):
        r = _run("doctor", "--install-root", "../agentera", "--json", cwd=project)

        assert r.returncode == 2
        assert r.stdout == ""
        assert "unsafe path" in r.stderr

    def test_upgrade_dry_run_rejects_uri_project_before_writes(self, project):
        r = _run("upgrade", "--project", "file:///tmp/project", "--dry-run", "--json", cwd=project)

        assert r.returncode == 2
        assert r.stdout == ""
        assert "URI-style paths are not supported" in r.stderr


class TestDescribeIntrospection:
    def test_schema_json_exposes_runtime_interface_without_route_alias_commands(self, project):
        r = _run("schema", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["schemaVersion"] == "agentera.schema.v1"
        assert data["command"] == "schema"
        assert data["status"] == "ok"
        command_names = {entry["name"] for entry in data["commands"]}
        assert set(ROUTINE_STRUCTURED_COMMANDS).issubset(command_names)
        assert {"query", "schema", "doctor", "upgrade", "prime"}.issubset(command_names)
        assert "bundle-status" not in command_names
        assert "build" not in command_names
        assert "planera" in command_names
        assert "audit" not in command_names
        assert data["slash_route_aliases"]["aliases"]["build"] == "realisera"
        assert data["slash_route_aliases"]["aliases"]["plan"] == "planera"
        assert data["slash_route_aliases"]["cli_commands_added"] is True

    def test_describe_json_delegates_to_schema_with_deprecation(self, project):
        r = _run("describe", "--format", "json", cwd=project)

        assert r.returncode == 0
        assert "Deprecation: agentera describe is deprecated; use agentera schema" in r.stderr
        data = json.loads(r.stdout)
        assert data["schemaVersion"] == "agentera.schema.v1"
        assert data["command"] == "schema"
        assert data["status"] == "ok"

    def test_planera_capability_command_emits_routing_guidance(self, project):
        r = _run("planera", cwd=project)

        assert r.returncode == 0
        assert "startup context: agentera prime --context planera --format json" in r.stdout
        assert "not a routine state read" in r.stdout

    def test_schema_json_exposes_formats_fields_schemas_and_doctor_boundaries(self, project):
        r = _run("schema", "--format", "json", cwd=project)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["structured_output"]["formats"] == ["json", "yaml"]
        assert data["structured_output"]["fields_by_command"]["routine_state_commands"] == [
            "command",
            "status",
            "entries",
            "counts",
            "source",
            "filters",
            "summary",
            "source_contract",
        ]
        assert data["field_selection"]["syntax"] == "--fields FIELD[,FIELD...]"
        schemas = {entry["name"]: entry for entry in data["artifact_schemas"]}
        assert "plan" in schemas
        assert schemas["plan"]["status"] == "discovered"
        assert any(field["field"] == "status" and field["id"] == "PH3" for field in schemas["plan"]["fields"])
        assert schemas["plan"]["location"]["normal_read_command"] == "agentera plan --format json"
        assert schemas["plan"]["location"]["path"]["mapped_path"] == ".agentera/plan.yaml"
        locations = {entry["name"]: entry for entry in data["artifact_locations"]["artifacts"]}
        assert locations["plan"]["path"]["default_path"] == ".agentera/plan.yaml"
        assert locations["plan"]["path"]["project_boundary_check"] == "enforced"
        assert data["artifact_locations"]["source_contract"]["raw_artifact_reads_required_for_discovery"] is False
        assert data["doctor"]["command"] == "doctor"
        assert data["doctor"]["removed_command"] == "bundle-status"
        assert data["doctor"]["compatibility_alias"] == "forbidden"
        assert "project artifact health" in data["doctor"]["excludes"]
        assert "version_mismatch" in data["doctor"]["signal_kinds"]

    def test_schema_yaml_is_parseable(self, project):
        r = _run("schema", "--format", "yaml", cwd=project)

        assert r.returncode == 0
        data = yaml.safe_load(r.stdout)
        assert data["command"] == "schema"
        assert data["status"] == "ok"
        assert data["source"]["schemas_dir_exists"] is True

    def test_describe_yaml_delegates_to_schema(self, project):
        r = _run("describe", "--format", "yaml", cwd=project)

        assert r.returncode == 0
        assert "Deprecation: agentera describe is deprecated; use agentera schema" in r.stderr
        data = yaml.safe_load(r.stdout)
        assert data["command"] == "schema"
        assert data["status"] == "ok"
        assert data["source"]["schemas_dir_exists"] is True

    def test_schema_reports_missing_schema_discovery_explicitly(self, tmp_path):
        r = _run("schema", "--format", "json", cwd=tmp_path)

        assert r.returncode == 0
        data = json.loads(r.stdout)
        assert data["status"] == "incomplete"
        assert data["artifact_schemas"] == []
        assert data["artifact_locations"]["status"] == "missing_schemas"
        assert data["artifact_locations"]["artifacts"] == []
        assert data["source"]["app_model"]["appHome"] == str(tmp_path)
        assert data["source"]["app_model"]["skillRoot"] == str(tmp_path / "skills" / "agentera")
        assert any(
            gap["scope"] == "artifact_schemas"
            and gap["status"] == "missing"
            and "run `agentera doctor --format json`" in gap["message"]
            for gap in data["gaps"]
        )
