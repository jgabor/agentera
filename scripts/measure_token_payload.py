#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Measure the Agentera v2 static dispatch payload.

Decision 41 used a byte-count proxy for the token target:

- v1 baseline: all 12 v1 SKILL.md files plus SPEC.md
- v2 payload: master SKILL.md, protocol.yaml, 12 capability prose.md files,
  and 48 capability schema YAML files

This script re-runs the v2 side of that benchmark and compares it to the
recorded v1 baseline.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path

V1_BASELINE_BYTES = 352_213


@dataclass(frozen=True)
class Group:
    name: str
    files: int
    bytes: int


@dataclass(frozen=True)
class Measurement:
    v1_baseline_bytes: int
    v1_estimated_tokens: int
    v2_bytes: int
    v2_estimated_tokens: int
    delta_bytes: int
    delta_estimated_tokens: int
    reduction_percent: float
    files: int
    groups: list[Group]


def _size(paths: list[Path]) -> int:
    return sum(path.stat().st_size for path in paths)


def _existing(paths: list[Path]) -> list[Path]:
    return [path for path in paths if path.is_file()]


def _group(name: str, paths: list[Path]) -> Group:
    existing = _existing(paths)
    return Group(name=name, files=len(existing), bytes=_size(existing))


def measure(root: Path) -> Measurement:
    skill_root = root / "skills" / "agentera"
    capabilities = skill_root / "capabilities"
    groups = [
        _group("master", [skill_root / "SKILL.md"]),
        _group("protocol", [skill_root / "protocol.yaml"]),
        _group("prose", sorted(capabilities.glob("*/prose.md"))),
        _group("capability_schemas", sorted(capabilities.glob("*/schemas/*.yaml"))),
    ]
    v2_bytes = sum(group.bytes for group in groups)
    delta_bytes = v2_bytes - V1_BASELINE_BYTES
    return Measurement(
        v1_baseline_bytes=V1_BASELINE_BYTES,
        v1_estimated_tokens=V1_BASELINE_BYTES // 4,
        v2_bytes=v2_bytes,
        v2_estimated_tokens=v2_bytes // 4,
        delta_bytes=delta_bytes,
        delta_estimated_tokens=delta_bytes // 4,
        reduction_percent=round((-delta_bytes / V1_BASELINE_BYTES) * 100, 1),
        files=sum(group.files for group in groups),
        groups=groups,
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure Agentera v2 static dispatch payload bytes",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="repository root to measure",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="emit machine-readable JSON",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    measurement = measure(args.root)
    if args.json:
        print(json.dumps(asdict(measurement), indent=2))
        return 0
    print("Token payload benchmark")
    print(
        "v1_baseline_bytes=%d (~%d tokens)"
        % (measurement.v1_baseline_bytes, measurement.v1_estimated_tokens)
    )
    print(
        "v2_bytes=%d (~%d tokens)"
        % (measurement.v2_bytes, measurement.v2_estimated_tokens)
    )
    print(
        "delta_bytes=%d (~%d tokens)"
        % (measurement.delta_bytes, measurement.delta_estimated_tokens)
    )
    print(f"reduction={measurement.reduction_percent:.1f}%")
    print(f"files={measurement.files}")
    for group in measurement.groups:
        print(f"{group.name}: files={group.files} bytes={group.bytes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
