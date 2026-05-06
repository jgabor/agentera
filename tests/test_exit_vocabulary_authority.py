"""Validate exit signal vocabulary authority."""

from __future__ import annotations

import importlib.util
import sys
import textwrap
from pathlib import Path
from types import ModuleType

import pytest
import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
CAPABILITIES_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities"
PROTOCOL_PATH = REPO_ROOT / "skills" / "agentera" / "protocol.yaml"
VALIDATOR = REPO_ROOT / "scripts" / "validate_capability.py"

CANONICAL_EXIT_SIGNALS = {"complete", "flagged", "stuck", "waiting"}
STALE_EXIT_LABELS = {"blocked", "escalated", "partial"}


def _load_validator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("validate_capability_exit_tests", VALIDATOR)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


validate_capability = _load_validator()


def _protocol_exit_signals() -> set[str]:
    protocol = yaml.safe_load(PROTOCOL_PATH.read_text())
    return validate_capability.build_protocol_value_lookup(protocol)["EXIT_SIGNALS"]


def _capability_exit_files() -> list[Path]:
    return sorted(CAPABILITIES_DIR.glob("*/schemas/exit.yaml"))


def _write_capability(tmp_path: Path, exit_signal: str, extra_text: str = "") -> Path:
    cap_dir = tmp_path / "capability"
    schemas_dir = cap_dir / "schemas"
    schemas_dir.mkdir(parents=True)
    (cap_dir / "prose.md").write_text("# Fixture\n")
    (schemas_dir / "exit.yaml").write_text(
        textwrap.dedent(
            f"""\
            EXIT_CONDITIONS:
              1:
                id: E1
                condition: complete
                description: Fixture completed. {extra_text}
                status: blocked
                exit_signal: {exit_signal}
            """
        )
    )
    return cap_dir


def test_protocol_exit_signals_are_the_exact_authority():
    assert validate_capability.validate_protocol_self(PROTOCOL_PATH) == []
    assert _protocol_exit_signals() == CANONICAL_EXIT_SIGNALS
    assert _protocol_exit_signals().isdisjoint(STALE_EXIT_LABELS)


@pytest.mark.parametrize("exit_file", _capability_exit_files(), ids=lambda path: path.parent.parent.name)
def test_capability_exit_schemas_use_protocol_owned_exit_signals(exit_file: Path):
    protocol_signals = _protocol_exit_signals()
    data = yaml.safe_load(exit_file.read_text())
    entries = data["EXIT_CONDITIONS"].values()

    exit_signals = {entry["exit_signal"] for entry in entries}
    conditions = {entry["condition"] for entry in data["EXIT_CONDITIONS"].values()}

    assert exit_signals <= protocol_signals
    assert conditions <= protocol_signals
    assert exit_signals.isdisjoint(STALE_EXIT_LABELS)
    assert conditions.isdisjoint(STALE_EXIT_LABELS)


@pytest.mark.parametrize("stale_label", sorted(STALE_EXIT_LABELS))
def test_stale_labels_are_rejected_as_exit_signal_values(tmp_path: Path, stale_label: str):
    cap_dir = _write_capability(tmp_path, stale_label)

    assert validate_capability.check_primitive_references(cap_dir, PROTOCOL_PATH) == [
        f"[error]: E1 field exit_signal={stale_label!r} does not resolve to any protocol primitive "
        "in groups ['EXIT_SIGNALS']"
    ]


def test_stale_words_are_allowed_in_non_exit_task_status_contexts(tmp_path: Path):
    cap_dir = _write_capability(
        tmp_path,
        "complete",
        "Task status may mention blocked, escalated, or partial without defining exit vocabulary.",
    )

    assert validate_capability.check_primitive_references(cap_dir, PROTOCOL_PATH) == []
