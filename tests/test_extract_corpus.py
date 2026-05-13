"""Tests for scripts/extract_corpus.py."""

from __future__ import annotations

import json
import sqlite3
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


def _write_claude_fixture(projects_dir: Path, project_root: Path) -> Path:
    session_path = projects_dir / "agentera" / "claude-session.jsonl"
    session_path.parent.mkdir(parents=True)
    events = [
        {
            "role": "assistant",
            "cwd": str(project_root),
            "content": "Prefer the existing extractor contract.",
            "timestamp": "2026-05-05T09:00:00Z",
        },
        {
            "role": "user",
            "cwd": str(project_root),
            "content": "Should Claude normalize through the same families?",
            "timestamp": "2026-05-05T09:01:00Z",
        },
    ]
    session_path.write_text(
        "\n".join(json.dumps(event) for event in events) + "\n",
        encoding="utf-8",
    )
    return session_path


def _write_opencode_fixture(db_path: Path, project_root: Path) -> Path:
    db_path.parent.mkdir(parents=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE session (
                id TEXT PRIMARY KEY,
                cwd TEXT,
                time INTEGER
            );
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                sessionID TEXT,
                role TEXT,
                time INTEGER
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY,
                messageID TEXT,
                type TEXT,
                text TEXT
            );
            """
        )
        conn.execute(
            "INSERT INTO session (id, cwd, time) VALUES (?, ?, ?)",
            ("open-1", str(project_root), 1_778_846_400),
        )
        conn.executemany(
            "INSERT INTO message (id, sessionID, role, time) VALUES (?, ?, ?, ?)",
            [
                ("msg-1", "open-1", "assistant", 1_778_846_400),
                ("msg-2", "open-1", "user", 1_778_846_460),
                ("msg-3", "open-1", "assistant", 1_778_846_520),
            ],
        )
        conn.executemany(
            "INSERT INTO part (id, messageID, type, text) VALUES (?, ?, ?, ?)",
            [
                ("part-1", "msg-1", "text", "Use the existing runtime contract."),
                ("part-2", "msg-2", "text", "Should we keep OpenCode local-only?"),
                ("part-3", "msg-3", "text", "Yes, read opencode.db without external calls."),
            ],
        )
        conn.commit()
    finally:
        conn.close()
    return db_path


def _write_copilot_fixture(db_path: Path, project_root: Path) -> Path:
    db_path.parent.mkdir(parents=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                cwd TEXT,
                created_at INTEGER
            );
            CREATE TABLE turns (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                role TEXT,
                turn_index INTEGER,
                content TEXT,
                created_at INTEGER
            );
            """
        )
        conn.execute(
            "INSERT INTO sessions (id, cwd, created_at) VALUES (?, ?, ?)",
            ("copilot-1", str(project_root), 1_778_850_000),
        )
        conn.executemany(
            """
            INSERT INTO turns (id, session_id, role, turn_index, content, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                ("turn-1", "copilot-1", "assistant", 1, "Use local storage only.", 1_778_850_000),
                ("turn-2", "copilot-1", "assistant", 2, "Assistant answer second.", 1_778_850_060),
                ("turn-3", "copilot-1", "user", 2, "Should we keep Copilot local-only?", 1_778_850_060),
                ("turn-4", "copilot-1", "assistant", 3, "Yes, session-store.db is enough.", 1_778_850_120),
            ],
        )
        conn.commit()
    finally:
        conn.close()
    return db_path


def _runtime_status(corpus, runtime: str) -> dict:
    statuses = {item["runtime"]: item for item in corpus["metadata"]["runtime_statuses"]}
    assert runtime in statuses, f"missing runtime status: runtime={runtime}"
    return statuses[runtime]


def _assert_runtime_status(corpus, runtime: str, status: str, reason: str) -> dict:
    item = _runtime_status(corpus, runtime)
    assert item["status"] == status, (
        f"unexpected runtime status: runtime={runtime} "
        f"status={item['status']} reason={item['reason']}"
    )
    assert item["reason"] == reason, (
        f"unexpected runtime reason: runtime={runtime} "
        f"status={item['status']} reason={item['reason']}"
    )
    return item


def _runtime_family_counts(corpus) -> dict[tuple[str, str], int]:
    counts: dict[tuple[str, str], int] = {}
    for record in corpus["records"]:
        key = (record["runtime"], record["source_kind"])
        counts[key] = counts.get(key, 0) + 1
    return counts


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
    statuses = {item["runtime"]: item for item in metadata["runtime_statuses"]}
    assert statuses["codex"]["status"] == "ok"
    assert statuses["codex"]["reason"] == "records_extracted"
    assert statuses["claude-code"]["status"] == "skipped"

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


def test_runtime_discovery_reports_bounded_degradation_without_transcript_leak(
    tmp_path,
    extract_corpus,
):
    project_root = tmp_path / "agentera"
    project_root.mkdir()
    missing = tmp_path / "missing"
    sparse = tmp_path / "sparse"
    sparse.mkdir()
    divergent = tmp_path / "divergent"
    divergent.mkdir()
    secret_transcript = "do not leak this raw transcript text"
    (divergent / "session.jsonl").write_text(
        "{not json " + secret_transcript + "}\n",
        encoding="utf-8",
    )

    corpus = extract_corpus.build_corpus(
        project_roots=[project_root],
        codex_sessions_dir=divergent,
        claude_projects_dir=sparse,
        opencode_conversations_dir=missing,
        copilot_conversations_dir=None,
    )

    statuses = {
        item["runtime"]: item for item in corpus["metadata"]["runtime_statuses"]
    }
    assert statuses["codex"]["status"] == "degraded"
    assert statuses["codex"]["reason"] == "schema_divergent"
    assert statuses["claude-code"]["status"] == "sparse"
    assert statuses["claude-code"]["reason"] == "no_candidate_files"
    assert statuses["opencode"]["status"] == "missing"
    assert statuses["opencode"]["reason"] == "store_absent"
    assert statuses["github-copilot"]["status"] == "skipped"
    assert statuses["github-copilot"]["reason"] == "disabled"
    assert secret_transcript not in json.dumps(corpus["metadata"])


def test_copilot_sqlite_store_extracts_user_before_assistant_and_history_prompts(
    tmp_path,
    extract_corpus,
):
    project_root = tmp_path / "agentera"
    project_root.mkdir()
    db_path = _write_copilot_fixture(tmp_path / "copilot" / "session-store.db", project_root)

    corpus = extract_corpus.build_corpus(
        project_roots=[project_root],
        codex_sessions_dir=None,
        claude_projects_dir=None,
        opencode_conversations_dir=None,
        copilot_conversations_dir=db_path.parent,
    )

    statuses = {
        item["runtime"]: item for item in corpus["metadata"]["runtime_statuses"]
    }
    assert statuses["github-copilot"]["status"] == "ok"
    assert statuses["github-copilot"]["reason"] == "records_extracted"
    assert statuses["github-copilot"]["candidate_count"] == 1
    assert statuses["github-copilot"]["record_count"] == 5
    copilot_turns = [
        record
        for record in corpus["records"]
        if record["runtime"] == "github-copilot"
        and record["source_kind"] == "conversation_turn"
    ]
    assert [turn["data"]["actor"] for turn in copilot_turns] == [
        "assistant",
        "user",
        "assistant",
        "assistant",
    ]
    user_turn = copilot_turns[1]
    assert user_turn["session_id"] == "copilot-1"
    assert user_turn["project_path"] == str(project_root)
    assert user_turn["data"]["signal_type"] == "question"
    assert user_turn["data"]["preceding_context"] == "Use local storage only."
    prompts = [
        record
        for record in corpus["records"]
        if record["runtime"] == "github-copilot"
        and record["source_kind"] == "history_prompt"
    ]
    assert len(prompts) == 1
    assert prompts[0]["data"] == {
        "prompt": "Should we keep Copilot local-only?",
        "signal_type": "question",
    }


def test_copilot_sparse_store_degrades_with_bounded_remediation_without_transcript_leak(
    tmp_path,
    extract_corpus,
):
    project_root = tmp_path / "agentera"
    project_root.mkdir()
    sparse = tmp_path / "copilot"
    sparse.mkdir()
    secret_transcript = "raw user transcript must stay private"
    (sparse / "conversation.jsonl").write_text(
        json.dumps({"content": secret_transcript}) + "\n",
        encoding="utf-8",
    )

    corpus = extract_corpus.build_corpus(
        project_roots=[project_root],
        codex_sessions_dir=None,
        claude_projects_dir=None,
        opencode_conversations_dir=None,
        copilot_conversations_dir=sparse,
    )

    statuses = {
        item["runtime"]: item for item in corpus["metadata"]["runtime_statuses"]
    }
    assert statuses["github-copilot"]["status"] == "sparse"
    assert statuses["github-copilot"]["reason"] == "no_candidate_files"
    assert statuses["github-copilot"]["candidate_count"] == 0
    assert statuses["github-copilot"]["remediation_labels"] == ["/chronicle reindex"]
    assert secret_transcript not in json.dumps(corpus["metadata"])


def test_copilot_home_resolves_from_environment_or_default(
    extract_corpus,
    tmp_path,
    monkeypatch,
):
    copilot_home = tmp_path / "copilot-home"
    monkeypatch.setenv("COPILOT_HOME", str(copilot_home))
    assert extract_corpus.resolve_copilot_store_path() == copilot_home

    monkeypatch.delenv("COPILOT_HOME", raising=False)
    monkeypatch.setattr(extract_corpus.Path, "home", lambda: tmp_path)
    assert extract_corpus.resolve_copilot_store_path() == tmp_path / ".copilot"


def test_opencode_sqlite_store_extracts_ordered_turns_and_history_prompts(
    tmp_path,
    extract_corpus,
):
    project_root = tmp_path / "agentera"
    project_root.mkdir()
    db_path = _write_opencode_fixture(tmp_path / "opencode" / "opencode.db", project_root)

    corpus = extract_corpus.build_corpus(
        project_roots=[project_root],
        codex_sessions_dir=None,
        claude_projects_dir=None,
        opencode_conversations_dir=db_path.parent,
        copilot_conversations_dir=None,
    )

    statuses = {
        item["runtime"]: item for item in corpus["metadata"]["runtime_statuses"]
    }
    assert statuses["opencode"]["status"] == "ok"
    assert statuses["opencode"]["reason"] == "records_extracted"
    assert statuses["opencode"]["candidate_count"] == 1
    assert statuses["opencode"]["record_count"] == 4
    opencode_turns = [
        record
        for record in corpus["records"]
        if record["runtime"] == "opencode"
        and record["source_kind"] == "conversation_turn"
    ]
    assert [turn["data"]["actor"] for turn in opencode_turns] == [
        "assistant",
        "user",
        "assistant",
    ]
    user_turn = opencode_turns[1]
    assert user_turn["session_id"] == "open-1"
    assert user_turn["project_path"] == str(project_root)
    assert user_turn["data"]["signal_type"] == "question"
    assert user_turn["data"]["preceding_context"] == "Use the existing runtime contract."
    prompts = [
        record
        for record in corpus["records"]
        if record["runtime"] == "opencode" and record["source_kind"] == "history_prompt"
    ]
    assert len(prompts) == 1
    assert prompts[0]["data"] == {
        "prompt": "Should we keep OpenCode local-only?",
        "signal_type": "question",
    }


def test_opencode_unavailable_degrades_while_other_runtimes_continue(
    tmp_path,
    extract_corpus,
):
    project_root = tmp_path / "agentera"
    project_root.mkdir()
    sessions_dir = tmp_path / "codex" / "sessions"
    _write_codex_fixture(sessions_dir, project_root)

    corpus = extract_corpus.build_corpus(
        project_roots=[project_root],
        codex_sessions_dir=sessions_dir,
        claude_projects_dir=None,
        opencode_conversations_dir=tmp_path / "missing-opencode.db",
        copilot_conversations_dir=None,
    )

    statuses = {
        item["runtime"]: item for item in corpus["metadata"]["runtime_statuses"]
    }
    assert statuses["opencode"]["status"] == "missing"
    assert statuses["opencode"]["reason"] == "store_absent"
    assert statuses["codex"]["status"] == "ok"
    assert corpus["metadata"]["families"]["conversation_turn"]["count"] == 2


def test_runtime_discovery_reports_locked_store(tmp_path, extract_corpus, monkeypatch):
    locked = tmp_path / "locked"
    locked.mkdir()

    def locked_rglob(self, pattern):
        if self == locked:
            raise PermissionError("locked")
        return []

    monkeypatch.setattr(extract_corpus.Path, "rglob", locked_rglob)

    status = extract_corpus.discover_runtime_store("codex", locked)

    assert status["status"] == "degraded"
    assert status["reason"] == "store_locked"


def test_agentera_home_precedence_for_profile_storage(extract_corpus, tmp_path, monkeypatch):
    app_home = tmp_path / "agentera-home"
    xdg_home = tmp_path / "xdg"
    monkeypatch.setenv("AGENTERA_HOME", str(app_home))
    monkeypatch.setenv("XDG_DATA_HOME", str(xdg_home))
    monkeypatch.delenv("PROFILERA_PROFILE_DIR", raising=False)
    monkeypatch.setattr(extract_corpus.sys, "platform", "linux")

    assert extract_corpus.default_profile_dir() == app_home
    assert extract_corpus.default_output_path() == app_home / "intermediate" / "corpus.json"


def test_platform_profile_home_fallbacks_when_agentera_home_absent(
    extract_corpus,
    tmp_path,
    monkeypatch,
):
    monkeypatch.delenv("AGENTERA_HOME", raising=False)
    monkeypatch.delenv("PROFILERA_PROFILE_DIR", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    monkeypatch.setattr(extract_corpus.sys, "platform", "linux")
    assert extract_corpus.default_profile_dir() == tmp_path / "xdg" / "agentera"

    monkeypatch.setattr(extract_corpus.sys, "platform", "darwin")
    assert extract_corpus.default_profile_dir().parts[-3:] == (
        "Library",
        "Application Support",
        "agentera",
    )

    monkeypatch.setattr(extract_corpus.sys, "platform", "win32")
    monkeypatch.setenv("APPDATA", str(tmp_path / "AppData" / "Roaming"))
    assert extract_corpus.default_profile_dir() == tmp_path / "AppData" / "Roaming" / "agentera"


def test_cross_runtime_fixtures_emit_expected_normalized_records(
    tmp_path,
    extract_corpus,
):
    project_root = tmp_path / "agentera"
    project_root.mkdir()
    (project_root / "AGENTS.md").write_text("Prefer evidence-first execution.\n", encoding="utf-8")
    (project_root / "package.json").write_text(
        json.dumps({"name": "agentera", "scripts": {"test": "pytest"}}),
        encoding="utf-8",
    )
    codex_dir = tmp_path / "codex" / "sessions"
    claude_dir = tmp_path / "claude" / "projects"
    opencode_db = tmp_path / "opencode" / "opencode.db"
    copilot_db = tmp_path / "copilot" / "session-store.db"
    _write_codex_fixture(codex_dir, project_root)
    _write_claude_fixture(claude_dir, project_root)
    _write_opencode_fixture(opencode_db, project_root)
    _write_copilot_fixture(copilot_db, project_root)

    corpus = extract_corpus.build_corpus(
        project_roots=[project_root],
        codex_sessions_dir=codex_dir,
        claude_projects_dir=claude_dir,
        opencode_conversations_dir=opencode_db.parent,
        copilot_conversations_dir=copilot_db.parent,
    )

    for runtime in ("claude-code", "codex", "opencode", "github-copilot"):
        status = _assert_runtime_status(corpus, runtime, "ok", "records_extracted")
        assert status["record_count"] > 0, f"no runtime records: runtime={runtime}"

    counts = _runtime_family_counts(corpus)
    expected_counts = {
        ("filesystem", "instruction_document"): 1,
        ("filesystem", "project_config_signal"): 1,
        ("claude-code", "conversation_turn"): 2,
        ("claude-code", "history_prompt"): 1,
        ("codex", "conversation_turn"): 2,
        ("codex", "history_prompt"): 1,
        ("opencode", "conversation_turn"): 3,
        ("opencode", "history_prompt"): 1,
        ("github-copilot", "conversation_turn"): 4,
        ("github-copilot", "history_prompt"): 1,
    }
    for key, expected in expected_counts.items():
        assert counts.get(key) == expected, (
            f"unexpected family count: runtime={key[0]} family={key[1]} "
            f"count={counts.get(key, 0)} expected={expected}"
        )

    runtime_order = {
        runtime: [
            record["data"]["actor"]
            for record in corpus["records"]
            if record["runtime"] == runtime
            and record["source_kind"] == "conversation_turn"
        ]
        for runtime in ("claude-code", "codex", "opencode", "github-copilot")
    }
    assert runtime_order == {
        "claude-code": ["assistant", "user"],
        "codex": ["user", "assistant"],
        "opencode": ["assistant", "user", "assistant"],
        "github-copilot": ["assistant", "user", "assistant", "assistant"],
    }


def test_cross_runtime_degradation_fixtures_continue_without_transcript_leak(
    tmp_path,
    extract_corpus,
    monkeypatch,
):
    project_root = tmp_path / "agentera"
    project_root.mkdir()
    codex_divergent = tmp_path / "codex-divergent"
    codex_divergent.mkdir()
    claude_sparse = tmp_path / "claude-sparse"
    claude_sparse.mkdir()
    opencode_locked = tmp_path / "opencode-locked"
    opencode_locked.mkdir()
    copilot_missing = tmp_path / "copilot-missing"
    secret_transcript = "private transcript payload must not appear in metadata"
    (codex_divergent / "session.jsonl").write_text(
        "{not json " + secret_transcript + "}\n",
        encoding="utf-8",
    )

    original_rglob = extract_corpus.Path.rglob

    def locked_rglob(self, pattern):
        if self == opencode_locked:
            raise PermissionError("locked")
        return original_rglob(self, pattern)

    monkeypatch.setattr(extract_corpus.Path, "rglob", locked_rglob)

    corpus = extract_corpus.build_corpus(
        project_roots=[project_root],
        codex_sessions_dir=codex_divergent,
        claude_projects_dir=claude_sparse,
        opencode_conversations_dir=opencode_locked,
        copilot_conversations_dir=copilot_missing,
    )

    _assert_runtime_status(corpus, "codex", "degraded", "schema_divergent")
    _assert_runtime_status(corpus, "claude-code", "sparse", "no_candidate_files")
    _assert_runtime_status(corpus, "opencode", "degraded", "store_locked")
    copilot_status = _assert_runtime_status(
        corpus,
        "github-copilot",
        "missing",
        "store_absent",
    )
    assert copilot_status["remediation_labels"] == ["/chronicle reindex"]
    assert corpus["metadata"]["total_records"] == 0
    assert secret_transcript not in json.dumps(corpus["metadata"])
