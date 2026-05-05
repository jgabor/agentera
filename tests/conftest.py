"""Shared fixtures that load script modules via importlib for robust imports.

Handles both hyphenated and underscored filenames by using
importlib.util.spec_from_file_location which sidesteps Python's module naming rules.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_module(name: str, file_path: Path) -> ModuleType:
    """Load a Python file as a module regardless of filename conventions.

    If ``file_path`` does not exist, tries the alternate naming convention
    (hyphen <-> underscore) so the fixture works regardless of which rename
    has been applied.
    """
    if not file_path.exists():
        stem = file_path.stem
        alt_stem = stem.replace("-", "_") if "-" in stem else stem.replace("_", "-")
        alt_path = file_path.with_name(alt_stem + file_path.suffix)
        if alt_path.exists():
            file_path = alt_path
    spec = importlib.util.spec_from_file_location(name, file_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {file_path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="session")
def eval_skills():
    """Load scripts/eval_skills.py."""
    return _load_module(
        "eval_skills",
        REPO_ROOT / "scripts" / "eval_skills.py",
    )


@pytest.fixture(scope="session")
def semantic_fixtures():
    """Load scripts/semantic_fixtures.py."""
    return _load_module(
        "semantic_fixtures",
        REPO_ROOT / "scripts" / "semantic_fixtures.py",
    )


@pytest.fixture(scope="session")
def semantic_eval(semantic_fixtures):
    """Load scripts/semantic_eval.py."""
    return _load_module(
        "semantic_eval",
        REPO_ROOT / "scripts" / "semantic_eval.py",
    )


@pytest.fixture(scope="session")
def generate_contracts():
    """Load scripts/generate_contracts.py."""
    return _load_module(
        "generate_contracts",
        REPO_ROOT / "scripts" / "generate_contracts.py",
    )


@pytest.fixture(scope="session")
def usage_stats():
    """Load scripts/usage_stats.py."""
    return _load_module(
        "usage_stats",
        REPO_ROOT / "scripts" / "usage_stats.py",
    )


@pytest.fixture(scope="session")
def extract_corpus():
    """Load scripts/extract_corpus.py."""
    return _load_module(
        "extract_corpus",
        REPO_ROOT / "scripts" / "extract_corpus.py",
    )


@pytest.fixture(scope="session")
def measure_token_payload():
    """Load scripts/measure_token_payload.py."""
    return _load_module(
        "measure_token_payload",
        REPO_ROOT / "scripts" / "measure_token_payload.py",
    )


@pytest.fixture(scope="session")
def hooks_common():
    """Load hooks/common.py."""
    return _load_module(
        "common",
        REPO_ROOT / "hooks" / "common.py",
    )


@pytest.fixture(scope="session")
def session_start(hooks_common):
    """Load hooks/session_start.py (depends on hooks/common.py)."""
    return _load_module(
        "session_start",
        REPO_ROOT / "hooks" / "session_start.py",
    )


@pytest.fixture(scope="session")
def compaction():
    """Load hooks/compaction.py."""
    return _load_module(
        "compaction",
        REPO_ROOT / "hooks" / "compaction.py",
    )


@pytest.fixture(scope="session")
def session_stop(hooks_common, compaction):
    """Load hooks/session_stop.py (depends on hooks/common.py and hooks/compaction.py)."""
    return _load_module(
        "session_stop",
        REPO_ROOT / "hooks" / "session_stop.py",
    )
