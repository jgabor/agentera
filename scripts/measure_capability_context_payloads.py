#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Measure slim capability-context payload bytes and GPT-5 tokens."""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from measure_json_common import (  # noqa: E402
    CAPABILITIES,
    DEFAULT_TOKEN_COUNTER_COMMAND,
    count_gpt5_tokens,
    measure_payload,
    token_counter_display,
)
DEFAULT_LOCAL_BENCHMARK_COMMAND = (
    "uv run scripts/measure_capability_context_payloads.py --json --enforce-budgets"
)

GENERIC_BUDGET = {"bytes": 8_000, "tokens": 2_000}
BUDGETS = {
    "hej": GENERIC_BUDGET,
    "visionera": GENERIC_BUDGET,
    "resonera": GENERIC_BUDGET,
    "inspirera": GENERIC_BUDGET,
    "profilera": GENERIC_BUDGET,
    "visualisera": GENERIC_BUDGET,
    "planera": {"bytes": 12_000, "tokens": 3_000},
    "realisera": {"bytes": 20_000, "tokens": 5_000},
    "optimera": {"bytes": 20_000, "tokens": 5_000},
    "dokumentera": {"bytes": 20_000, "tokens": 5_000},
    "orkestrera": {"bytes": 16_000, "tokens": 4_000},
    "inspektera": {"bytes": 28_000, "tokens": 7_000},
}


@dataclass(frozen=True)
class Measurement:
    capability: str
    bytes: int
    gpt5_tokens: int | None
    byte_budget: int
    token_budget: int
    token_status: str


@dataclass(frozen=True)
class Violation:
    capability: str
    byte_count: int
    byte_budget: int
    token_count: int | None
    token_budget: int
    reasons: list[str]


def run_agentera_context(root: Path, capability: str) -> str:
    result = subprocess.run(
        [
            "uv",
            "run",
            "scripts/agentera",
            "hej",
            "--format",
            "json",
            "--capability-context",
            capability,
            "--context-profile",
            "slim",
            "--fields",
            "capability_context",
        ],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"agentera context failed for {capability}: {result.stderr.strip()}")
    return result.stdout


def _measurement(
    capability: str,
    output: str,
    token_counter: Callable[[str], int] | None,
) -> Measurement:
    budget = BUDGETS[capability]
    payload = measure_payload(output, token_counter)
    return Measurement(
        capability=capability,
        bytes=payload.bytes,
        gpt5_tokens=payload.gpt5_tokens,
        byte_budget=budget["bytes"],
        token_budget=budget["tokens"],
        token_status=payload.token_status,
    )


def _violation(measurement: Measurement) -> Violation | None:
    reasons: list[str] = []
    if measurement.bytes > measurement.byte_budget:
        reasons.append("bytes_exceeded")
    if measurement.gpt5_tokens is not None and measurement.gpt5_tokens > measurement.token_budget:
        reasons.append("tokens_exceeded")
    if not reasons:
        return None
    return Violation(
        capability=measurement.capability,
        byte_count=measurement.bytes,
        byte_budget=measurement.byte_budget,
        token_count=measurement.gpt5_tokens,
        token_budget=measurement.token_budget,
        reasons=reasons,
    )


def measure_payloads(
    outputs: dict[str, str],
    token_counter: Callable[[str], int] | None,
) -> tuple[list[Measurement], list[Violation]]:
    missing = [capability for capability in CAPABILITIES if capability not in outputs]
    if missing:
        raise ValueError(f"missing capability outputs: {', '.join(missing)}")
    measurements = [
        _measurement(capability, outputs[capability], token_counter)
        for capability in CAPABILITIES
    ]
    violations = [
        violation
        for measurement in measurements
        if (violation := _violation(measurement)) is not None
    ]
    return measurements, violations


def measure(root: Path, token_counter: Callable[[str], int] | None) -> tuple[list[Measurement], list[Violation]]:
    outputs = {
        capability: run_agentera_context(root, capability)
        for capability in CAPABILITIES
    }
    return measure_payloads(outputs, token_counter)


def payload(
    measurements: list[Measurement],
    violations: list[Violation],
    *,
    enforce_budgets: bool,
    token_counter_command: list[str],
    token_mode: str,
) -> dict:
    status = "fail" if enforce_budgets and violations else "pass"
    return {
        "command": "measure-capability-context-payloads",
        "status": status,
        "token_counter": {
            "mode": token_mode,
            "command": token_counter_display(token_counter_command),
            "local_benchmark_command": DEFAULT_LOCAL_BENCHMARK_COMMAND,
        },
        "capabilities": CAPABILITIES,
        "measurements": [asdict(measurement) for measurement in measurements],
        "violations": [asdict(violation) for violation in violations],
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure slim capability-context bytes and GPT-5 tokens.",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="repository root to measure",
    )
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    parser.add_argument(
        "--enforce-budgets",
        action="store_true",
        help="exit non-zero when any byte or measured GPT-5 token budget is exceeded",
    )
    parser.add_argument(
        "--token-mode",
        choices=["exact", "skip"],
        default="exact",
        help="exact runs `<output> | npx tiktoken-cli -m gpt-5`; skip records bytes only",
    )
    parser.add_argument(
        "--token-counter-command",
        default=shlex.join(DEFAULT_TOKEN_COUNTER_COMMAND),
        help="token counter command that reads payload text on stdin and emits an integer",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    token_counter_command = shlex.split(args.token_counter_command)
    token_counter = (
        (lambda output: count_gpt5_tokens(output, token_counter_command))
        if args.token_mode == "exact"
        else None
    )
    measurements, violations = measure(args.root, token_counter)
    result = payload(
        measurements,
        violations,
        enforce_budgets=args.enforce_budgets,
        token_counter_command=token_counter_command,
        token_mode=args.token_mode,
    )
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print("Capability context payload benchmark")
        print(f"token_counter={result['token_counter']['command']}")
        print(f"local_benchmark_command={DEFAULT_LOCAL_BENCHMARK_COMMAND}")
        for measurement in measurements:
            tokens = "skipped" if measurement.gpt5_tokens is None else str(measurement.gpt5_tokens)
            print(
                f"{measurement.capability}: bytes={measurement.bytes}/{measurement.byte_budget} "
                f"gpt5_tokens={tokens}/{measurement.token_budget}"
            )
        if violations:
            print("violations:")
            for violation in violations:
                print(
                    f"{violation.capability}: bytes={violation.byte_count}/{violation.byte_budget} "
                    f"gpt5_tokens={violation.token_count}/{violation.token_budget} "
                    f"reasons={','.join(violation.reasons)}"
                )
    return 1 if args.enforce_budgets and violations else 0


if __name__ == "__main__":
    raise SystemExit(main())
