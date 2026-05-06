#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
# ///
"""Validate cross-capability artifact producer/consumer consistency.

The registry owns canonical artifact identity and shared relationships. The
capability-local ``schemas/artifacts.yaml`` files declare local usage through
``artifact_id`` plus ``local_role`` references.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from artifact_registry import ArtifactRecord, load_artifact_registry


REPO_ROOT = Path(__file__).resolve().parent.parent
CAPABILITIES_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities"
ARTIFACT_SCHEMAS_DIR = REPO_ROOT / "skills" / "agentera" / "schemas" / "artifacts"


@dataclass(frozen=True)
class CanonicalArtifact:
    artifact_id: str
    display_name: str
    producers: set[str]
    consumers: set[str]


@dataclass(frozen=True)
class CapabilityArtifact:
    capability: str
    artifact_id: str
    display_name: str
    producers: set[str]
    consumers: set[str]


def _load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    return data if isinstance(data, dict) else {}


def load_canonical_artifacts(
    artifact_schemas_dir: Path = ARTIFACT_SCHEMAS_DIR,
) -> dict[str, CanonicalArtifact]:
    return {
        artifact_id: CanonicalArtifact(
            artifact_id=record.artifact_id,
            display_name=record.display_name,
            producers=record.producers,
            consumers=record.consumers,
        )
        for artifact_id, record in load_artifact_registry(artifact_schemas_dir).items()
    }


def load_capability_artifacts(
    capabilities_dir: Path = CAPABILITIES_DIR,
) -> list[CapabilityArtifact]:
    records: list[CapabilityArtifact] = []
    for cap_dir in sorted(p for p in capabilities_dir.iterdir() if p.is_dir()):
        artifact_path = cap_dir / "schemas" / "artifacts.yaml"
        if not artifact_path.is_file():
            continue
        data = _load_yaml(artifact_path)
        entries = data.get("ARTIFACTS", {})
        if not isinstance(entries, dict):
            continue
        for entry in entries.values():
            if not isinstance(entry, dict):
                continue
            artifact_id = str(entry.get("artifact_id", "")).strip()
            local_role = str(entry.get("local_role", "")).strip()
            if not artifact_id:
                continue
            produces = local_role in {"produces", "produces_and_consumes"}
            consumes = local_role in {"consumes", "produces_and_consumes"}
            records.append(CapabilityArtifact(
                capability=cap_dir.name,
                artifact_id=artifact_id,
                display_name=artifact_id,
                producers={cap_dir.name} if produces else set(),
                consumers={cap_dir.name} if consumes else set(),
            ))
    return records


def _display_name(record: CapabilityArtifact, registry: dict[str, ArtifactRecord]) -> str:
    artifact = registry.get(record.artifact_id)
    return artifact.display_name if artifact else record.artifact_id


def validate_graph(
    artifact_schemas_dir: Path = ARTIFACT_SCHEMAS_DIR,
    capabilities_dir: Path = CAPABILITIES_DIR,
) -> list[str]:
    registry = load_artifact_registry(artifact_schemas_dir)
    canonical = load_canonical_artifacts(artifact_schemas_dir)
    capability_artifacts = load_capability_artifacts(capabilities_dir)
    capability_names = {p.name for p in capabilities_dir.iterdir() if p.is_dir()}
    errors: list[str] = []

    by_artifact_id: dict[str, list[CapabilityArtifact]] = {}
    for record in capability_artifacts:
        by_artifact_id.setdefault(record.artifact_id, []).append(record)
        name = _display_name(record, registry)
        if record.artifact_id not in canonical:
            errors.append(f"{record.capability}: unknown artifact_id {record.artifact_id!r}")
            continue
        if not record.producers and not record.consumers:
            errors.append(
                f"{record.capability}: {name} neither produces nor consumes"
            )

    for artifact_id, artifact in canonical.items():
        records = by_artifact_id.get(artifact_id, [])
        produced_by = set().union(*(r.producers for r in records)) if records else set()
        consumed_by = set().union(*(r.consumers for r in records)) if records else set()
        schema_producers = artifact.producers & capability_names
        schema_consumers = artifact.consumers & capability_names
        if schema_producers and schema_producers != produced_by:
            errors.append(
                f"{artifact.display_name}: registry producers {sorted(schema_producers)} "
                f"do not match capability producers {sorted(produced_by)}"
            )
        if artifact.consumers and "all_skills" not in artifact.consumers and schema_consumers != consumed_by:
            errors.append(
                f"{artifact.display_name}: registry consumers {sorted(schema_consumers)} "
                f"do not match capability consumers {sorted(consumed_by)}"
            )

    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate Agentera capability artifact producer/consumer graph",
    )
    parser.add_argument(
        "--schemas-dir",
        type=Path,
        default=ARTIFACT_SCHEMAS_DIR,
        help="Directory containing skill-level artifact schemas",
    )
    parser.add_argument(
        "--capabilities-dir",
        type=Path,
        default=CAPABILITIES_DIR,
        help="Directory containing capability subdirectories",
    )
    args = parser.parse_args(argv)
    errors = validate_graph(args.schemas_dir, args.capabilities_dir)
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("cross-capability artifact graph ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
