#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Shared JSON payload measurement helpers for maintainer benchmark scripts."""

from __future__ import annotations

import re
import shlex
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from typing import Any, Callable

CAPABILITIES = [
    "hej",
    "visionera",
    "resonera",
    "inspirera",
    "planera",
    "realisera",
    "optimera",
    "inspektera",
    "dokumentera",
    "profilera",
    "visualisera",
    "orkestrera",
]

DEFAULT_TOKEN_COUNTER_COMMAND = ["npx", "tiktoken-cli", "-m", "gpt-5"]


def token_counter_display(command: list[str]) -> str:
    return f"<output> | {shlex.join(command)}"


def count_gpt5_tokens(output: str, command: list[str]) -> int:
    with tempfile.TemporaryFile("w+", encoding="utf-8") as stream:
        stream.write(output)
        stream.seek(0)
        result = subprocess.run(
            command,
            stdin=stream,
            text=True,
            capture_output=True,
            check=False,
        )
    if result.returncode != 0:
        raise RuntimeError(f"token counter failed: {result.stderr.strip()}")
    match = re.search(r"^\s*(\d+)\s+", result.stdout, flags=re.MULTILINE)
    if not match:
        raise RuntimeError(f"token counter did not emit an integer: {result.stdout.strip()!r}")
    return int(match.group(1))


@dataclass(frozen=True)
class PayloadMeasurement:
    bytes: int
    gpt5_tokens: int | None
    token_status: str


def measure_payload(
    output: str,
    token_counter: Callable[[str], int] | None,
) -> PayloadMeasurement:
    token_count = token_counter(output) if token_counter else None
    return PayloadMeasurement(
        bytes=len(output.encode("utf-8")),
        gpt5_tokens=token_count,
        token_status="measured" if token_count is not None else "skipped",
    )


def payload_measurement_dict(measurement: PayloadMeasurement) -> dict[str, Any]:
    return asdict(measurement)
