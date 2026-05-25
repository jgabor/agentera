from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / "scripts" / "agentera"
USAGE_STATS = REPO_ROOT / "scripts" / "usage_stats.py"


def _turn(
    source_id: str,
    timestamp: str,
    actor: str,
    content: str,
    *,
    project_id: str = "agentera",
    session_id: str = "session-1",
) -> dict:
    return {
        "source_id": source_id,
        "session_id": session_id,
        "timestamp": timestamp,
        "project_id": project_id,
        "source_kind": "conversation_turn",
        "runtime": "claude-code",
        "adapter_version": "test",
        "data": {"actor": actor, "content": content},
    }


def _corpus() -> dict:
    return {
        "metadata": {"extracted_at": "2026-05-15T00:00:00Z"},
        "records": [
            _turn("u1", "2026-05-15T00:00:00Z", "user", "/realisera"),
            _turn(
                "a1",
                "2026-05-15T00:00:01Z",
                "assistant",
                "─── ⧉ realisera · cycle 1 ───",
            ),
            _turn(
                "a2",
                "2026-05-15T00:00:02Z",
                "assistant",
                "─── ⧉ realisera · complete ───",
            ),
            _turn(
                "u2",
                "2026-05-15T00:01:00Z",
                "user",
                "please plan",
                project_id="other-project",
                session_id="session-2",
            ),
            _turn(
                "a3",
                "2026-05-15T00:01:01Z",
                "assistant",
                "─── ≡ planera · planning ───",
                project_id="other-project",
                session_id="session-2",
            ),
        ],
    }


def _write_default_corpus(profile_dir: Path) -> Path:
    corpus_path = profile_dir / "intermediate" / "corpus.json"
    corpus_path.parent.mkdir(parents=True)
    corpus_path.write_text(json.dumps(_corpus()), encoding="utf-8")
    return corpus_path


def _run_cli(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        cwd=REPO_ROOT,
        env=full_env,
        text=True,
        capture_output=True,
        check=False,
    )


def _run_usage_stats(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    return subprocess.run(
        [sys.executable, str(USAGE_STATS), *args],
        cwd=REPO_ROOT,
        env=full_env,
        text=True,
        capture_output=True,
        check=False,
    )


def test_usage_text_output_writes_report_to_isolated_usage_dir(tmp_path: Path) -> None:
    profile_dir = tmp_path / "profile"
    usage_dir = tmp_path / "usage"
    _write_default_corpus(profile_dir)

    result = _run_cli(
        "usage",
        env={"PROFILERA_PROFILE_DIR": str(profile_dir), "AGENTERA_USAGE_DIR": str(usage_dir)},
    )

    report_path = usage_dir / "USAGE.md"
    assert result.returncode == 0, result.stderr
    assert "Suite usage · scope: all projects" in result.stdout
    assert "Skills observed: 2" in result.stdout
    assert f"Report: {report_path}" in result.stdout
    assert report_path.is_file()
    report = report_path.read_text(encoding="utf-8")
    assert "| realisera | 1 |" in report
    assert "| other-project | planera | 1 | 0 | 1 |" in report


def test_usage_json_preserves_direct_payload_and_does_not_write_report(tmp_path: Path) -> None:
    profile_dir = tmp_path / "profile"
    usage_dir = tmp_path / "usage"
    corpus_path = _write_default_corpus(profile_dir)

    result = _run_cli(
        "usage",
        "--format",
        "json",
        "--corpus",
        str(corpus_path),
        env={"PROFILERA_PROFILE_DIR": str(profile_dir), "AGENTERA_USAGE_DIR": str(usage_dir)},
    )
    payload = json.loads(result.stdout)

    assert result.returncode == 0, result.stderr
    assert set(payload) == {"generated_at", "extracted_at", "project_filter", "skills", "per_project", "invocations"}
    assert payload["extracted_at"] == "2026-05-15T00:00:00Z"
    assert payload["skills"]["realisera"]["completed"] == 1
    assert payload["skills"]["planera"]["incomplete"] == 1
    assert not (usage_dir / "USAGE.md").exists()


def test_usage_project_filter_keeps_unmatched_project_as_empty_report(tmp_path: Path) -> None:
    profile_dir = tmp_path / "profile"
    usage_dir = tmp_path / "usage"
    corpus_path = _write_default_corpus(profile_dir)

    result = _run_cli(
        "usage",
        "--format",
        "json",
        "--corpus",
        str(corpus_path),
        "--project",
        "missing-project",
        env={"PROFILERA_PROFILE_DIR": str(profile_dir), "AGENTERA_USAGE_DIR": str(usage_dir)},
    )
    payload = json.loads(result.stdout)

    assert result.returncode == 0, result.stderr
    assert payload["project_filter"] == "missing-project"
    assert payload["skills"] == {}
    assert payload["invocations"] == []
    assert not (usage_dir / "USAGE.md").exists()


def test_usage_missing_corpus_reuses_actionable_direct_script_guidance(tmp_path: Path) -> None:
    profile_dir = tmp_path / "profile"
    usage_dir = tmp_path / "usage"

    result = _run_cli(
        "usage",
        env={"PROFILERA_PROFILE_DIR": str(profile_dir), "AGENTERA_USAGE_DIR": str(usage_dir)},
    )

    assert result.returncode == 2
    assert result.stdout == ""
    assert "corpus.json not found" in result.stderr
    assert "Run uv run scripts/extract_corpus.py" in result.stderr
    assert "Provide --corpus <path> to an existing corpus.json" in result.stderr
    assert not (usage_dir / "USAGE.md").exists()


def test_usage_invalid_format_lists_valid_values_syntax_and_example() -> None:
    result = _run_cli("usage", "--format", "xml")

    assert result.returncode == 2
    assert result.stdout == ""
    assert "unsupported usage format 'xml'" in result.stderr
    assert "valid formats: text, json" in result.stderr
    assert "Syntax: agentera usage [--format text|json] [--corpus PATH] [--project VALUE]" in result.stderr
    assert "Example: agentera usage --format json --project agentera" in result.stderr


def test_usage_help_discovers_namespace_and_supported_flags() -> None:
    root_help = _run_cli("--help")
    usage_help = _run_cli("usage", "--help")

    assert root_help.returncode == usage_help.returncode == 0
    assert "report" in root_help.stdout
    assert "Generate suite usage analytics" in usage_help.stdout
    assert "agentera usage --format json --project agentera" in usage_help.stdout
    assert "--format" in usage_help.stdout
    assert "--corpus" in usage_help.stdout
    assert "--project" in usage_help.stdout


def test_usage_namespace_preserves_direct_script_json_behavior(tmp_path: Path) -> None:
    profile_dir = tmp_path / "profile"
    usage_dir = tmp_path / "usage"
    corpus_path = _write_default_corpus(profile_dir)
    env = {"PROFILERA_PROFILE_DIR": str(profile_dir), "AGENTERA_USAGE_DIR": str(usage_dir)}

    namespace = _run_cli("usage", "--format", "json", "--corpus", str(corpus_path), env=env)
    direct = _run_usage_stats("--json", "--corpus", str(corpus_path), env=env)
    namespace_payload = json.loads(namespace.stdout)
    direct_payload = json.loads(direct.stdout)

    assert namespace.returncode == direct.returncode == 0
    for key in ("extracted_at", "project_filter", "skills", "per_project", "invocations"):
        assert namespace_payload[key] == direct_payload[key]
    assert not (usage_dir / "USAGE.md").exists()


def test_stats_missing_corpus_points_to_refresh_dry_run_without_side_effects(tmp_path: Path) -> None:
    profile_dir = tmp_path / "profile"
    usage_dir = tmp_path / "usage"
    home_dir = tmp_path / "home"

    result = _run_cli(
        "stats",
        env={
            "HOME": str(home_dir),
            "PROFILERA_PROFILE_DIR": str(profile_dir),
            "AGENTERA_USAGE_DIR": str(usage_dir),
        },
    )

    assert result.returncode == 2
    assert result.stdout == ""
    assert "stats data missing" in result.stderr
    assert "Next: agentera stats refresh --dry-run" in result.stderr
    assert "Plain stats does not read local runtime history" in result.stderr
    assert not (profile_dir / "intermediate" / "corpus.json").exists()
    assert not (usage_dir / "USAGE.md").exists()


def test_stats_json_uses_existing_internal_corpus_without_corpus_flag(tmp_path: Path) -> None:
    profile_dir = tmp_path / "profile"
    usage_dir = tmp_path / "usage"
    _write_default_corpus(profile_dir)

    result = _run_cli(
        "stats",
        "--format",
        "json",
        env={"PROFILERA_PROFILE_DIR": str(profile_dir), "AGENTERA_USAGE_DIR": str(usage_dir)},
    )
    payload = json.loads(result.stdout)

    assert result.returncode == 0, result.stderr
    assert payload["extracted_at"] == "2026-05-15T00:00:00Z"
    assert payload["skills"]["realisera"]["completed"] == 1
    assert not (usage_dir / "USAGE.md").exists()


def test_stats_refresh_dry_run_reports_privacy_boundary_and_writes_nothing(tmp_path: Path) -> None:
    profile_dir = tmp_path / "profile"
    project_root = tmp_path / "project"
    project_root.mkdir()
    (project_root / "AGENTS.md").write_text("# test\n", encoding="utf-8")

    result = _run_cli(
        "stats",
        "refresh",
        "--dry-run",
        "--format",
        "json",
        "--project-root",
        str(project_root),
        env={"HOME": str(tmp_path / "home"), "PROFILERA_PROFILE_DIR": str(profile_dir)},
    )
    payload = json.loads(result.stdout)

    assert result.returncode == 0, result.stderr
    assert payload["status"] == "dry_run"
    assert payload["privacy"]["local_history_read"] is False
    assert payload["privacy"]["corpus_write"] is False
    assert payload["privacy"]["required_consent"] == "local-history"
    assert payload["corpus_path"] == str(profile_dir / "intermediate" / "corpus.json")
    assert "extract_corpus.py" in " ".join(payload["engine"]["command"])
    assert not (profile_dir / "intermediate" / "corpus.json").exists()


def test_stats_refresh_requires_explicit_local_history_consent(tmp_path: Path) -> None:
    result = _run_cli(
        "stats",
        "refresh",
        env={"HOME": str(tmp_path / "home"), "PROFILERA_PROFILE_DIR": str(tmp_path / "profile")},
    )

    assert result.returncode == 2
    assert "requires explicit --consent local-history" in result.stderr
    assert "agentera stats refresh --dry-run" in result.stderr


def test_stats_refresh_with_consent_builds_internal_corpus(tmp_path: Path) -> None:
    profile_dir = tmp_path / "profile"
    project_root = tmp_path / "project"
    project_root.mkdir()
    (project_root / "AGENTS.md").write_text("# test\n", encoding="utf-8")

    result = _run_cli(
        "stats",
        "refresh",
        "--consent",
        "local-history",
        "--format",
        "json",
        "--project-root",
        str(project_root),
        env={"HOME": str(tmp_path / "home"), "PROFILERA_PROFILE_DIR": str(profile_dir)},
    )
    payload = json.loads(result.stdout)
    corpus_path = profile_dir / "intermediate" / "corpus.json"

    assert result.returncode == 0, result.stderr
    assert payload["status"] == "pass"
    assert payload["privacy"]["local_history_read"] is True
    assert payload["privacy"]["corpus_write"] is True
    assert corpus_path.is_file()
    corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    assert corpus["metadata"]["total_records"] >= 1


def test_stats_help_preserves_usage_and_exposes_no_top_level_corpus_command() -> None:
    root_help = _run_cli("--help")
    stats_help = _run_cli("stats", "--help")
    report_help = _run_cli("report", "--help")
    corpus_help = _run_cli("corpus", "--help")

    assert root_help.returncode == stats_help.returncode == report_help.returncode == 0
    assert "report" in root_help.stdout
    assert "agentera stats" in stats_help.stdout
    assert "agentera report refresh --dry-run" in report_help.stdout
    assert "--consent" in report_help.stdout
    assert "corpus" not in {line.strip() for line in root_help.stdout.splitlines()}
    assert corpus_help.returncode != 0
