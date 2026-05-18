from __future__ import annotations

import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / "scripts" / "agentera"


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_agents_documents_helper_script_classification_policy() -> None:
    agents = _read("AGENTS.md")

    assert "Helper script classification" in agents
    assert "`uv run scripts/agentera ...` is the canonical documented entry point" in agents
    assert "Backward-compatible maintainer seam" in agents
    assert "Internal support module" in agents
    assert "stats refresh consent" in agents


def test_user_facing_docs_prefer_agentera_validate_namespace() -> None:
    readme = _read("README.md")
    upgrade = _read("UPGRADE.md")
    agents = _read("AGENTS.md")

    assert "uv run scripts/agentera validate capability-contract --format json" in readme
    assert "uv run scripts/agentera validate capability <name-or-path>" in readme
    assert "uv run scripts/agentera validate capability <name-or-path>" in agents
    assert "uv run scripts/agentera validate capability <name-or-path>" in upgrade
    assert "uv run scripts/validate_capability.py skills/agentera/capabilities/<name>" not in agents


def test_corpus_generation_remains_internal_behind_stats_refresh() -> None:
    result = subprocess.run(
        [sys.executable, str(CLI), "corpus", "--help"],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert "stats refresh consent" in _read("AGENTS.md")
