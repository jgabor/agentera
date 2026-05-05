"""Tests for scripts/measure_token_payload.py."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_measure_groups_static_v2_payload(tmp_path, measure_token_payload):
    root = tmp_path
    _write(root / "skills" / "agentera" / "SKILL.md", "master")
    _write(root / "skills" / "agentera" / "protocol.yaml", "protocol")
    _write(root / "skills" / "agentera" / "capabilities" / "hej" / "prose.md", "prose")
    _write(root / "skills" / "agentera" / "capabilities" / "hej" / "schemas" / "triggers.yaml", "schema")

    measurement = measure_token_payload.measure(root)

    assert measurement.files == 4
    assert measurement.v2_bytes == len("masterprotocolproseschema")
    assert measurement.v1_baseline_bytes == measure_token_payload.V1_BASELINE_BYTES
    assert [group.name for group in measurement.groups] == [
        "master",
        "protocol",
        "prose",
        "capability_schemas",
    ]


def test_cli_json_outputs_measurement(tmp_path):
    root = tmp_path
    _write(root / "skills" / "agentera" / "SKILL.md", "master")
    _write(root / "skills" / "agentera" / "protocol.yaml", "protocol")

    result = subprocess.run(
        [
            sys.executable,
            "scripts/measure_token_payload.py",
            "--root",
            str(root),
            "--json",
        ],
        cwd=Path(__file__).resolve().parent.parent,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["files"] == 2
    assert payload["v2_bytes"] == len("masterprotocol")
