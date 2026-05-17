from __future__ import annotations

import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / "scripts" / "agentera"


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_readme_documents_helper_script_classification_policy() -> None:
    readme = _read("README.md")

    assert "Helper Script Classification Policy" in readme
    assert "`uv run scripts/agentera ...` is the canonical documented entry point" in readme
    assert "Backward-compatible maintainer seam" in readme
    assert "Internal support module" in readme
    assert "agentera stats refresh --consent local-history" in readme
    assert "no top-level `agentera corpus` command" in readme


def test_user_facing_docs_prefer_agentera_validate_namespace() -> None:
    readme = _read("README.md")
    upgrade = _read("UPGRADE.md")
    agents = _read("AGENTS.md")

    assert "uv run scripts/agentera validate capability-contract --format json" in readme
    assert "uv run scripts/agentera validate capability <name-or-path>" in readme
    assert "uv run scripts/agentera validate capability <name-or-path>" in agents
    assert "uv run scripts/agentera validate capability <name-or-path>" in upgrade
    assert "uv run scripts/validate_capability.py skills/agentera/capabilities/<name>" not in readme
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
    assert "agentera stats refresh --dry-run" in _read("README.md")
    assert "agentera stats refresh --consent local-history" in _read("README.md")
