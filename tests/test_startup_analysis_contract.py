"""Tests for the corrected startup state-access metric."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACT_PATH = REPO_ROOT / "references" / "analysis" / "startup-measurement-contract.yaml"
DOCS_PATH = REPO_ROOT / ".agentera" / "docs.yaml"
BENCHMARK_DOC_PATH = REPO_ROOT / "docs" / "benchmark.md"


def _contract() -> dict:
    return yaml.safe_load(CONTRACT_PATH.read_text(encoding="utf-8"))


def _fixture_turn(source_id: str, timestamp: str, actor: str, content: str) -> dict:
    return {
        "source_id": source_id,
        "conversation_key": "fixture-conversation-a",
        "timestamp": timestamp,
        "source_kind": "conversation_turn",
        "runtime": "opencode",
        "project_id": "agentera",
        "data": {"actor": actor, "content": content},
    }


def _fixture_tool(source_id: str, timestamp: str, tool: str, arguments: dict) -> dict:
    return {
        "source_id": source_id,
        "conversation_key": "fixture-conversation-a",
        "timestamp": timestamp,
        "source_kind": "tool_call",
        "runtime": "opencode",
        "project_id": "agentera",
        "data": {"tool_name": tool, "arguments": arguments},
    }


def _plan_read_metrics(startup_analysis_contract, *, read_count: int = 1) -> dict:
    records = [
        _fixture_turn("turn", "2026-05-13T18:00:00Z", "user", "planera PRIVATE_PROMPT_TOKEN"),
        _fixture_tool("tool-cli", "2026-05-13T18:00:01Z", "bash", {"command": "uv run scripts/agentera plan"}),
    ]
    for index in range(read_count):
        records.append(
            _fixture_tool(
                f"tool-plan-{index}",
                f"2026-05-13T18:00:0{index + 2}Z",
                "read",
                {"filePath": "PRIVATE_ROOT_TOKEN/.agentera/plan.yaml"},
            )
        )
    records.append(_fixture_tool("tool-impl", "2026-05-13T18:00:09Z", "apply_patch", {"patchText": "x"}))
    intermediate = startup_analysis_contract.build_startup_intermediate(
        {
            "metadata": {
                "adapter_version": "agentera-v2-corpus-1",
                "runtime_statuses": [
                    {"runtime": "opencode", "status": "ok", "reason": "records_extracted", "record_count": len(records)}
                ],
            },
            "records": records,
        },
        salt="fixture-salt",
    )
    return startup_analysis_contract.aggregate_startup_metrics(intermediate)


def _write_codex_state_store(
    sessions_dir: Path,
    project_root: Path,
    *,
    session_name: str = "startup",
    session_token: str = "raw-session-id-token",
    started_at: str = "2026-05-13T10:00:00Z",
) -> None:
    session_path = sessions_dir / "2026" / "05" / "13" / f"{session_name}.jsonl"
    session_path.parent.mkdir(parents=True, exist_ok=True)
    base = started_at.replace("Z", "+00:00")
    timestamp = datetime.fromisoformat(base)

    def event_time(offset_seconds: int) -> str:
        return (timestamp + timedelta(seconds=offset_seconds)).isoformat().replace("+00:00", "Z")

    events = [
        {
            "type": "session_meta",
            "payload": {"id": session_token, "cwd": str(project_root)},
        },
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "planera PRIVATE_PROMPT_TOKEN"}],
                "timestamp": event_time(0),
            },
        },
        {
            "type": "function_call",
            "payload": {
                "type": "function_call",
                "name": "bash",
                "arguments": {"command": "uv run scripts/agentera plan --format json"},
                "timestamp": event_time(1),
            },
        },
        {
            "type": "function_call",
            "payload": {
                "type": "function_call",
                "name": "read",
                "arguments": {"filePath": str(project_root / ".agentera" / "plan.yaml")},
                "timestamp": event_time(2),
            },
        },
        {
            "type": "function_call",
            "payload": {
                "type": "function_call",
                "name": "apply_patch",
                "arguments": {"patchText": "*** Begin Patch\n*** End Patch"},
                "timestamp": event_time(3),
            },
        },
    ]
    session_path.write_text("\n".join(json.dumps(event) for event in events) + "\n", encoding="utf-8")


def _write_claude_code_schema_divergent_store(projects_dir: Path) -> None:
    session_path = projects_dir / "synthetic-project" / "session-redacted-claude.jsonl"
    session_path.parent.mkdir(parents=True, exist_ok=True)
    session_path.write_text(
        "{not valid json but synthetic only}\n",
        encoding="utf-8",
    )


def _write_supported_claude_code_store(
    projects_dir: Path,
    project_root: Path,
    *,
    include_malformed: bool = False,
    started_at: str = "2026-05-13T10:00:00Z",
) -> None:
    session_path = projects_dir / "synthetic-project" / "session-redacted-claude.jsonl"
    session_path.parent.mkdir(parents=True, exist_ok=True)
    base = started_at.replace("Z", "+00:00")
    timestamp = datetime.fromisoformat(base)

    def event_time(offset_seconds: int) -> str:
        return (timestamp + timedelta(seconds=offset_seconds)).isoformat().replace("+00:00", "Z")

    events = [
        {
            "type": "user",
            "sessionId": "session-redacted-claude",
            "cwd": str(project_root),
            "timestamp": event_time(0),
            "message": {"role": "user", "content": "plan orkestrera PRIVATE_CLAUDE_PROMPT_TOKEN"},
        },
        {
            "type": "assistant",
            "sessionId": "session-redacted-claude",
            "cwd": str(project_root),
            "timestamp": event_time(1),
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "name": "Bash",
                        "input": {"command": "uv run scripts/agentera plan --format json"},
                    }
                ],
            },
        },
        {
            "type": "assistant",
            "sessionId": "session-redacted-claude",
            "cwd": str(project_root),
            "timestamp": event_time(2),
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "name": "Read",
                        "input": {"file_path": str(project_root / ".agentera" / "plan.yaml")},
                    }
                ],
            },
        },
    ]
    lines = [json.dumps(event) for event in events]
    if include_malformed:
        lines.append("{malformed claude payload token}")
    session_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_copilot_schema_divergent_store(store_dir: Path) -> Path:
    store_dir.mkdir(parents=True, exist_ok=True)
    db_path = store_dir / "session-store.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at TEXT)")
        conn.execute("CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT, created_at TEXT)")
        conn.execute(
            "INSERT INTO sessions (id, created_at) VALUES (?, ?)",
            ("session-redacted-copilot", "2026-05-13T10:00:00Z"),
        )
        conn.execute(
            "INSERT INTO turns (id, session_id, created_at) VALUES (?, ?, ?)",
            ("turn-redacted-copilot", "session-redacted-copilot", "2026-05-13T10:00:01Z"),
        )
        conn.commit()
    finally:
        conn.close()
    return db_path


def _write_supported_copilot_store(
    store_dir: Path,
    project_root: Path,
    *,
    include_malformed: bool = False,
    started_at: str = "2026-05-13T10:00:00Z",
) -> Path:
    store_dir.mkdir(parents=True, exist_ok=True)
    db_path = store_dir / "session-store.db"
    base = started_at.replace("Z", "+00:00")
    timestamp = datetime.fromisoformat(base)

    def event_time(offset_seconds: int) -> str:
        return (timestamp + timedelta(seconds=offset_seconds)).isoformat().replace("+00:00", "Z")

    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                cwd TEXT,
                created_at TEXT
            );
            CREATE TABLE turns (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                role TEXT,
                turn_index INTEGER,
                content TEXT,
                data TEXT,
                created_at TEXT
            );
            """
        )
        conn.execute(
            "INSERT INTO sessions (id, cwd, created_at) VALUES (?, ?, ?)",
            ("session-redacted-copilot", str(project_root), event_time(0)),
        )
        rows = [
            (
                "turn-1",
                "session-redacted-copilot",
                "user",
                1,
                "plan orkestrera PRIVATE_COPILOT_PROMPT_TOKEN",
                None,
                event_time(0),
            ),
            (
                "turn-2",
                "session-redacted-copilot",
                "assistant",
                2,
                "I will inspect plan state.",
                json.dumps(
                    {
                        "type": "tool_use",
                        "name": "bash",
                        "input": {"command": "uv run scripts/agentera plan --format json"},
                    }
                ),
                event_time(1),
            ),
            (
                "turn-3",
                "session-redacted-copilot",
                "assistant",
                3,
                "I will inspect the raw plan artifact.",
                json.dumps(
                    {
                        "tool_calls": [
                            {
                                "type": "tool_call",
                                "tool_name": "read",
                                "arguments": {"filePath": str(project_root / ".agentera" / "plan.yaml")},
                            }
                        ]
                    }
                ),
                event_time(2),
            ),
        ]
        if include_malformed:
            rows.append(
                (
                    "turn-4",
                    "session-redacted-copilot",
                    "assistant",
                    4,
                    "Malformed tool payload is ignored safely.",
                    "{malformed copilot tool payload token",
                    event_time(3),
                )
            )
        conn.executemany(
            """
            INSERT INTO turns (id, session_id, role, turn_index, content, data, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        conn.commit()
    finally:
        conn.close()
    return db_path


def test_contract_defines_state_access_metric_and_report_shape():
    contract = _contract()

    assert contract["version"] == "startup-state-analysis-v1"
    assert contract["boundary"] == {
        "source": "git tag evidence",
        "tag": "v2.3.0",
        "commit": "b18e3dc7d768d4ad2726880916e7cfe6bd8617d3",
        "committed_at": "2026-05-12T17:50:13+02:00",
        "rule": "include records with timestamps strictly after committed_at",
    }
    assert contract["state_gathering_sequence"]["start_anchor"] == (
        "first_agentera_cli_state_call_after_capability_related_user_turn"
    )
    assert "bare capability name such as planera, resonera, or orkestrera" in contract[
        "state_gathering_sequence"
    ]["capability_invocation_markers"]
    assert {item["class"] for item in contract["counted_event_classes"]} == {
        "cli_state_call",
        "raw_artifact_access",
        "capability_prose_read",
        "implementation_boundary",
        "non_state_context",
    }
    assert {
        "missing_timestamp",
        "runtime_store_locked",
        "no_agentera_state_sequence",
        "privacy_redaction_required",
    } <= set(contract["degradation_reasons"])
    assert {
        "total_state_sequences",
        "state_sequences_with_raw_after_cli",
        "state_sequences_with_redundant_raw_access",
        "raw_artifact_access_after_cli_counts",
        "redundant_raw_artifact_access_counts",
        "per_capability_state_counts",
        "token_estimator_version",
        "estimated_raw_after_cli_tokens",
        "estimated_redundant_raw_tokens",
        "estimated_raw_after_cli_tokens_by_artifact",
        "estimated_redundant_raw_tokens_by_artifact",
    } <= set(contract["report_fields"]["required"])


def test_contract_defines_runtime_matrix_and_token_estimate_contract():
    contract = _contract()
    extraction = contract["runtime_extraction_contract"]
    outcomes = extraction["runtime_status_outcomes"]
    token_contract = contract["token_impact_contract"]

    assert extraction["supported_runtime_order"] == [
        "codex",
        "claude-code",
        "opencode",
        "github-copilot",
    ]
    assert outcomes["schema_divergent"]["status"] == "degraded"
    assert outcomes["schema_divergent"]["reason"] == "schema_divergent"
    assert "error_count greater than zero" in outcomes["schema_divergent"]["required_counts"]
    assert outcomes["no_matching_records"]["status"] == "sparse"
    assert outcomes["no_matching_records"]["reason"] == "no_matching_records"
    assert outcomes["successful_zero_record_window"]["status"] == "ok"
    assert outcomes["successful_zero_record_window"]["required_counts"] == [
        "record_count: 0",
        "error_count: 0",
    ]

    for runtime in extraction["supported_runtime_order"]:
        matrix = extraction["supported_runtimes"][runtime]
        assert matrix["accepted_input_schema_classes"]
        assert matrix["normalized_record_fields"]
        assert matrix["status_mapping"]
        assert matrix["redaction_rules"]

    assert token_contract["estimator_version"] == "approx_bytes_div_4_v1"
    assert "observed transcript or tool-argument content byte counts during analysis" in token_contract[
        "transient_inputs"
    ]
    assert {
        "token_estimator_version",
        "estimated_raw_after_cli_tokens",
        "estimated_redundant_raw_tokens",
        "estimated_raw_after_cli_tokens_by_artifact",
        "estimated_redundant_raw_tokens_by_artifact",
        "estimated_tokens_saved_vs_previous",
        "estimated_tokens_saved_vs_previous_null_reason",
    } <= set(token_contract["aggregate_fields"]["latest_report"])
    assert "raw paths" in token_contract["retained_output_rule"]
    assert "transcript text" in token_contract["retained_output_rule"]
    assert "previous_missing_token_estimates" in token_contract["null_reasons"]


def test_contract_defines_manual_benchmark_storage_and_retention_boundary():
    contract = _contract()

    assert contract["benchmark_execution"]["rule"] == "manual_only"
    assert contract["benchmark_execution"]["normal_ci"] == "forbidden"
    assert contract["benchmark_execution"]["command_surface"] == "mage bench:startupState"
    assert "runtime labels and concrete filesystem paths" in contract["benchmark_execution"][
        "runtime_path_approval"
    ]
    assert "generic consent flag" in contract["benchmark_execution"]["runtime_path_approval"]
    assert "without environment variables" in contract["benchmark_execution"]["default_run"]
    assert "documented runtime-store defaults" in contract["benchmark_execution"]["default_run"]
    assert "previous successful" in contract["benchmark_execution"]["incremental_rule"]
    assert contract["benchmark_storage"]["default_directory"] == (
        "${AGENTERA_HOME}/benchmarks/startup-state/"
    )
    assert contract["benchmark_storage"]["durable_outputs"] == [
        "runs.jsonl",
        "latest-report.json",
        "latest-report.md",
    ]
    assert "per-run detailed reports" in contract["benchmark_storage"]["retention_rule"]
    assert contract["aggregate_history"]["file"] == "runs.jsonl"
    assert {
        "raw_transcripts",
        "raw_corpus_files",
        "raw_intermediates",
        "raw_store_paths",
        "raw_session_ids",
        "private_salts",
        "generated_salted_hashes",
    } <= set(contract["aggregate_history"]["forbidden_retained_fields"])


def test_privacy_redaction_removes_transcripts_paths_and_session_ids(startup_analysis_contract):
    contract = startup_analysis_contract.load_contract(CONTRACT_PATH)
    raw = {
        "content": "TRANSCRIPT_INPUT_TOKEN",
        "session_id": "SESSION_INPUT_TOKEN",
        "project_path": "PROJECT_PATH_INPUT_TOKEN",
        "store_path": "STORE_PATH_INPUT_TOKEN",
        "artifact_path": {"path": "PLAN_ARTIFACT_TOKEN/.agentera/plan.yaml"},
        "events": [{"text": "SECOND_TRANSCRIPT_INPUT_TOKEN", "file_path": "TODO_ARTIFACT_TOKEN/TODO.md"}],
    }

    redacted = startup_analysis_contract.redact_for_startup_output(
        raw,
        salt="unit-test-salt",
        contract=contract,
    )
    rendered = json.dumps(redacted, sort_keys=True)

    assert "TRANSCRIPT_INPUT_TOKEN" not in rendered
    assert "SECOND_TRANSCRIPT_INPUT_TOKEN" not in rendered
    assert "SESSION_INPUT_TOKEN" not in rendered
    assert "PROJECT_PATH_INPUT_TOKEN" not in rendered
    assert "STORE_PATH_INPUT_TOKEN" not in rendered
    assert redacted["content"] == "<redacted:transcript_text>"
    assert redacted["session_id"].startswith("session:")
    assert redacted["project_path"].startswith("path:")
    assert redacted["store_path"].startswith("path:")
    assert redacted["artifact_path"]["path"] == "PLAN.md"
    assert redacted["events"][0]["file_path"] == "TODO.md"


def test_section_22_extension_is_versioned_and_existing_surfaces_are_named():
    contract = _contract()
    compatibility = contract["section_22_compatibility"]

    assert compatibility["consumes_adapter_version"] == "agentera-v2-corpus-1"
    assert compatibility["base_envelope_changes"] == "none"
    assert compatibility["output_envelope"] == "startup_state_analysis_v1"
    assert "analysis_extensions.startup_state_v1" in compatibility["extension_rule"]
    assert {"conversation_turn", "tool_call"} <= set(compatibility["required_record_families"])

    docs = yaml.safe_load(DOCS_PATH.read_text(encoding="utf-8"))
    indexed_paths = {item["path"] for item in docs["index"]}
    assert "references/analysis/startup-measurement-contract.yaml" in indexed_paths


def test_classifier_uses_bare_capability_invocation_and_counts_raw_after_cli(startup_analysis_contract):
    corpus = {
        "records": [
            _fixture_turn("turn-user", "2026-05-13T08:00:00Z", "user", "run orkestrera to finish the plan"),
            _fixture_tool(
                "tool-prose-before-cli",
                "2026-05-13T08:00:01Z",
                "read",
                {"filePath": "skills/agentera/capabilities/orkestrera/prose.md"},
            ),
            _fixture_tool(
                "tool-cli-plan",
                "2026-05-13T08:00:02Z",
                "bash",
                {"command": "uv run scripts/agentera plan --format json"},
            ),
            _fixture_tool(
                "tool-raw-plan",
                "2026-05-13T08:00:03Z",
                "read",
                {"filePath": "<repo>/.agentera/plan.yaml"},
            ),
            _fixture_tool(
                "tool-raw-docs",
                "2026-05-13T08:00:04Z",
                "grep",
                {"path": "<repo>/.agentera/docs.yaml", "pattern": "last_audit"},
            ),
            _fixture_tool("tool-impl", "2026-05-13T08:00:05Z", "apply_patch", {"patchText": "x"}),
            _fixture_tool("tool-after", "2026-05-13T08:00:06Z", "read", {"filePath": "TODO.md"}),
        ]
    }

    result = startup_analysis_contract.classify_startup_records(corpus, salt="fixture-salt")

    assert result["degradations"] == []
    assert len(result["state_gathering_sequences"]) == 1
    sequence = result["state_gathering_sequences"][0]
    assert sequence["capability"] == "orkestrera"
    assert sequence["counts"] == {
        "capability_prose_read": 0,
        "cli_state_call": 1,
        "implementation_boundary": 1,
        "non_state_context": 0,
        "raw_artifact_access": 2,
    }
    assert sequence["cli_artifact_labels"] == ["PLAN.md"]
    assert sequence["raw_artifact_labels_after_cli"] == ["PLAN.md", "DOCS.md"]
    assert sequence["redundant_raw_artifact_labels"] == ["PLAN.md"]
    assert [event["event_class"] for event in sequence["events"]] == [
        "cli_state_call",
        "raw_artifact_access",
        "raw_artifact_access",
        "implementation_boundary",
    ]
    assert sequence["events"][1]["redundant_with_cli"] is True
    assert sequence["events"][2]["redundant_with_cli"] is False


def test_classifier_handles_bare_planera_and_multiple_cli_state_families(startup_analysis_contract):
    corpus = {
        "records": [
            _fixture_turn("turn-user", "2026-05-13T09:00:00Z", "user", "planera"),
            _fixture_tool(
                "tool-cli-plan",
                "2026-05-13T09:00:01Z",
                "bash",
                {"command": "uv run scripts/agentera plan --format json"},
            ),
            _fixture_tool(
                "tool-cli-docs",
                "2026-05-13T09:00:02Z",
                "bash",
                {"command": "uv run scripts/agentera docs --format json"},
            ),
            _fixture_tool(
                "tool-raw-docs",
                "2026-05-13T09:00:03Z",
                "read",
                {"filePath": "<repo>/.agentera/docs.yaml"},
            ),
            _fixture_tool(
                "tool-raw-plan",
                "2026-05-13T09:00:04Z",
                "read",
                {"filePath": "<repo>/.agentera/plan.yaml"},
            ),
        ]
    }

    result = startup_analysis_contract.classify_startup_records(corpus, salt="fixture-salt")
    sequence = result["state_gathering_sequences"][0]

    assert sequence["capability"] == "planera"
    assert sequence["cli_artifact_labels"] == ["DOCS.md", "PLAN.md"]
    assert sequence["raw_artifact_labels_after_cli"] == ["DOCS.md", "PLAN.md"]
    assert sequence["redundant_raw_artifact_labels"] == ["DOCS.md", "PLAN.md"]


def test_classifier_degrades_bounded_records_and_ignores_raw_before_cli(startup_analysis_contract):
    records = [
        _fixture_turn("turn-user", "2026-05-13T10:00:00Z", "user", "resonera"),
        _fixture_tool("raw-before-cli", "2026-05-13T10:00:01Z", "read", {"filePath": "TODO.md"}),
        {"source_id": "malformed-list", "timestamp": "2026-05-13T10:00:02Z"},
        {**_fixture_tool("missing-ts", "", "bash", {"command": "uv run pytest -q"})},
        {
            **_fixture_tool("privacy", "2026-05-13T10:00:03Z", "read", {"filePath": "TODO.md"}),
            "transcript": "TRANSCRIPT_FIELD_TOKEN",
        },
        _fixture_turn("pre-boundary", "2026-05-12T12:00:00Z", "user", "planera"),
    ]

    result = startup_analysis_contract.classify_startup_records(
        {"records": records + [object()]},
        salt="fixture-salt",
    )
    rendered = json.dumps(result, sort_keys=True)
    reasons = {item["reason"] for item in result["degradations"]}

    assert result["state_gathering_sequences"] == []
    assert {
        "malformed_record",
        "missing_timestamp",
        "no_agentera_state_sequence",
        "pre_boundary_record",
        "privacy_redaction_required",
    } <= reasons
    assert "TRANSCRIPT_FIELD_TOKEN" not in rendered
    assert "fixture-conversation-a" not in rendered


def test_state_intermediate_derives_signals_without_mutating_corpus_records(
    startup_analysis_contract,
    usage_stats,
):
    corpus = {
        "metadata": {
            "adapter_version": "agentera-v2-corpus-1",
            "runtime_statuses": [
                {
                    "runtime": "opencode",
                    "status": "ok",
                    "reason": "records_extracted",
                    "store_path": "RAW_STORE_PATH_TOKEN/opencode.db",
                    "record_count": 4,
                }
            ],
        },
        "records": [
            _fixture_turn("turn-user", "2026-05-13T10:00:00Z", "user", "planera"),
            _fixture_tool("tool-cli", "2026-05-13T10:00:01Z", "bash", {"command": "uv run scripts/agentera docs"}),
            _fixture_tool("tool-raw", "2026-05-13T10:00:02Z", "read", {"filePath": "PROJECT_ROOT_TOKEN/.agentera/docs.yaml"}),
            _fixture_tool("tool-impl", "2026-05-13T10:00:03Z", "bash", {"command": "uv run pytest -q"}),
        ],
    }
    original_records = json.loads(json.dumps(corpus["records"]))

    intermediate = startup_analysis_contract.build_startup_intermediate(corpus, salt="fixture-salt")
    rendered = json.dumps(intermediate, sort_keys=True)

    assert corpus["records"] == original_records
    assert usage_stats.analyze_corpus(corpus).invocations == []
    assert intermediate["output_envelope"] == "startup_state_analysis_v1"
    assert intermediate["corpus_adapter_version"] == "agentera-v2-corpus-1"
    assert intermediate["runtime_coverage"] == [
        {"runtime": "opencode", "status": "ok", "reason": "records_extracted", "record_count": 4}
    ]
    assert intermediate["total_records_read"] == 4
    assert intermediate["total_state_sequences"] == 1
    assert intermediate["artifact_label_counts"] == {"DOCS.md": 1}
    assert "DOCS.md" in rendered
    assert "RAW_STORE_PATH_TOKEN" not in rendered
    assert "PROJECT_ROOT_TOKEN" not in rendered
    assert "fixture-conversation-a" not in rendered


def test_runtime_store_extraction_derives_state_sequences_without_usage_stats_mutation(
    startup_analysis_contract,
    extract_corpus,
    usage_stats,
    tmp_path,
):
    project_root = tmp_path / "agentera"
    project_root.mkdir()
    codex_store = tmp_path / "codex" / "sessions"
    _write_codex_state_store(codex_store, project_root)
    corpus = extract_corpus.build_corpus(
        project_roots=[project_root],
        codex_sessions_dir=codex_store,
        claude_projects_dir=None,
        opencode_conversations_dir=None,
        copilot_conversations_dir=None,
    )
    original_records = json.loads(json.dumps(corpus["records"]))

    intermediate = startup_analysis_contract.extract_startup_intermediate_from_runtime_stores(
        project_roots=[project_root],
        codex_sessions_dir=codex_store,
        claude_projects_dir=None,
        opencode_conversations_dir=None,
        copilot_conversations_dir=None,
        salt="fixture-salt",
        extract_corpus_module=extract_corpus,
    )
    rendered = json.dumps(intermediate, sort_keys=True)

    assert corpus["records"] == original_records
    assert usage_stats.analyze_corpus(corpus).invocations == []
    assert intermediate["output_envelope"] == "startup_state_analysis_v1"
    assert intermediate["runtime_coverage"] == [
        {
            "runtime": "codex",
            "status": "ok",
            "reason": "records_extracted",
            "candidate_count": 1,
            "record_count": 4,
            "error_count": 0,
        },
        {"runtime": "claude-code", "status": "skipped", "reason": "disabled"},
        {"runtime": "opencode", "status": "skipped", "reason": "disabled"},
        {"runtime": "github-copilot", "status": "skipped", "reason": "disabled"},
    ]
    assert intermediate["runtime_record_counts"] == {"codex": 4}
    assert intermediate["total_records_read"] == 4
    assert intermediate["total_state_sequences"] == 1
    sequence = intermediate["state_gathering_sequences"][0]
    assert sequence["capability"] == "planera"
    assert sequence["redundant_raw_artifact_labels"] == ["PLAN.md"]
    assert "PLAN.md" in rendered
    assert "raw-session-id-token" not in rendered
    assert "PRIVATE_PROMPT_TOKEN" not in rendered
    assert str(project_root) not in rendered


def test_synthetic_schema_divergent_fixtures_emit_bounded_runtime_statuses(
    startup_analysis_contract,
    extract_corpus,
    tmp_path,
):
    project_root = tmp_path / "agentera"
    claude_store = tmp_path / "claude-projects"
    copilot_store = tmp_path / "copilot-store"
    project_root.mkdir()
    _write_claude_code_schema_divergent_store(claude_store)
    _write_copilot_schema_divergent_store(copilot_store)

    intermediate = startup_analysis_contract.extract_startup_intermediate_from_runtime_stores(
        project_roots=[project_root],
        codex_sessions_dir=None,
        claude_projects_dir=claude_store,
        opencode_conversations_dir=None,
        copilot_conversations_dir=copilot_store,
        salt="fixture-salt",
        extract_corpus_module=extract_corpus,
    )
    coverage = {item["runtime"]: item for item in intermediate["runtime_coverage"]}
    rendered = json.dumps(intermediate, sort_keys=True)

    assert coverage["claude-code"] == {
        "runtime": "claude-code",
        "status": "degraded",
        "reason": "schema_divergent",
        "candidate_count": 1,
        "record_count": 0,
        "error_count": 1,
    }
    assert coverage["github-copilot"] == {
        "runtime": "github-copilot",
        "status": "degraded",
        "reason": "schema_divergent",
        "candidate_count": 1,
        "record_count": 0,
        "error_count": 1,
    }
    assert coverage["codex"] == {"runtime": "codex", "status": "skipped", "reason": "disabled"}
    assert coverage["opencode"] == {"runtime": "opencode", "status": "skipped", "reason": "disabled"}
    assert intermediate["runtime_record_counts"] == {}
    assert str(claude_store) not in rendered
    assert str(copilot_store) not in rendered
    assert str(project_root) not in rendered
    assert "session-redacted-claude" not in rendered
    assert "session-redacted-copilot" not in rendered
    assert "turn-redacted-copilot" not in rendered
    assert "not valid json" not in rendered
    assert "missing copilot turn role column" not in rendered


def test_supported_claude_code_schema_extracts_startup_records(
    startup_analysis_contract,
    extract_corpus,
    tmp_path,
):
    project_root = tmp_path / "agentera"
    claude_store = tmp_path / "claude-projects"
    project_root.mkdir()
    _write_supported_claude_code_store(claude_store, project_root)

    corpus = extract_corpus.build_corpus(
        project_roots=[project_root],
        codex_sessions_dir=None,
        claude_projects_dir=claude_store,
        opencode_conversations_dir=None,
        copilot_conversations_dir=None,
    )
    claude_records = [item for item in corpus["records"] if item.get("runtime") == "claude-code"]
    intermediate = startup_analysis_contract.extract_startup_intermediate_from_runtime_stores(
        project_roots=[project_root],
        codex_sessions_dir=None,
        claude_projects_dir=claude_store,
        opencode_conversations_dir=None,
        copilot_conversations_dir=None,
        salt="fixture-salt",
        extract_corpus_module=extract_corpus,
    )
    coverage = {item["runtime"]: item for item in intermediate["runtime_coverage"]}
    rendered = json.dumps(intermediate, sort_keys=True)

    assert coverage["claude-code"] == {
        "runtime": "claude-code",
        "status": "ok",
        "reason": "records_extracted",
        "candidate_count": 1,
        "record_count": 4,
        "error_count": 0,
    }
    assert {item["source_kind"] for item in claude_records} == {"conversation_turn", "history_prompt", "tool_call"}
    assert all(item["conversation_key"] == "session-redacted-claude" for item in claude_records)
    assert all(item["runtime"] == "claude-code" for item in claude_records)
    assert all(item.get("timestamp") for item in claude_records)
    assert intermediate["runtime_record_counts"] == {"claude-code": 4}
    assert intermediate["total_state_sequences"] == 1
    sequence = intermediate["state_gathering_sequences"][0]
    assert sequence["capability"] == "orkestrera"
    assert sequence["counts"]["cli_state_call"] == 1
    assert sequence["raw_artifact_labels_after_cli"] == ["PLAN.md"]
    assert sequence["redundant_raw_artifact_labels"] == ["PLAN.md"]
    assert "PRIVATE_CLAUDE_PROMPT_TOKEN" not in rendered
    assert "session-redacted-claude" not in rendered
    assert str(claude_store) not in rendered
    assert str(project_root) not in rendered


def test_malformed_claude_code_items_are_bounded_without_raw_payloads(
    startup_analysis_contract,
    extract_corpus,
    tmp_path,
):
    project_root = tmp_path / "agentera"
    claude_store = tmp_path / "claude-projects"
    project_root.mkdir()
    _write_supported_claude_code_store(claude_store, project_root, include_malformed=True)

    intermediate = startup_analysis_contract.extract_startup_intermediate_from_runtime_stores(
        project_roots=[project_root],
        codex_sessions_dir=None,
        claude_projects_dir=claude_store,
        opencode_conversations_dir=None,
        copilot_conversations_dir=None,
        salt="fixture-salt",
        extract_corpus_module=extract_corpus,
    )
    coverage = {item["runtime"]: item for item in intermediate["runtime_coverage"]}
    rendered = json.dumps(intermediate, sort_keys=True)

    assert coverage["claude-code"] == {
        "runtime": "claude-code",
        "status": "degraded",
        "reason": "schema_divergent",
        "candidate_count": 1,
        "record_count": 4,
        "error_count": 1,
    }
    assert intermediate["runtime_record_counts"] == {"claude-code": 4}
    assert "malformed claude payload token" not in rendered
    assert "PRIVATE_CLAUDE_PROMPT_TOKEN" not in rendered
    assert str(claude_store) not in rendered


def test_successful_claude_code_zero_window_records_remains_ok(
    startup_analysis_contract,
    extract_corpus,
    tmp_path,
):
    project_root = tmp_path / "agentera"
    claude_store = tmp_path / "claude-projects"
    project_root.mkdir()
    _write_supported_claude_code_store(claude_store, project_root)

    intermediate = startup_analysis_contract.extract_startup_intermediate_from_runtime_stores(
        project_roots=[project_root],
        codex_sessions_dir=None,
        claude_projects_dir=claude_store,
        opencode_conversations_dir=None,
        copilot_conversations_dir=None,
        salt="fixture-salt",
        extract_corpus_module=extract_corpus,
        benchmark_mode="since_previous_benchmark",
        benchmark_previous_watermark_at=datetime.fromisoformat("2026-05-13T10:01:00+00:00"),
    )
    coverage = {item["runtime"]: item for item in intermediate["runtime_coverage"]}

    assert coverage["claude-code"] == {
        "runtime": "claude-code",
        "status": "ok",
        "reason": "records_extracted",
        "candidate_count": 1,
        "record_count": 0,
        "error_count": 0,
    }
    assert intermediate["runtime_record_counts"] == {}
    assert intermediate["total_records_read"] == 0
    assert intermediate["total_state_sequences"] == 0


def test_supported_copilot_schema_extracts_startup_records(
    startup_analysis_contract,
    extract_corpus,
    tmp_path,
):
    project_root = tmp_path / "agentera"
    copilot_store = tmp_path / "copilot-store"
    project_root.mkdir()
    _write_supported_copilot_store(copilot_store, project_root)

    corpus = extract_corpus.build_corpus(
        project_roots=[project_root],
        codex_sessions_dir=None,
        claude_projects_dir=None,
        opencode_conversations_dir=None,
        copilot_conversations_dir=copilot_store,
    )
    copilot_records = [item for item in corpus["records"] if item.get("runtime") == "github-copilot"]
    intermediate = startup_analysis_contract.extract_startup_intermediate_from_runtime_stores(
        project_roots=[project_root],
        codex_sessions_dir=None,
        claude_projects_dir=None,
        opencode_conversations_dir=None,
        copilot_conversations_dir=copilot_store,
        salt="fixture-salt",
        extract_corpus_module=extract_corpus,
    )
    coverage = {item["runtime"]: item for item in intermediate["runtime_coverage"]}
    rendered = json.dumps(intermediate, sort_keys=True)

    assert coverage["github-copilot"] == {
        "runtime": "github-copilot",
        "status": "ok",
        "reason": "records_extracted",
        "candidate_count": 1,
        "record_count": 6,
        "error_count": 0,
    }
    assert {item["source_kind"] for item in copilot_records} == {"conversation_turn", "history_prompt", "tool_call"}
    assert all(item["conversation_key"] == "session-redacted-copilot" for item in copilot_records)
    assert all(item["runtime"] == "github-copilot" for item in copilot_records)
    assert all(item.get("timestamp") for item in copilot_records)
    assert intermediate["runtime_record_counts"] == {"github-copilot": 6}
    assert intermediate["total_state_sequences"] == 1
    sequence = intermediate["state_gathering_sequences"][0]
    assert sequence["capability"] == "orkestrera"
    assert sequence["counts"]["cli_state_call"] == 1
    assert sequence["raw_artifact_labels_after_cli"] == ["PLAN.md"]
    assert sequence["redundant_raw_artifact_labels"] == ["PLAN.md"]
    assert "PRIVATE_COPILOT_PROMPT_TOKEN" not in rendered
    assert "session-redacted-copilot" not in rendered
    assert str(copilot_store) not in rendered
    assert str(project_root) not in rendered


def test_malformed_copilot_items_are_bounded_without_raw_payloads(
    startup_analysis_contract,
    extract_corpus,
    tmp_path,
):
    project_root = tmp_path / "agentera"
    copilot_store = tmp_path / "copilot-store"
    project_root.mkdir()
    _write_supported_copilot_store(copilot_store, project_root, include_malformed=True)

    intermediate = startup_analysis_contract.extract_startup_intermediate_from_runtime_stores(
        project_roots=[project_root],
        codex_sessions_dir=None,
        claude_projects_dir=None,
        opencode_conversations_dir=None,
        copilot_conversations_dir=copilot_store,
        salt="fixture-salt",
        extract_corpus_module=extract_corpus,
    )
    coverage = {item["runtime"]: item for item in intermediate["runtime_coverage"]}
    rendered = json.dumps(intermediate, sort_keys=True)

    assert coverage["github-copilot"] == {
        "runtime": "github-copilot",
        "status": "degraded",
        "reason": "schema_divergent",
        "candidate_count": 1,
        "record_count": 7,
        "error_count": 1,
    }
    assert intermediate["runtime_record_counts"] == {"github-copilot": 7}
    assert "malformed copilot tool payload token" not in rendered
    assert "PRIVATE_COPILOT_PROMPT_TOKEN" not in rendered
    assert str(copilot_store) not in rendered


def test_successful_copilot_zero_window_records_remains_ok(
    startup_analysis_contract,
    extract_corpus,
    tmp_path,
):
    project_root = tmp_path / "agentera"
    copilot_store = tmp_path / "copilot-store"
    project_root.mkdir()
    _write_supported_copilot_store(copilot_store, project_root)

    intermediate = startup_analysis_contract.extract_startup_intermediate_from_runtime_stores(
        project_roots=[project_root],
        codex_sessions_dir=None,
        claude_projects_dir=None,
        opencode_conversations_dir=None,
        copilot_conversations_dir=copilot_store,
        salt="fixture-salt",
        extract_corpus_module=extract_corpus,
        benchmark_mode="since_previous_benchmark",
        benchmark_previous_watermark_at=datetime.fromisoformat("2026-05-13T10:01:00+00:00"),
    )
    coverage = {item["runtime"]: item for item in intermediate["runtime_coverage"]}

    assert coverage["github-copilot"] == {
        "runtime": "github-copilot",
        "status": "ok",
        "reason": "records_extracted",
        "candidate_count": 1,
        "record_count": 0,
        "error_count": 0,
    }
    assert intermediate["runtime_record_counts"] == {}
    assert intermediate["total_records_read"] == 0
    assert intermediate["total_state_sequences"] == 0


def test_successful_runtime_with_zero_window_records_remains_ok(startup_analysis_contract, extract_corpus, tmp_path):
    project_root = tmp_path / "agentera"
    codex_store = tmp_path / "codex" / "sessions"
    project_root.mkdir()
    _write_codex_state_store(
        codex_store,
        project_root,
        session_token="session-redacted-codex",
        started_at="2026-05-13T10:00:00Z",
    )

    intermediate = startup_analysis_contract.extract_startup_intermediate_from_runtime_stores(
        project_roots=[project_root],
        codex_sessions_dir=codex_store,
        claude_projects_dir=None,
        opencode_conversations_dir=None,
        copilot_conversations_dir=None,
        salt="fixture-salt",
        extract_corpus_module=extract_corpus,
        benchmark_mode="since_previous_benchmark",
        benchmark_previous_watermark_at=datetime.fromisoformat("2026-05-13T10:01:00+00:00"),
    )
    rendered = json.dumps(intermediate, sort_keys=True)

    assert intermediate["runtime_coverage"][0] == {
        "runtime": "codex",
        "status": "ok",
        "reason": "records_extracted",
        "candidate_count": 1,
        "record_count": 0,
        "error_count": 0,
    }
    assert intermediate["runtime_record_counts"] == {}
    assert intermediate["total_records_read"] == 0
    assert intermediate["total_state_sequences"] == 0
    assert "session-redacted-codex" not in rendered
    assert str(codex_store) not in rendered
    assert str(project_root) not in rendered


def test_metrics_aggregate_state_sequences_and_redundant_artifacts(startup_analysis_contract):
    intermediate = startup_analysis_contract.build_startup_intermediate(
        {
            "metadata": {
                "adapter_version": "agentera-v2-corpus-1",
                "runtime_statuses": [
                    {"runtime": "opencode", "status": "ok", "reason": "records_extracted", "record_count": 8},
                    {"runtime": "github-copilot", "status": "sparse", "reason": "no_candidate_files", "candidate_count": 0},
                ],
            },
            "records": [
                _fixture_turn("turn-a", "2026-05-13T10:00:00Z", "user", "planera"),
                _fixture_tool("tool-cli-a", "2026-05-13T10:00:01Z", "bash", {"command": "uv run scripts/agentera plan"}),
                _fixture_tool("tool-plan-a", "2026-05-13T10:00:02Z", "read", {"filePath": "PROJECT_ROOT_TOKEN/.agentera/plan.yaml"}),
                _fixture_tool("tool-impl-a", "2026-05-13T10:00:03Z", "apply_patch", {"patchText": "x"}),
                {**_fixture_turn("turn-b", "2026-05-13T11:00:00Z", "user", "resonera"), "conversation_key": "fixture-conversation-b"},
                {
                    **_fixture_tool("tool-cli-b", "2026-05-13T11:00:01Z", "bash", {"command": "uv run scripts/agentera decisions"}),
                    "conversation_key": "fixture-conversation-b",
                },
                {
                    **_fixture_tool("tool-decision-b", "2026-05-13T11:00:02Z", "read", {"filePath": "PROJECT_ROOT_TOKEN/.agentera/decisions.yaml"}),
                    "conversation_key": "fixture-conversation-b",
                },
            ],
        },
        salt="fixture-salt",
    )
    intermediate["runtime_coverage"][1]["store_path"] = "RAW_STORE_PATH_TOKEN"

    metrics = startup_analysis_contract.aggregate_startup_metrics(intermediate)
    rendered = json.dumps(metrics, sort_keys=True)

    assert metrics["output_envelope"] == "startup_state_metrics_v1"
    assert metrics["input_envelope"] == "startup_state_analysis_v1"
    assert metrics["total_state_sequences"] == 2
    assert metrics["state_sequences_with_raw_after_cli"] == 2
    assert metrics["state_sequences_with_redundant_raw_access"] == 2
    assert metrics["per_capability_state_counts"] == {
        "planera": {
            "capability_prose_read": 0,
            "cli_state_call": 1,
            "implementation_boundary": 1,
            "raw_artifact_access_after_cli": 1,
            "redundant_raw_artifact_access": 1,
            "state_sequences": 1,
        },
        "resonera": {
            "capability_prose_read": 0,
            "cli_state_call": 1,
            "implementation_boundary": 0,
            "raw_artifact_access_after_cli": 1,
            "redundant_raw_artifact_access": 1,
            "state_sequences": 1,
        },
    }
    assert metrics["cli_state_command_counts"] == {"decisions": 1, "plan": 1}
    assert metrics["raw_artifact_access_after_cli_counts"] == {"DECISIONS.md": 1, "PLAN.md": 1}
    assert metrics["redundant_raw_artifact_access_counts"] == {"DECISIONS.md": 1, "PLAN.md": 1}
    assert metrics["runtime_status_counts"] == {"ok": 1, "sparse": 1}
    assert "runtime_coverage_incomplete_or_degraded" in metrics["confidence_caveats"]
    assert metrics["insufficient_evidence_reason"] is None
    assert metrics["implementation_recommended"] is False
    assert "PROJECT_ROOT_TOKEN" not in rendered
    assert "RAW_STORE_PATH_TOKEN" not in rendered
    assert "fixture-conversation-a" not in rendered
    assert "fixture-conversation-b" not in rendered


def test_threshold_derivation_recommends_startup_envelope_for_broad_redundant_reads(
    startup_analysis_contract,
):
    records = []
    for index, capability in enumerate(["planera", "realisera", "inspektera", "dokumentera"]):
        conversation = f"fixture-conversation-{index}"
        records.extend(
            [
                {**_fixture_turn(f"turn-{index}", f"2026-05-13T13:0{index}:00Z", "user", capability), "conversation_key": conversation},
                {
                    **_fixture_tool(
                        f"tool-cli-{index}",
                        f"2026-05-13T13:0{index}:01Z",
                        "bash",
                        {"command": "uv run scripts/agentera plan --format json"},
                    ),
                    "conversation_key": conversation,
                },
                {
                    **_fixture_tool(
                        f"tool-plan-{index}",
                        f"2026-05-13T13:0{index}:02Z",
                        "read",
                        {"filePath": "PROJECT_ROOT_TOKEN/.agentera/plan.yaml"},
                    ),
                    "conversation_key": conversation,
                },
                {
                    **_fixture_tool(f"tool-impl-{index}", f"2026-05-13T13:0{index}:03Z", "apply_patch", {"patchText": "x"}),
                    "conversation_key": conversation,
                },
            ]
        )

    metrics = startup_analysis_contract.aggregate_startup_metrics(
        startup_analysis_contract.build_startup_intermediate(
            {"metadata": {"adapter_version": "agentera-v2-corpus-1"}, "records": records},
            salt="fixture-salt",
        )
    )
    rendered = json.dumps(metrics, sort_keys=True)
    threshold = metrics["threshold_derivation"]["action_thresholds"]["startup_envelope"]

    assert threshold["credible"] is True
    assert threshold["redundant_sequence_threshold"] == 2
    assert "20% of measured sequences" in threshold["selection_reason"]
    assert metrics["threshold_derivation"]["measured_distribution"]["redundant_artifacts"] == {
        "PLAN.md": {"capability_count": 4, "count": 4}
    }
    assert metrics["startup_recommendation"] == {
        "action": "plan_cli_startup_envelope",
        "measured_trigger": "raw_artifact_access_after_cli:PLAN.md repeated 4 times across 4 capabilities",
        "rationale": "Raw artifact access after CLI state exceeded the broad startup-envelope threshold.",
    }
    assert metrics["implementation_recommended"] is True
    assert "PROJECT_ROOT_TOKEN" not in rendered
    assert "fixture-conversation-" not in rendered


def test_threshold_derivation_recommends_targeted_guidance_for_narrow_hotspot(
    startup_analysis_contract,
):
    records = [
        _fixture_turn("turn", "2026-05-13T14:00:00Z", "user", "planera"),
        _fixture_tool("tool-cli", "2026-05-13T14:00:01Z", "bash", {"command": "uv run scripts/agentera plan"}),
        _fixture_tool("tool-plan-a", "2026-05-13T14:00:02Z", "read", {"filePath": "PROJECT_ROOT_TOKEN/.agentera/plan.yaml"}),
        _fixture_tool("tool-plan-b", "2026-05-13T14:00:03Z", "grep", {"path": "PROJECT_ROOT_TOKEN/.agentera/plan.yaml", "pattern": "Task"}),
        _fixture_tool("tool-impl", "2026-05-13T14:00:04Z", "apply_patch", {"patchText": "x"}),
    ]

    metrics = startup_analysis_contract.aggregate_startup_metrics(
        startup_analysis_contract.build_startup_intermediate(
            {"metadata": {"adapter_version": "agentera-v2-corpus-1"}, "records": records},
            salt="fixture-salt",
        )
    )

    assert metrics["threshold_derivation"]["action_thresholds"]["startup_envelope"] == {
        "credible": False,
        "redundant_sequence_threshold": None,
        "selection_reason": "No broad-envelope threshold: fewer than three state-gathering sequences were measured.",
    }
    assert metrics["startup_recommendation"]["action"] == "targeted_capability_guidance_fixes"
    assert metrics["startup_recommendation"]["measured_trigger"] == "raw_artifact_access_after_cli_hotspot"
    assert metrics["implementation_recommended"] is False


def test_threshold_derivation_recommends_envelope_for_aggregate_redundant_rate(
    startup_analysis_contract,
):
    commands_and_paths = [
        ("planera", "plan", ".agentera/plan.yaml"),
        ("realisera", "docs", ".agentera/docs.yaml"),
        ("inspektera", "progress", ".agentera/progress.yaml"),
        ("dokumentera", "todo", "TODO.md"),
        ("resonera", "decisions", ".agentera/decisions.yaml"),
    ]
    records = []
    for index, (capability, command, path) in enumerate(commands_and_paths):
        conversation = f"fixture-conversation-{index}"
        records.extend(
            [
                {**_fixture_turn(f"turn-{index}", f"2026-05-13T15:0{index}:00Z", "user", capability), "conversation_key": conversation},
                {
                    **_fixture_tool(
                        f"tool-cli-{index}",
                        f"2026-05-13T15:0{index}:01Z",
                        "bash",
                        {"command": f"uv run scripts/agentera {command} --format json"},
                    ),
                    "conversation_key": conversation,
                },
                {
                    **_fixture_tool(
                        f"tool-raw-{index}",
                        f"2026-05-13T15:0{index}:02Z",
                        "read",
                        {"filePath": f"PROJECT_ROOT_TOKEN/{path}"},
                    ),
                    "conversation_key": conversation,
                },
            ]
        )

    metrics = startup_analysis_contract.aggregate_startup_metrics(
        startup_analysis_contract.build_startup_intermediate(
            {"metadata": {"adapter_version": "agentera-v2-corpus-1"}, "records": records},
            salt="fixture-salt",
        )
    )

    assert metrics["threshold_derivation"]["action_thresholds"]["startup_envelope"]["credible"] is True
    assert metrics["threshold_derivation"]["measured_distribution"]["redundant_sequence_count"] == 5
    assert metrics["startup_recommendation"] == {
        "action": "plan_cli_startup_envelope",
        "measured_trigger": "redundant_raw_artifact_access in 5 of 5 state sequences",
        "rationale": "Raw artifact access after CLI state exceeded the broad startup-envelope threshold.",
    }
    assert metrics["implementation_recommended"] is True


def test_metrics_report_insufficient_evidence_without_recommendation(startup_analysis_contract):
    intermediate = startup_analysis_contract.build_startup_intermediate(
        {
            "metadata": {
                "adapter_version": "agentera-v2-corpus-1",
                "runtime_statuses": [{"runtime": "codex", "status": "missing", "reason": "store_absent"}],
            },
            "records": [],
        },
        salt="fixture-salt",
    )

    metrics = startup_analysis_contract.aggregate_startup_metrics(intermediate)

    assert metrics["total_state_sequences"] == 0
    assert metrics["per_capability_state_counts"] == {}
    assert metrics["insufficient_evidence_reason"] == "no_post_2_3_state_sequences"
    assert "insufficient_post_2_3_state_sequences" in metrics["confidence_caveats"]
    assert metrics["startup_recommendation"] == {
        "action": "close_without_implementation",
        "measured_trigger": "weak_evidence",
        "rationale": "No post-boundary Agentera state-gathering sequences were available.",
    }
    assert metrics["implementation_recommended"] is False
    assert "recommendation_gate_input" not in metrics


def test_metrics_close_without_redundant_raw_access(startup_analysis_contract):
    records = []
    for index, capability in enumerate(["planera", "realisera", "inspektera"]):
        conversation = f"fixture-conversation-{index}"
        records.extend(
            [
                {**_fixture_turn(f"turn-{index}", f"2026-05-13T16:0{index}:00Z", "user", capability), "conversation_key": conversation},
                {
                    **_fixture_tool(
                        f"tool-cli-{index}",
                        f"2026-05-13T16:0{index}:01Z",
                        "bash",
                        {"command": "uv run scripts/agentera plan"},
                    ),
                    "conversation_key": conversation,
                },
                {
                    **_fixture_tool(f"tool-impl-{index}", f"2026-05-13T16:0{index}:02Z", "apply_patch", {"patchText": "x"}),
                    "conversation_key": conversation,
                },
            ]
        )

    metrics = startup_analysis_contract.aggregate_startup_metrics(
        startup_analysis_contract.build_startup_intermediate(
            {"metadata": {"adapter_version": "agentera-v2-corpus-1"}, "records": records},
            salt="fixture-salt",
        )
    )

    assert metrics["threshold_derivation"]["action_thresholds"]["startup_envelope"]["credible"] is True
    assert metrics["threshold_derivation"]["measured_distribution"]["redundant_artifacts"] == {}
    assert metrics["startup_recommendation"] == {
        "action": "close_without_implementation",
        "measured_trigger": "none",
        "rationale": "No raw artifact access after overlapping CLI state was measured.",
    }
    assert metrics["implementation_recommended"] is False


def test_report_surfaces_include_required_fields_without_private_output(
    startup_analysis_contract,
    tmp_path,
):
    intermediate = startup_analysis_contract.build_startup_intermediate(
        {
            "metadata": {
                "adapter_version": "agentera-v2-corpus-1",
                "runtime_statuses": [
                    {"runtime": "opencode", "status": "ok", "reason": "records_extracted", "record_count": 4}
                ],
            },
            "records": [
                _fixture_turn("turn", "2026-05-13T15:00:00Z", "user", "planera PRIVATE_PROMPT_TOKEN"),
                _fixture_tool("tool-cli", "2026-05-13T15:00:01Z", "bash", {"command": "uv run scripts/agentera plan"}),
                _fixture_tool("tool-plan", "2026-05-13T15:00:02Z", "read", {"filePath": "PRIVATE_ROOT_TOKEN/.agentera/plan.yaml"}),
                _fixture_tool("tool-impl", "2026-05-13T15:00:03Z", "apply_patch", {"patchText": "x"}),
            ],
        },
        salt="fixture-salt",
    )
    metrics = startup_analysis_contract.aggregate_startup_metrics(intermediate)

    paths = startup_analysis_contract.write_startup_reports(metrics, tmp_path / "reports")
    structured = json.loads(Path(paths["structured"]).read_text(encoding="utf-8"))
    human = Path(paths["human_readable"]).read_text(encoding="utf-8")
    combined = json.dumps(structured, sort_keys=True) + human

    assert structured["boundary_source"] == "git tag evidence"
    assert structured["runtime_coverage"][0]["runtime"] == "opencode"
    assert "per_capability_state_counts" in structured
    assert "threshold_derivation" in structured
    assert "startup_recommendation" in structured
    assert structured["token_estimator_version"] == "approx_bytes_div_4_v1"
    assert structured["estimated_raw_after_cli_tokens"] > 0
    assert structured["estimated_redundant_raw_tokens"] > 0
    assert set(structured["estimated_raw_after_cli_tokens_by_artifact"]) == {"PLAN.md"}
    assert set(structured["estimated_redundant_raw_tokens_by_artifact"]) == {"PLAN.md"}
    assert structured["estimated_tokens_saved_vs_previous"] is None
    assert structured["estimated_tokens_saved_vs_previous_null_reason"] == "previous_row_missing"
    assert "Estimated Token Impact" in human
    assert "Privacy Caveats" in human
    assert "Boundary Source" in human
    assert "Benchmark Window" in human
    assert "Runtime Coverage" in human
    assert "Threshold Rationale" in human
    assert "Recommendation" in human
    assert "PLAN.md" in combined
    assert "PRIVATE_PROMPT_TOKEN" not in combined
    assert "PRIVATE_ROOT_TOKEN" not in combined
    assert "fixture-salt" not in combined
    assert "session:" not in combined
    assert "record:" not in combined
    assert "path:" not in combined
    assert ".agentera/plan.yaml" not in combined


def test_benchmark_persistence_appends_aggregate_row_and_latest_reports(
    startup_analysis_contract,
    tmp_path,
):
    benchmark_dir = tmp_path / "agentera-home" / "benchmarks" / "startup-state"
    intermediate = startup_analysis_contract.build_startup_intermediate(
        {
            "metadata": {
                "adapter_version": "agentera-v2-corpus-1",
                "runtime_statuses": [
                    {"runtime": "opencode", "status": "ok", "reason": "records_extracted", "record_count": 4}
                ],
            },
            "records": [
                _fixture_turn("turn", "2026-05-13T18:00:00Z", "user", "planera PRIVATE_PROMPT_TOKEN"),
                _fixture_tool("tool-cli", "2026-05-13T18:00:01Z", "bash", {"command": "uv run scripts/agentera plan"}),
                _fixture_tool("tool-plan", "2026-05-13T18:00:02Z", "read", {"filePath": "PRIVATE_ROOT_TOKEN/.agentera/plan.yaml"}),
                _fixture_tool("tool-impl", "2026-05-13T18:00:03Z", "apply_patch", {"patchText": "x"}),
            ],
        },
        salt="fixture-salt",
    )
    metrics = startup_analysis_contract.aggregate_startup_metrics(intermediate)

    paths = startup_analysis_contract.persist_startup_benchmark(
        metrics,
        benchmark_dir,
        runtime_scope=["opencode"],
    )
    row = json.loads((benchmark_dir / "runs.jsonl").read_text(encoding="utf-8").strip())
    durable_text = "".join(path.read_text(encoding="utf-8") for path in benchmark_dir.iterdir())

    assert {path.name for path in benchmark_dir.iterdir()} == {
        "latest-report.json",
        "latest-report.md",
        "runs.jsonl",
    }
    assert {Path(path).name for path in paths.values()} == {
        "latest-report.json",
        "latest-report.md",
        "runs.jsonl",
    }
    assert row["agentera_version"] == "2.3.3"
    assert set(row) == set(_contract()["aggregate_history"]["row_shape"])
    assert isinstance(row["git_dirty"], bool)
    assert row["runtime_scope"] == ["opencode"]
    assert row["benchmark_mode"] == "full_boundary_snapshot"
    assert row["benchmark_previous_watermark_at"] is None
    assert row["benchmark_window_started_after"] == "2026-05-12T15:50:13+00:00"
    assert row["benchmark_watermark_at"] == "2026-05-13T18:00:03+00:00"
    assert row["total_records"] == 4
    assert row["total_state_sequences"] == 1
    assert row["state_sequences_with_raw_after_cli"] == 1
    assert row["state_sequences_with_redundant_raw_access"] == 1
    assert row["raw_after_cli_rate"] == 1
    assert row["redundant_raw_access_rate"] == 1
    assert row["token_estimator_version"] == "approx_bytes_div_4_v1"
    assert row["estimated_raw_after_cli_tokens"] > 0
    assert row["estimated_redundant_raw_tokens"] > 0
    assert row["estimated_raw_after_cli_tokens_by_artifact"] == {"PLAN.md": row["estimated_raw_after_cli_tokens"]}
    assert row["estimated_redundant_raw_tokens_by_artifact"] == {"PLAN.md": row["estimated_redundant_raw_tokens"]}
    assert row["estimated_tokens_saved_vs_previous"] is None
    assert row["estimated_tokens_saved_vs_previous_null_reason"] == "previous_row_missing"
    assert row["startup_recommendation_action"] == "targeted_capability_guidance_fixes"
    assert row["bounded_degradation_counts"] == {"record_or_sequence": {}, "runtime_status": {"ok": 1}}
    assert "PRIVATE_PROMPT_TOKEN" not in durable_text
    assert "PRIVATE_ROOT_TOKEN" not in durable_text
    assert ".agentera/plan.yaml" not in durable_text
    assert "session:" not in json.dumps(row, sort_keys=True)
    assert "record:" not in json.dumps(row, sort_keys=True)
    assert "path:" not in json.dumps(row, sort_keys=True)


def test_benchmark_persistence_emits_estimated_tokens_saved_against_previous_row(
    startup_analysis_contract,
    tmp_path,
):
    benchmark_dir = tmp_path / "agentera-home" / "benchmarks" / "startup-state"
    first_metrics = _plan_read_metrics(startup_analysis_contract, read_count=2)
    second_metrics = _plan_read_metrics(startup_analysis_contract, read_count=1)

    startup_analysis_contract.persist_startup_benchmark(first_metrics, benchmark_dir, runtime_scope=["opencode"])
    startup_analysis_contract.persist_startup_benchmark(second_metrics, benchmark_dir, runtime_scope=["opencode"])

    rows = [
        json.loads(line)
        for line in (benchmark_dir / "runs.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    latest = json.loads((benchmark_dir / "latest-report.json").read_text(encoding="utf-8"))
    markdown = (benchmark_dir / "latest-report.md").read_text(encoding="utf-8")

    expected_saved = rows[0]["estimated_redundant_raw_tokens"] - rows[1]["estimated_redundant_raw_tokens"]
    assert expected_saved > 0
    assert rows[1]["estimated_tokens_saved_vs_previous"] == expected_saved
    assert rows[1]["estimated_tokens_saved_vs_previous_null_reason"] is None
    assert latest["estimated_tokens_saved_vs_previous"] == expected_saved
    assert latest["estimated_tokens_saved_vs_previous_null_reason"] is None
    assert "Estimated tokens saved vs previous" in markdown
    assert "PLAN.md" in latest["estimated_redundant_raw_tokens_by_artifact"]


def test_benchmark_persistence_explains_missing_previous_token_estimates(
    startup_analysis_contract,
    tmp_path,
):
    benchmark_dir = tmp_path / "agentera-home" / "benchmarks" / "startup-state"
    benchmark_dir.mkdir(parents=True)
    (benchmark_dir / "runs.jsonl").write_text(
        json.dumps(
            {
                "contract_version": "startup-state-analysis-v1",
                "runtime_scope": ["opencode"],
                "benchmark_mode": "full_boundary_snapshot",
                "benchmark_watermark_at": "2026-05-13T17:00:00+00:00",
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )

    metrics = _plan_read_metrics(startup_analysis_contract, read_count=1)
    startup_analysis_contract.persist_startup_benchmark(metrics, benchmark_dir, runtime_scope=["opencode"])
    row = json.loads((benchmark_dir / "runs.jsonl").read_text(encoding="utf-8").splitlines()[-1])
    latest = json.loads((benchmark_dir / "latest-report.json").read_text(encoding="utf-8"))

    assert row["estimated_tokens_saved_vs_previous"] is None
    assert row["estimated_tokens_saved_vs_previous_null_reason"] == "previous_missing_token_estimates"
    assert latest["estimated_tokens_saved_vs_previous"] is None
    assert latest["estimated_tokens_saved_vs_previous_null_reason"] == "previous_missing_token_estimates"


def test_benchmark_persistence_failure_does_not_append_or_clobber_latest_reports(
    startup_analysis_contract,
    tmp_path,
    monkeypatch,
):
    benchmark_dir = tmp_path / "agentera-home" / "benchmarks" / "startup-state"
    benchmark_dir.mkdir(parents=True)
    runs_path = benchmark_dir / "runs.jsonl"
    json_path = benchmark_dir / "latest-report.json"
    markdown_path = benchmark_dir / "latest-report.md"
    runs_path.write_text('{"previous": true}\n', encoding="utf-8")
    json_path.write_text('{"previous": true}\n', encoding="utf-8")
    markdown_path.write_text("previous report", encoding="utf-8")

    def fail_render(metrics):
        raise RuntimeError("fixture render failure")

    monkeypatch.setattr(startup_analysis_contract, "render_startup_report", fail_render)

    with pytest.raises(RuntimeError, match="fixture render failure"):
        startup_analysis_contract.persist_startup_benchmark({}, benchmark_dir, runtime_scope=["opencode"])

    assert runs_path.read_text(encoding="utf-8") == '{"previous": true}\n'
    assert json_path.read_text(encoding="utf-8") == '{"previous": true}\n'
    assert markdown_path.read_text(encoding="utf-8") == "previous report"


def test_default_report_cli_uses_local_inputs_and_redacts_stdout_without_shell_writes(
    startup_analysis_contract,
    tmp_path,
    capsys,
):
    shell_startup = tmp_path / "home" / ".bashrc"
    shell_startup.parent.mkdir()
    original_shell_startup = "# user-owned startup file\nexport USER_SETTING=1\n"
    shell_startup.write_text(original_shell_startup, encoding="utf-8")
    corpus_path = tmp_path / "fixtures" / "corpus.json"
    output_dir = tmp_path / "reports"
    corpus_path.parent.mkdir()
    corpus_path.write_text(
        json.dumps(
            {
                "metadata": {"adapter_version": "agentera-v2-corpus-1"},
                "records": [
                    _fixture_turn("turn", "2026-05-13T17:00:00Z", "user", "planera PRIVATE_PROMPT_TOKEN"),
                    _fixture_tool("tool-cli", "2026-05-13T17:00:01Z", "bash", {"command": "uv run scripts/agentera plan"}),
                    _fixture_tool("tool-plan", "2026-05-13T17:00:02Z", "read", {"filePath": "PRIVATE_ROOT_TOKEN/.agentera/plan.yaml"}),
                    _fixture_tool("tool-impl", "2026-05-13T17:00:03Z", "apply_patch", {"patchText": "x"}),
                ],
            }
        ),
        encoding="utf-8",
    )

    exit_code = startup_analysis_contract.main(
        ["--corpus-json", str(corpus_path), "--output-dir", str(output_dir), "--salt", "fixture-salt"]
    )
    stdout = capsys.readouterr().out
    rendered_reports = "".join(path.read_text(encoding="utf-8") for path in output_dir.iterdir())

    assert exit_code == 0
    assert shell_startup.read_text(encoding="utf-8") == original_shell_startup
    assert "startup-overhead-report.json" in stdout
    assert "startup-overhead-report.md" in stdout
    assert str(tmp_path) not in stdout
    assert str(corpus_path) not in stdout
    assert "PRIVATE_PROMPT_TOKEN" not in stdout + rendered_reports
    assert "PRIVATE_ROOT_TOKEN" not in stdout + rendered_reports
    assert ".agentera/plan.yaml" not in stdout + rendered_reports


def test_benchmark_cli_persists_fixture_runtime_store_under_temp_agentera_home(
    startup_analysis_contract,
    tmp_path,
    monkeypatch,
    capsys,
):
    agentera_home = tmp_path / "agentera-home"
    project_root = tmp_path / "project"
    sessions_dir = tmp_path / "codex-sessions"
    output_dir = tmp_path / "temporary-reports"
    project_root.mkdir()
    _write_codex_state_store(sessions_dir, project_root)
    monkeypatch.setenv("AGENTERA_HOME", str(agentera_home))

    exit_code = startup_analysis_contract.main(
        [
            "--runtime-store",
            f"codex={sessions_dir}",
            "--project-root",
            str(project_root),
            "--output-dir",
            str(output_dir),
            "--salt",
            "fixture-salt",
            "--persist-benchmark",
        ]
    )
    stdout = capsys.readouterr().out
    benchmark_dir = agentera_home / "benchmarks" / "startup-state"
    row = json.loads((benchmark_dir / "runs.jsonl").read_text(encoding="utf-8").strip())
    durable_text = "".join(path.read_text(encoding="utf-8") for path in benchmark_dir.iterdir())

    assert exit_code == 0
    assert {path.name for path in benchmark_dir.iterdir()} == {
        "latest-report.json",
        "latest-report.md",
        "runs.jsonl",
    }
    assert row["runtime_scope"] == ["codex"]
    assert row["total_records"] == 4
    assert row["total_state_sequences"] == 1
    assert row["raw_after_cli_rate"] == 1
    assert "runs.jsonl" in stdout
    assert "latest-report.json" in stdout
    assert str(sessions_dir) not in stdout + durable_text
    assert str(project_root) not in stdout + durable_text
    assert "PRIVATE_PROMPT_TOKEN" not in stdout + durable_text
    assert "raw-session-id-token" not in stdout + durable_text
    assert not (REPO_ROOT / "benchmarks").exists()
    assert not (REPO_ROOT / "runs.jsonl").exists()
    assert not (REPO_ROOT / "startup-overhead-report.json").exists()
    assert not (REPO_ROOT / "startup-overhead-report.md").exists()


def test_benchmark_cli_uses_previous_watermark_for_incremental_runs(
    startup_analysis_contract,
    tmp_path,
    monkeypatch,
):
    agentera_home = tmp_path / "agentera-home"
    project_root = tmp_path / "project"
    sessions_dir = tmp_path / "codex-sessions"
    output_dir = tmp_path / "temporary-reports"
    project_root.mkdir()
    _write_codex_state_store(
        sessions_dir,
        project_root,
        session_name="first",
        started_at="2026-05-13T10:00:00Z",
    )
    monkeypatch.setenv("AGENTERA_HOME", str(agentera_home))

    args = [
        "--runtime-store",
        f"codex={sessions_dir}",
        "--project-root",
        str(project_root),
        "--output-dir",
        str(output_dir),
        "--salt",
        "fixture-salt",
        "--persist-benchmark",
        "--since-previous-benchmark",
    ]
    assert startup_analysis_contract.main(args) == 0
    benchmark_dir = agentera_home / "benchmarks" / "startup-state"
    rows = [
        json.loads(line)
        for line in (benchmark_dir / "runs.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    first_watermark = rows[-1]["benchmark_watermark_at"]

    _write_codex_state_store(
        sessions_dir,
        project_root,
        session_name="second",
        session_token="second-raw-session-id-token",
        started_at="2026-05-13T11:00:00Z",
    )
    assert startup_analysis_contract.main(args) == 0
    assert startup_analysis_contract.main(args) == 0
    rows = [
        json.loads(line)
        for line in (benchmark_dir / "runs.jsonl").read_text(encoding="utf-8").splitlines()
    ]

    assert rows[0]["benchmark_mode"] == "since_previous_benchmark"
    assert rows[0]["benchmark_previous_watermark_at"] is None
    assert rows[0]["total_records"] == 4
    assert rows[0]["total_state_sequences"] == 1
    assert first_watermark == "2026-05-13T10:00:03+00:00"
    assert rows[1]["benchmark_previous_watermark_at"] == first_watermark
    assert rows[1]["benchmark_window_started_after"] == first_watermark
    assert rows[1]["benchmark_watermark_at"] == "2026-05-13T11:00:03+00:00"
    assert rows[1]["total_records"] == 4
    assert rows[1]["total_state_sequences"] == 1
    assert rows[2]["benchmark_previous_watermark_at"] == rows[1]["benchmark_watermark_at"]
    assert rows[2]["benchmark_watermark_at"] == rows[1]["benchmark_watermark_at"]
    assert rows[2]["total_records"] == 0
    assert rows[2]["total_state_sequences"] == 0


def test_benchmark_cli_default_runtime_stores_use_known_defaults(
    startup_analysis_contract,
    tmp_path,
    monkeypatch,
):
    home = tmp_path / "home"
    agentera_home = tmp_path / "agentera-home"
    project_root = tmp_path / "project"
    sessions_dir = home / ".codex" / "sessions"
    output_dir = tmp_path / "temporary-reports"
    project_root.mkdir()
    _write_codex_state_store(sessions_dir, project_root)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("AGENTERA_HOME", str(agentera_home))
    monkeypatch.setenv("COPILOT_HOME", str(home / ".copilot"))
    monkeypatch.setenv("PATH", "")

    exit_code = startup_analysis_contract.main(
        [
            "--default-runtime-stores",
            "--project-root",
            str(project_root),
            "--output-dir",
            str(output_dir),
            "--salt",
            "fixture-salt",
            "--persist-benchmark",
            "--since-previous-benchmark",
        ]
    )
    benchmark_dir = agentera_home / "benchmarks" / "startup-state"
    row = json.loads((benchmark_dir / "runs.jsonl").read_text(encoding="utf-8").strip())
    latest = json.loads((benchmark_dir / "latest-report.json").read_text(encoding="utf-8"))
    coverage = {item["runtime"]: item for item in latest["runtime_coverage"]}

    assert exit_code == 0
    assert row["runtime_scope"] == ["claude-code", "codex", "github-copilot", "opencode"]
    assert row["benchmark_mode"] == "since_previous_benchmark"
    assert row["total_records"] == 4
    assert row["total_state_sequences"] == 1
    assert coverage["codex"]["status"] == "ok"
    assert coverage["claude-code"]["status"] == "missing"
    assert coverage["github-copilot"]["status"] == "missing"
    assert coverage["opencode"] == {
        "runtime": "opencode",
        "status": "skipped",
        "reason": "disabled",
    }


def test_benchmark_cli_records_missing_runtime_store_as_bounded_degradation(
    startup_analysis_contract,
    tmp_path,
    monkeypatch,
):
    agentera_home = tmp_path / "agentera-home"
    project_root = tmp_path / "project"
    output_dir = tmp_path / "temporary-reports"
    missing_sessions_dir = tmp_path / "missing-codex-sessions"
    project_root.mkdir()
    monkeypatch.setenv("AGENTERA_HOME", str(agentera_home))

    exit_code = startup_analysis_contract.main(
        [
            "--runtime-store",
            f"codex={missing_sessions_dir}",
            "--project-root",
            str(project_root),
            "--output-dir",
            str(output_dir),
            "--salt",
            "fixture-salt",
            "--persist-benchmark",
        ]
    )
    benchmark_dir = agentera_home / "benchmarks" / "startup-state"
    row = json.loads((benchmark_dir / "runs.jsonl").read_text(encoding="utf-8").strip())
    latest = json.loads((benchmark_dir / "latest-report.json").read_text(encoding="utf-8"))

    assert exit_code == 0
    assert row["runtime_scope"] == ["codex"]
    assert row["total_records"] == 0
    assert row["total_state_sequences"] == 0
    assert row["startup_recommendation_action"] == "close_without_implementation"
    assert row["bounded_degradation_counts"]["runtime_status"]["missing"] == 1
    assert latest["runtime_coverage"][0] == {
        "runtime": "codex",
        "status": "missing",
        "reason": "store_absent",
    }


def test_benchmark_cli_persists_no_runtime_default_without_history(
    startup_analysis_contract,
    tmp_path,
    monkeypatch,
):
    agentera_home = tmp_path / "agentera-home"
    output_dir = tmp_path / "temporary-reports"
    monkeypatch.setenv("AGENTERA_HOME", str(agentera_home))

    exit_code = startup_analysis_contract.main(
        [
            "--no-runtime-stores",
            "--output-dir",
            str(output_dir),
            "--salt",
            "fixture-salt",
            "--persist-benchmark",
        ]
    )
    benchmark_dir = agentera_home / "benchmarks" / "startup-state"
    row = json.loads((benchmark_dir / "runs.jsonl").read_text(encoding="utf-8").strip())
    latest = json.loads((benchmark_dir / "latest-report.json").read_text(encoding="utf-8"))

    assert exit_code == 0
    assert row["runtime_scope"] == ["none"]
    assert row["total_records"] == 0
    assert row["total_state_sequences"] == 0
    assert row["startup_recommendation_action"] == "close_without_implementation"
    assert row["bounded_degradation_counts"]["runtime_status"] == {"skipped": 1}
    assert latest["runtime_coverage"] == [
        {
            "runtime": "none",
            "status": "skipped",
            "reason": "no_runtime_stores_approved",
            "record_count": 0,
        }
    ]


def test_runtime_store_cli_requires_explicit_absolute_runtime_path(
    startup_analysis_contract,
    tmp_path,
    monkeypatch,
):
    agentera_home = tmp_path / "agentera-home"
    output_dir = tmp_path / "reports"
    monkeypatch.setenv("AGENTERA_HOME", str(agentera_home))

    with pytest.raises(SystemExit) as error:
        startup_analysis_contract.main(
            [
                "--runtime-store",
                "opencode=relative/opencode.db",
                "--output-dir",
                str(output_dir),
                "--salt",
                "fixture-salt",
                "--persist-benchmark",
            ]
        )

    assert error.value.code == 2
    assert not output_dir.exists()
    assert not (agentera_home / "benchmarks").exists()


def test_runtime_store_cli_delegates_fixture_extraction_without_private_output(
    startup_analysis_contract,
    tmp_path,
    capsys,
):
    project_root = tmp_path / "project"
    sessions_dir = tmp_path / "codex-sessions"
    output_dir = tmp_path / "reports"
    project_root.mkdir()
    _write_codex_state_store(sessions_dir, project_root)

    exit_code = startup_analysis_contract.main(
        [
            "--runtime-store",
            f"codex={sessions_dir}",
            "--project-root",
            str(project_root),
            "--output-dir",
            str(output_dir),
            "--salt",
            "fixture-salt",
        ]
    )
    stdout = capsys.readouterr().out
    report_text = "".join(path.read_text(encoding="utf-8") for path in output_dir.iterdir())

    assert exit_code == 0
    assert "startup-overhead-report.json" in stdout
    assert "startup-overhead-report.md" in stdout
    assert "PRIVATE_PROMPT_TOKEN" not in report_text
    assert str(sessions_dir) not in stdout + report_text
    assert str(project_root) not in stdout + report_text
    assert ".agentera/plan.yaml" not in report_text
    assert "PLAN.md" in report_text


def test_mage_startup_state_entrypoint_documents_noninteractive_approval():
    magefile = (REPO_ROOT / "magefile.go").read_text(encoding="utf-8")

    assert "type Bench mg.Namespace" in magefile
    assert "func (Bench) StartupState() error" in magefile
    assert "scripts/startup_analysis_contract.py" in magefile
    assert "--persist-benchmark" in magefile
    assert "--default-runtime-stores" in magefile
    assert "--since-previous-benchmark" in magefile
    assert "benchmarks/startup-state" in magefile
    assert "mage bench:startupState" in magefile
    assert "AGENTERA_BENCH_RUNTIME_STORES=RUNTIME=/absolute/path" in magefile
    assert "generatedBenchmarkSalt" in magefile
    assert "AGENTERA_BENCH_SALT" in magefile


def test_docs_link_startup_report_surface_and_preserve_correct_metric():
    docs = yaml.safe_load(DOCS_PATH.read_text(encoding="utf-8"))
    indexed_paths = {item["path"] for item in docs["index"]}
    audit_text = yaml.safe_dump(docs, sort_keys=True)
    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    benchmark_doc = BENCHMARK_DOC_PATH.read_text(encoding="utf-8")

    assert "scripts/startup_analysis_contract.py" in indexed_paths
    assert "references/analysis/startup-measurement-contract.yaml" in indexed_paths
    assert "docs/benchmark.md" in indexed_paths
    assert "startup-overhead-report.md" in audit_text
    assert "Decision 51" in audit_text
    assert "raw artifact access after CLI state" in audit_text
    assert "--corpus-json" in readme
    assert "--output-dir" in readme
    assert "docs/benchmark.md" in readme
    assert "runtime-store" in readme
    assert "mage bench:startupState" in benchmark_doc
    assert "AGENTERA_BENCH_RUNTIME_STORES" in benchmark_doc
    assert "Mage generates one" in benchmark_doc
    assert "no extra setup" in benchmark_doc
    assert "Every `mage bench:*` target must run with no environment variables" in benchmark_doc
    assert "benchmark.directory" in benchmark_doc
    assert "benchmark_watermark_at" in benchmark_doc
    assert "since the previous successful benchmark run" in benchmark_doc
    assert "runs.jsonl" in benchmark_doc
    assert "raw_after_cli_rate" in benchmark_doc
    assert "redundant_raw_access_rate" in benchmark_doc
    assert "uncommitted, unshipped, and not" in benchmark_doc
    assert "live hosts" in readme
    assert "transcript output" in readme
    assert "raw transcripts" in benchmark_doc
