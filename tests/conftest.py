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
def validate_spec():
    """Load scripts/validate_spec.py (handles both hyphenated and underscored)."""
    return _load_module(
        "validate_spec",
        REPO_ROOT / "scripts" / "validate_spec.py",
    )


@pytest.fixture(scope="session")
def analyze_progress():
    """Load skills/realisera/scripts/analyze_progress.py."""
    return _load_module(
        "analyze_progress",
        REPO_ROOT / "skills" / "realisera" / "scripts" / "analyze_progress.py",
    )


@pytest.fixture(scope="session")
def analyze_experiments():
    """Load skills/optimera/scripts/analyze_experiments.py."""
    return _load_module(
        "analyze_experiments",
        REPO_ROOT / "skills" / "optimera" / "scripts" / "analyze_experiments.py",
    )


@pytest.fixture(scope="session")
def effective_profile():
    """Load skills/profilera/scripts/effective_profile.py."""
    return _load_module(
        "effective_profile",
        REPO_ROOT / "skills" / "profilera" / "scripts" / "effective_profile.py",
    )


@pytest.fixture(scope="session")
def validate_design():
    """Load skills/visualisera/scripts/validate_design.py."""
    return _load_module(
        "validate_design",
        REPO_ROOT / "skills" / "visualisera" / "scripts" / "validate_design.py",
    )


@pytest.fixture(scope="session")
def extract_all():
    """Load skills/profilera/scripts/extract_all.py."""
    return _load_module(
        "extract_all",
        REPO_ROOT / "skills" / "profilera" / "scripts" / "extract_all.py",
    )


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
def session_stop(hooks_common):
    """Load hooks/session_stop.py (depends on hooks/common.py)."""
    return _load_module(
        "session_stop",
        REPO_ROOT / "hooks" / "session_stop.py",
    )
