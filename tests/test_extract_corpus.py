"""Tests for scripts/extract_corpus.py."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def _write_codex_fixture(sessions_dir: Path, project_root: Path) -> Path:
    session_path = sessions_dir / "2026" / "05" / "05" / "session.jsonl"
    session_path.parent.mkdir(parents=True)
    events = [
        {
            "type": "session_meta",
            "payload": {
                "id": "sess-1",
                "cwd": str(project_root),
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "Should we keep explicit flags authoritative?",
                    }
                ],
                "timestamp": "2026-05-05T10:00:00Z",
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": "Yes, settings should only fill gaps.",
                    }
                ],
                "timestamp": "2026-05-05T10:01:00Z",
            },
        },
    ]
    session_path.write_text(
        "\n".join(json.dumps(event) for event in events) + "\n",
        encoding="utf-8",
    )
    return session_path


def test_build_corpus_emits_portable_families(tmp_path, extract_corpus, usage_stats):
    project_root = tmp_path / "agentera"
    project_root.mkdir()
    (project_root / "AGENTS.md").write_text("Prefer evidence-first execution.\n", encoding="utf-8")
    (project_root / "package.json").write_text(
        json.dumps({"name": "agentera", "scripts": {"test": "pytest"}}),
        encoding="utf-8",
    )
    sessions_dir = tmp_path / "codex" / "sessions"
    _write_codex_fixture(sessions_dir, project_root)

    corpus = extract_corpus.build_corpus(
        project_roots=[project_root],
        codex_sessions_dir=sessions_dir,
        claude_projects_dir=None,
    )

    metadata = corpus["metadata"]
    assert metadata["adapter_version"] == extract_corpus.ADAPTER_VERSION
    assert metadata["total_records"] == len(corpus["records"])
    assert metadata["families"]["instruction_document"]["count"] == 1
    assert metadata["families"]["project_config_signal"]["count"] == 1
    assert metadata["families"]["conversation_turn"]["count"] == 2
    assert metadata["families"]["history_prompt"]["count"] == 1

    kinds = {record["source_kind"] for record in corpus["records"]}
    assert kinds == {
        "instruction_document",
        "project_config_signal",
        "conversation_turn",
        "history_prompt",
    }
    for record in corpus["records"]:
        assert record["source_id"]
        assert record["project_id"] == "agentera"
        assert record["adapter_version"] == extract_corpus.ADAPTER_VERSION
        assert isinstance(record["data"], dict)

    user_turn = next(
        record
        for record in corpus["records"]
        if record["source_kind"] == "conversation_turn"
        and record["data"]["actor"] == "user"
    )
    assert user_turn["session_id"] == "sess-1"
    assert user_turn["runtime"] == "codex"
    assert user_turn["data"]["signal_type"] == "question"
    grouped = usage_stats.group_by_conversation(corpus["records"])
    assert set(grouped) == {"sess-1"}


def test_cli_writes_corpus_and_reports_counts(tmp_path):
    project_root = tmp_path / "agentera"
    project_root.mkdir()
    (project_root / "AGENTS.md").write_text("Use direct verdicts.\n", encoding="utf-8")
    sessions_dir = tmp_path / "codex" / "sessions"
    _write_codex_fixture(sessions_dir, project_root)
    output = tmp_path / "out" / "corpus.json"

    result = subprocess.run(
        [
            sys.executable,
            "scripts/extract_corpus.py",
            "--output",
            str(output),
            "--project-root",
            str(project_root),
            "--codex-sessions-dir",
            str(sessions_dir),
            "--no-claude",
        ],
        cwd=Path(__file__).resolve().parent.parent,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "wrote corpus:" in result.stdout
    assert "conversation_turn=2" in result.stdout
    corpus = json.loads(output.read_text(encoding="utf-8"))
    assert corpus["metadata"]["families"]["conversation_turn"]["status"] == "ok"
    assert corpus["metadata"]["total_records"] >= 3
