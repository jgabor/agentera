#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
# ///
"""Validate cross-capability artifact producer/consumer consistency.

The capability-local ``schemas/artifacts.yaml`` files are the behavioral
contracts: they say which capability produces or consumes each canonical
artifact. The skill-level artifact schemas are the shared API. This script
checks that those two layers agree on artifact names, paths, producers, and
consumers.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
CAPABILITIES_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities"
ARTIFACT_SCHEMAS_DIR = REPO_ROOT / "skills" / "agentera" / "schemas" / "artifacts"

EXTERNAL_OR_LOCAL_ARTIFACTS = {
    "PROFILE.md",
    "PLAN_archive",
    "harness",
}

DISPLAY_NAME_BY_SCHEMA = {
    "changelog": "CHANGELOG.md",
    "decisions": "DECISIONS.md",
    "design": "DESIGN.md",
    "docs": "DOCS.md",
    "experiments": "EXPERIMENTS.md",
    "health": "HEALTH.md",
    "objective": "OBJECTIVE.md",
    "plan": "PLAN.md",
    "progress": "PROGRESS.md",
    "session": "SESSION.md",
    "todo": "TODO.md",
    "vision": "VISION.md",
}


@dataclass(frozen=True)
class CanonicalArtifact:
    name: str
    path: str
    producers: set[str]
    consumers: set[str]


@dataclass(frozen=True)
class CapabilityArtifact:
    capability: str
    name: str
    path: str
    produces: bool
    consumes: bool


def _as_set(value: Any) -> set[str]:
    if value is None:
        return set()
    if isinstance(value, str):
        return {value}
    if isinstance(value, list):
        return {str(v) for v in value}
    return {str(value)}


def _load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    return data if isinstance(data, dict) else {}


def _display_name(schema_name: str) -> str:
    return DISPLAY_NAME_BY_SCHEMA.get(schema_name, f"{schema_name.upper()}.md")


def _normalize_path(path: str) -> str:
    """Collapse capability prose variants to comparable canonical paths."""
    p = str(path).strip()
    p = re.sub(r"\s*\([^)]*\)\s*$", "", p)
    p = re.sub(r"\s+or\s+mapped\s+path\s+per\s+(?:docs\.yaml|DOCS\.md)$", "", p)
    p = p.replace("<objective-name>", "<name>")
    return p.strip()


def load_canonical_artifacts(
    artifact_schemas_dir: Path = ARTIFACT_SCHEMAS_DIR,
) -> dict[str, CanonicalArtifact]:
    artifacts: dict[str, CanonicalArtifact] = {}
    for schema_path in sorted(artifact_schemas_dir.glob("*.yaml")):
        data = _load_yaml(schema_path)
        meta = data.get("meta", {})
        if not isinstance(meta, dict):
            continue
        schema_name = str(meta.get("name", "")).strip()
        if not schema_name:
            continue
        display_name = _display_name(schema_name)
        artifacts[display_name] = CanonicalArtifact(
            name=display_name,
            path=_normalize_path(str(meta.get("path", ""))),
            producers=_as_set(meta.get("producer")),
            consumers=_as_set(meta.get("consumers")),
        )
    return artifacts


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
            name = str(entry.get("name", "")).strip()
            path = str(entry.get("path", "")).strip()
            if not name:
                continue
            records.append(CapabilityArtifact(
                capability=cap_dir.name,
                name=name,
                path=_normalize_path(path),
                produces=bool(entry.get("produces")),
                consumes=bool(entry.get("consumes")),
            ))
    return records


def validate_graph(
    artifact_schemas_dir: Path = ARTIFACT_SCHEMAS_DIR,
    capabilities_dir: Path = CAPABILITIES_DIR,
) -> list[str]:
    canonical = load_canonical_artifacts(artifact_schemas_dir)
    capability_artifacts = load_capability_artifacts(capabilities_dir)
    capability_names = {p.name for p in capabilities_dir.iterdir() if p.is_dir()}
    errors: list[str] = []

    by_name: dict[str, list[CapabilityArtifact]] = {}
    for record in capability_artifacts:
        by_name.setdefault(record.name, []).append(record)
        if record.name not in canonical:
            if record.name not in EXTERNAL_OR_LOCAL_ARTIFACTS:
                errors.append(
                    f"{record.capability}: unknown artifact {record.name!r}"
                )
            continue
        if not record.produces and not record.consumes:
            errors.append(
                f"{record.capability}: {record.name} neither produces nor consumes"
            )
        expected_path = canonical[record.name].path
        if record.path != expected_path:
            errors.append(
                f"{record.capability}: {record.name} path {record.path!r} "
                f"does not match canonical {expected_path!r}"
            )

    for name, artifact in canonical.items():
        records = by_name.get(name, [])
        produced_by = {r.capability for r in records if r.produces}
        consumed_by = {r.capability for r in records if r.consumes}
        schema_producers = artifact.producers & capability_names
        schema_consumers = artifact.consumers & capability_names
        if schema_producers != produced_by:
            errors.append(
                f"{name}: skill-level producers {sorted(schema_producers)} "
                f"do not match capability producers {sorted(produced_by)}"
            )
        if "all_skills" not in artifact.consumers and schema_consumers != consumed_by:
            errors.append(
                f"{name}: skill-level consumers {sorted(schema_consumers)} "
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
