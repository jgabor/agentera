"""Tests for the corrected startup state-access metric."""

from __future__ import annotations

import json
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACT_PATH = REPO_ROOT / "references" / "analysis" / "startup-measurement-contract.yaml"
DOCS_PATH = REPO_ROOT / ".agentera" / "docs.yaml"


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


def _write_codex_state_store(sessions_dir: Path, project_root: Path) -> None:
    session_path = sessions_dir / "2026" / "05" / "13" / "startup.jsonl"
    session_path.parent.mkdir(parents=True)
    events = [
        {
            "type": "session_meta",
            "payload": {"id": "raw-session-id-token", "cwd": str(project_root)},
        },
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "planera PRIVATE_PROMPT_TOKEN"}],
                "timestamp": "2026-05-13T10:00:00Z",
            },
        },
        {
            "type": "function_call",
            "payload": {
                "type": "function_call",
                "name": "bash",
                "arguments": {"command": "uv run scripts/agentera plan --format json"},
                "timestamp": "2026-05-13T10:00:01Z",
            },
        },
        {
            "type": "function_call",
            "payload": {
                "type": "function_call",
                "name": "read",
                "arguments": {"filePath": str(project_root / ".agentera" / "plan.yaml")},
                "timestamp": "2026-05-13T10:00:02Z",
            },
        },
        {
            "type": "function_call",
            "payload": {
                "type": "function_call",
                "name": "apply_patch",
                "arguments": {"patchText": "*** Begin Patch\n*** End Patch"},
                "timestamp": "2026-05-13T10:00:03Z",
            },
        },
    ]
    session_path.write_text("\n".join(json.dumps(event) for event in events) + "\n", encoding="utf-8")


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
    } <= set(contract["report_fields"]["required"])


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
    assert "Privacy Caveats" in human
    assert "Boundary Source" in human
    assert "Runtime Coverage" in human
    assert "Threshold Rationale" in human
    assert "Recommendation" in human
    assert "PLAN.md" in combined
    assert "PRIVATE_PROMPT_TOKEN" not in combined
    assert "PRIVATE_ROOT_TOKEN" not in combined
    assert ".agentera/plan.yaml" not in combined


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


def test_docs_link_startup_report_surface_and_preserve_correct_metric():
    docs = yaml.safe_load(DOCS_PATH.read_text(encoding="utf-8"))
    indexed_paths = {item["path"] for item in docs["index"]}
    audit_text = yaml.safe_dump(docs, sort_keys=True)
    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")

    assert "scripts/startup_analysis_contract.py" in indexed_paths
    assert "references/analysis/startup-measurement-contract.yaml" in indexed_paths
    assert "startup-overhead-report.md" in audit_text
    assert "Decision 51" in audit_text
    assert "raw artifact access after CLI state" in audit_text
    assert "--corpus-json" in readme
    assert "--output-dir" in readme
    assert "live hosts" in readme
    assert "raw transcript" in readme
