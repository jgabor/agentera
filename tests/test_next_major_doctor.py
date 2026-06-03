"""Regression tests for the next-major doctor section."""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path
from types import ModuleType

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))


def _load_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_load_module("yaml_mapping", SCRIPTS / "yaml_mapping.py")
next_major_doctor = _load_module("next_major_doctor", SCRIPTS / "next_major_doctor.py")
NEXT_MAJOR_LINE_CAP = next_major_doctor.NEXT_MAJOR_LINE_CAP
NEXT_MAJOR_SECTION_HEADER = next_major_doctor.NEXT_MAJOR_SECTION_HEADER
V1_NEXT_MAJOR_FALLBACK = next_major_doctor.V1_NEXT_MAJOR_FALLBACK
format_next_major_doctor_lines = next_major_doctor.format_next_major_doctor_lines
load_channel_next_major = next_major_doctor.load_channel_next_major
prepend_next_major_doctor_section = next_major_doctor.prepend_next_major_doctor_section
resolve_next_major_doctor_lines = next_major_doctor.resolve_next_major_doctor_lines


def test_stable_next_major_reachable_from_authority() -> None:
    block = load_channel_next_major(REPO_ROOT, "stable")
    assert block is not None
    assert block["version"] == "3.0.0"


def test_development_omits_next_major() -> None:
    assert load_channel_next_major(REPO_ROOT, "development") is None


def test_resolve_renders_six_lines_for_stable() -> None:
    lines = resolve_next_major_doctor_lines(
        source_root=REPO_ROOT,
        channel="stable",
        running_version="2.7.8",
        running_distribution_major=2,
    )
    assert lines is not None
    assert len(lines) == NEXT_MAJOR_LINE_CAP


def test_v1_hardcoded_fallback() -> None:
    lines = resolve_next_major_doctor_lines(
        source_root=REPO_ROOT,
        channel="stable",
        running_version="1.18.0",
        running_distribution_major=1,
    )
    assert lines is not None
    assert lines[1] == f"Current: {V1_NEXT_MAJOR_FALLBACK['current_version']} (stable channel)"


def test_prepend_places_section_before_doctor_body() -> None:
    section = resolve_next_major_doctor_lines(
        source_root=REPO_ROOT,
        channel="stable",
        running_version="2.7.8",
        running_distribution_major=2,
    )
    text = prepend_next_major_doctor_section("Agentera doctor\n", section)
    assert text.startswith(f"{NEXT_MAJOR_SECTION_HEADER}\n")
