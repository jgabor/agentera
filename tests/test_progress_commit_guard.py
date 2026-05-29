"""Regression tests for the progress commit-hash churn guard.

Two coordinated safeguards keep `.agentera/progress.yaml` cycle `commit`
fields honest and break the `git commit --amend` churn loop:

* the validator guard in ``hooks/validate_artifact.py``
  (``_validate_progress_commits``) flags hashes that resolve but are not
  ancestors of HEAD (the stale/self-referential signature); and
* the ``agentera check backfill`` CLI command that resets stale hashes to
  ``pending`` and forward-fills a known ancestor product commit.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = str(REPO_ROOT / "scripts" / "agentera")
HOOK_PATH = REPO_ROOT / "hooks" / "validate_artifact.py"

_GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, env=_GIT_ENV, check=True
    )


def _short(cwd: Path, rev: str = "HEAD") -> str:
    return subprocess.run(
        ["git", "rev-parse", "--short", rev],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def _progress_yaml(entries: list[tuple[int, str]]) -> str:
    lines = ["cycles:"]
    for number, commit in entries:
        lines += [
            f"- number: {number}",
            "  timestamp: 2026-01-01 00:00",
            "  type: chore",
            "  phase: build",
            f"  what: Cycle {number} work.",
            f"  commit: {commit}",
            "  discovered: None.",
            "  context:",
            "    intent: Exercise the commit guard.",
        ]
    return "\n".join(lines) + "\n"


@pytest.fixture()
def hook() -> ModuleType:
    spec = importlib.util.spec_from_file_location("validate_artifact", HOOK_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def progress_commit() -> ModuleType:
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "progress_commit", scripts_dir / "progress_commit.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    sys.modules["progress_commit"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def repo(tmp_path: Path) -> dict:
    """Repo where ``head`` is HEAD, ``ancestor`` is HEAD~1, and ``stale`` is a
    dangling commit that resolves but is not an ancestor of HEAD."""
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "user.name", "Test")
    _git(tmp_path, "config", "user.email", "test@example.com")
    _git(tmp_path, "config", "commit.gpgsign", "false")
    _git(tmp_path, "commit", "--allow-empty", "-q", "-m", "A")
    ancestor = _short(tmp_path)
    _git(tmp_path, "commit", "--allow-empty", "-q", "-m", "B")
    stale = _short(tmp_path)
    _git(tmp_path, "commit", "--amend", "--allow-empty", "-q", "-m", "B-prime")
    head = _short(tmp_path)
    assert stale != head
    (tmp_path / ".agentera").mkdir()
    return {"path": tmp_path, "ancestor": ancestor, "stale": stale, "head": head}


def _run_cli(repo: dict, *args: str) -> subprocess.CompletedProcess:
    env = {
        **os.environ,
        "AGENTERA_HOME": str(REPO_ROOT),
        "XDG_DATA_HOME": str(repo["path"] / ".xdg"),
        "PROFILERA_PROFILE_DIR": str(repo["path"] / ".xdg" / "agentera"),
    }
    return subprocess.run(
        [sys.executable, CLI, *args],
        cwd=repo["path"],
        capture_output=True,
        text=True,
        env=env,
    )


# ── Validator guard (A) ────────────────────────────────────────────


class TestProgressCommitGuard:
    def test_ancestor_and_pending_are_accepted(self, hook, repo):
        content = _progress_yaml([(2, repo["head"]), (1, repo["ancestor"]), (0, "pending")])
        assert hook._validate_progress_commits(content, str(repo["path"])) == []

    def test_stale_hash_is_flagged(self, hook, repo):
        content = _progress_yaml([(1, repo["stale"])])
        violations = hook._validate_progress_commits(content, str(repo["path"]))
        assert len(violations) == 1
        assert repo["stale"] in violations[0]
        assert "not an ancestor of HEAD" in violations[0]
        assert "backfill" in violations[0]

    def test_hash_with_subject_suffix_uses_leading_token(self, hook, repo):
        content = _progress_yaml([(1, f"{repo['stale']} amended away")])
        violations = hook._validate_progress_commits(content, str(repo["path"]))
        assert len(violations) == 1
        assert repo["stale"] in violations[0]

    def test_na_value_is_exempt(self, hook, repo):
        content = _progress_yaml([(1, "N/A no product commit")])
        assert hook._validate_progress_commits(content, str(repo["path"])) == []

    def test_unknown_hash_is_not_flagged(self, hook, repo):
        # A hash from another clone / shallow history must not be a false positive.
        content = _progress_yaml([(1, "deadbeefdead")])
        assert hook._validate_progress_commits(content, str(repo["path"])) == []

    def test_non_git_directory_is_not_flagged(self, hook, tmp_path):
        content = _progress_yaml([(1, "0123abc")])
        assert hook._validate_progress_commits(content, str(tmp_path)) == []

    def test_guard_is_wired_into_validate_explicit(self, hook, repo):
        path = repo["path"] / ".agentera" / "progress.yaml"
        path.write_text(_progress_yaml([(1, repo["stale"])]), encoding="utf-8")
        violations = hook.ArtifactSchemaValidator().validate_explicit(
            "PROGRESS.md", str(path), str(repo["path"])
        )
        assert any("not an ancestor of HEAD" in v for v in violations)


# ── Pure rewrite + token helpers (shared progress_commit module) ───


class TestRewriteCycleCommits:
    def test_replaces_single_line_commit(self, progress_commit):
        text = _progress_yaml([(2, "aaaaaaa"), (1, "bbbbbbb")])
        out = progress_commit.rewrite_cycle_commits(text, {1: "pending"})
        data = yaml.safe_load(out)
        commits = {c["number"]: c["commit"] for c in data["cycles"]}
        assert commits == {2: "aaaaaaa", 1: "pending"}

    def test_drops_multiline_scalar_continuation(self, progress_commit):
        # A hash wrapped with a subject across a deeper-indented line.
        text = (
            "cycles:\n"
            "- number: 5\n"
            "  type: chore\n"
            "  commit: b78a417\n"
            "    plan'\n"
            "  discovered: None.\n"
        )
        out = progress_commit.rewrite_cycle_commits(text, {5: "pending"})
        assert "plan'" not in out
        data = yaml.safe_load(out)
        assert data["cycles"][0]["commit"] == "pending"
        assert data["cycles"][0]["discovered"] == "None."

    def test_leaves_untargeted_cycles_and_archive_untouched(self, progress_commit):
        text = (
            "cycles:\n"
            "- number: 2\n"
            "  commit: aaaaaaa\n"
            "- number: 1\n"
            "  commit: bbbbbbb\n"
            "archive:\n"
            "- summary: 'commit: ccccccc kept verbatim'\n"
        )
        out = progress_commit.rewrite_cycle_commits(text, {2: "pending"})
        assert "commit: ccccccc kept verbatim" in out
        data = yaml.safe_load(out)
        commits = {c["number"]: c["commit"] for c in data["cycles"]}
        assert commits == {2: "pending", 1: "bbbbbbb"}


class TestBackfillCommitToken:
    @pytest.mark.parametrize(
        "value,expected",
        [
            ("abc1234", "abc1234"),
            ("abc1234 Speed up suite", "abc1234"),
            ("pending", None),
            ("pending plan'", None),
            ("N/A: docs only", None),
            ("notahash subject", None),
            (123, None),
            ("", None),
        ],
    )
    def test_token_extraction(self, progress_commit, value, expected):
        assert progress_commit.commit_token(value) == expected


# ── check backfill command (B) ─────────────────────────────────────


class TestBackfillCommand:
    def _write(self, repo: dict, entries: list[tuple[int, str]]) -> Path:
        path = repo["path"] / ".agentera" / "progress.yaml"
        path.write_text(_progress_yaml(entries), encoding="utf-8")
        return path

    def test_check_mode_reports_stale_and_exits_one(self, repo):
        self._write(repo, [(2, repo["head"]), (1, repo["stale"]), (0, "pending")])
        result = _run_cli(repo, "check", "backfill", "--format", "json")
        assert result.returncode == 1, result.stderr
        payload = json.loads(result.stdout)
        assert payload["status"] == "action-needed"
        assert payload["changes"] == {"1": "pending"}

    def test_fix_mode_resets_stale_to_pending(self, repo):
        path = self._write(repo, [(2, repo["head"]), (1, repo["stale"])])
        result = _run_cli(repo, "check", "backfill", "--mode", "fix", "--format", "json")
        assert result.returncode == 0, result.stderr
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        commits = {c["number"]: c["commit"] for c in data["cycles"]}
        assert commits == {2: repo["head"], 1: "pending"}

    def test_clean_when_all_commits_are_ancestors(self, repo):
        self._write(repo, [(1, repo["ancestor"]), (0, "pending")])
        result = _run_cli(repo, "check", "backfill", "--format", "json")
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout)["status"] == "clean"

    def test_forward_fill_sets_known_ancestor_commit(self, repo):
        path = self._write(repo, [(2, repo["head"]), (1, "pending")])
        result = _run_cli(
            repo, "check", "backfill", "--mode", "fix",
            "--cycle", "1", "--commit", repo["ancestor"], "--format", "json",
        )
        assert result.returncode == 0, result.stderr
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        commits = {c["number"]: c["commit"] for c in data["cycles"]}
        assert commits[1] == repo["ancestor"]

    def test_refuses_non_ancestor_commit(self, repo):
        self._write(repo, [(1, "pending")])
        result = _run_cli(repo, "check", "backfill", "--commit", repo["stale"], "--format", "json")
        assert result.returncode == 2, result.stdout
        payload = json.loads(result.stdout)
        assert payload["status"] == "error"
        assert "stale" in payload["message"]

    def test_refuses_unknown_commit(self, repo):
        self._write(repo, [(1, "pending")])
        result = _run_cli(repo, "check", "backfill", "--commit", "deadbeefdead", "--format", "json")
        assert result.returncode == 2, result.stdout
        assert json.loads(result.stdout)["status"] == "error"
