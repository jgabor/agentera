#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Read-only Agentera install-root classification.

This module owns install-root identity and diagnostics without mutating durable
bundle state. Callers may use the structured result directly or render the
diagnostic message for humans with ``format_diagnostic``.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Mapping


BUNDLE_MARKER = ".agentera-bundle.json"
SETUP_EVIDENCE = (
    "scripts/validate_capability.py",
    "hooks",
    "skills",
    "skills/agentera/SKILL.md",
)
BUNDLE_EVIDENCE = (
    "scripts/agentera",
    "skills/agentera/SKILL.md",
    "registry.json",
    BUNDLE_MARKER,
)
MANAGED_EVIDENCE = tuple(dict.fromkeys((*SETUP_EVIDENCE, *BUNDLE_EVIDENCE)))
SOURCE_LABELS = {
    "explicit": "explicit --install-root",
    "environment": "AGENTERA_HOME",
    "default": "default durable root",
}


@dataclass(frozen=True)
class Diagnostic:
    code: str
    severity: str
    message: str
    evidence: dict[str, Any]


@dataclass(frozen=True)
class Classification:
    source: str
    source_label: str
    path: str
    kind: str
    safe_action: str
    diagnostic: Diagnostic
    managed_status: str
    stale_status: str
    missing_evidence: list[str]
    expected_version: str | None = None
    current_version: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def resolve_candidate(
    explicit_root: str | Path | None,
    *,
    env: Mapping[str, str],
    home: Path,
) -> tuple[Path, str]:
    """Resolve the candidate path using explicit, environment, then default precedence."""
    if explicit_root is not None:
        return Path(explicit_root).expanduser().resolve(), "explicit"
    configured = env.get("AGENTERA_HOME")
    if configured:
        return Path(configured).expanduser().resolve(), "environment"
    default = env.get("AGENTERA_DEFAULT_INSTALL_ROOT")
    if default:
        return Path(default).expanduser().resolve(), "default"
    return (home.expanduser().resolve() / ".agents" / "agentera").resolve(), "default"


def classify_resolved_root(
    root: Path,
    *,
    source: str,
    expected_version: str | None = None,
) -> Classification:
    """Classify a resolved root path without creating, deleting, or modifying files."""
    root = root.expanduser().resolve()
    source_label = SOURCE_LABELS.get(source, source)
    expected = expected_version

    if not root.exists():
        if source == "default":
            return _classification(
                root,
                source,
                "missing_default",
                "preview_refresh",
                "missing",
                "stale",
                ["directory", "managed bundle evidence"],
                Diagnostic(
                    "install_root.missing_default_root",
                    "warning",
                    "default durable root is missing and may be created only by a confirmed install or refresh",
                    {"path": str(root), "source": source_label},
                ),
                expected_version=expected,
            )
        return _classification(
            root,
            source,
            "missing_explicit_or_environment",
            "require_existing_managed_root",
            "missing",
            "not_applicable",
            ["directory", "managed bundle evidence"],
            Diagnostic(
                "install_root.missing_selected_root",
                "error",
                "selected install root does not exist",
                {"path": str(root), "source": source_label},
            ),
            expected_version=expected,
        )

    if root.is_file():
        return _classification(
            root,
            source,
            "file_valued_root",
            "reject_file_path",
            "invalid",
            "not_applicable",
            ["directory"],
            Diagnostic(
                "install_root.file_path",
                "error",
                "selected install root is a file, not a directory",
                {"path": str(root), "source": source_label},
            ),
            expected_version=expected,
        )

    setup_missing = _missing_entries(root, SETUP_EVIDENCE)
    bundle_missing = _missing_entries(root, BUNDLE_EVIDENCE)
    has_setup_evidence = not setup_missing
    has_bundle_evidence = not bundle_missing
    present_evidence = [entry for entry in MANAGED_EVIDENCE if (root / entry).exists()]
    marker = _read_bundle_marker(root)
    current = marker.get("version") if marker else None

    if has_setup_evidence and not (root / BUNDLE_MARKER).exists():
        return _managed_fresh(root, source, setup_missing, bundle_missing, expected, current)

    if has_bundle_evidence:
        if expected is not None and current != expected:
            return _managed_stale(
                root,
                source,
                expected,
                current,
                missing_evidence=["current bundle marker/version or required CLI command evidence"],
                reason="version_mismatch",
                evidence={"expectedVersion": expected, "currentVersion": current, "markerPath": str(root / BUNDLE_MARKER)},
            )
        command_missing = _missing_script_commands(root / "scripts" / "agentera", ("hej",))
        if command_missing:
            return _managed_stale(
                root,
                source,
                expected,
                current,
                missing_evidence=["current bundle marker/version or required CLI command evidence"],
                reason="missing_command",
                evidence={"missingCommands": command_missing, "scriptPath": str(root / "scripts" / "agentera")},
            )
        return _managed_fresh(root, source, setup_missing, bundle_missing, expected, current)

    managed_without_marker = (
        (root / "scripts" / "agentera").exists()
        and (root / "skills" / "agentera" / "SKILL.md").exists()
        and (root / "registry.json").exists()
    )
    if managed_without_marker:
        return _managed_stale(
            root,
            source,
            expected,
            current,
            missing_evidence=["current bundle marker/version or required CLI command evidence"],
            reason="missing_marker",
            evidence={"expectedVersion": expected, "currentVersion": current, "markerPath": str(root / BUNDLE_MARKER)},
        )

    if present_evidence:
        return _classification(
            root,
            source,
            "invalid_bundle",
            "reject_invalid_bundle",
            "invalid",
            "unknown",
            ["valid bundle marker and complete managed bundle evidence"],
            Diagnostic(
                "install_root.invalid_bundle",
                "error",
                "selected directory has incomplete or malformed Agentera bundle evidence",
                {
                    "path": str(root),
                    "source": source_label,
                    "presentEvidence": present_evidence,
                    "missingSetupEvidence": setup_missing,
                    "missingBundleEvidence": bundle_missing,
                },
            ),
            expected_version=expected,
            current_version=current,
        )

    return _classification(
        root,
        source,
        "unmanaged_directory",
        "reject_unmanaged_directory",
        "unmanaged",
        "not_applicable",
        ["managed bundle evidence"],
        Diagnostic(
            "install_root.unmanaged_directory",
            "error",
            "selected directory is not a managed Agentera bundle",
            {"path": str(root), "source": source_label},
        ),
        expected_version=expected,
    )


def classify_install_root(
    explicit_root: str | Path | None,
    *,
    env: Mapping[str, str],
    home: Path,
    expected_version: str | None = None,
) -> Classification:
    root, source = resolve_candidate(explicit_root, env=env, home=home)
    return classify_resolved_root(root, source=source, expected_version=expected_version)


def format_diagnostic(classification: Classification) -> str:
    """Return human display text without collapsing the structured diagnostic."""
    return f"{classification.diagnostic.severity}: {classification.diagnostic.message} ({classification.path})"


def _classification(
    root: Path,
    source: str,
    kind: str,
    safe_action: str,
    managed_status: str,
    stale_status: str,
    missing_evidence: list[str],
    diagnostic: Diagnostic,
    *,
    expected_version: str | None = None,
    current_version: str | None = None,
) -> Classification:
    return Classification(
        source=source,
        source_label=SOURCE_LABELS.get(source, source),
        path=str(root),
        kind=kind,
        safe_action=safe_action,
        diagnostic=diagnostic,
        managed_status=managed_status,
        stale_status=stale_status,
        missing_evidence=missing_evidence,
        expected_version=expected_version,
        current_version=current_version,
    )


def _managed_fresh(
    root: Path,
    source: str,
    setup_missing: list[str],
    bundle_missing: list[str],
    expected: str | None,
    current: str | None,
) -> Classification:
    return _classification(
        root,
        source,
        "managed_fresh",
        "use_root",
        "managed",
        "fresh",
        [],
        Diagnostic(
            "install_root.managed_fresh",
            "info",
            "install root is managed and fresh",
            {
                "path": str(root),
                "source": SOURCE_LABELS.get(source, source),
                "expectedVersion": expected,
                "currentVersion": current,
                "missingSetupEvidence": setup_missing,
                "missingBundleEvidence": bundle_missing,
            },
        ),
        expected_version=expected,
        current_version=current,
    )


def _managed_stale(
    root: Path,
    source: str,
    expected: str | None,
    current: str | None,
    *,
    missing_evidence: list[str],
    reason: str,
    evidence: dict[str, Any],
) -> Classification:
    return _classification(
        root,
        source,
        "managed_stale",
        "preview_refresh",
        "managed",
        "stale",
        missing_evidence,
        Diagnostic(
            "install_root.managed_stale",
            "warning",
            "install root is managed but stale",
            {"path": str(root), "source": SOURCE_LABELS.get(source, source), "reason": reason, **evidence},
        ),
        expected_version=expected,
        current_version=current,
    )


def _missing_entries(root: Path, entries: tuple[str, ...]) -> list[str]:
    return [entry for entry in entries if not (root / entry).exists()]


def _read_bundle_marker(root: Path) -> dict[str, Any] | None:
    marker = root / BUNDLE_MARKER
    if not marker.is_file():
        return None
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _missing_script_commands(script: Path, commands: tuple[str, ...]) -> list[str]:
    if not script.is_file():
        return list(commands)
    try:
        text = script.read_text(encoding="utf-8")
    except OSError:
        return list(commands)
    return [command for command in commands if command not in text]
