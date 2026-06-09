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
import os
import sys
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
    "default": "default app home",
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
    return _default_app_home(env, home).resolve(), "default"


def _default_app_home(env: Mapping[str, str], home: Path) -> Path:
    """Return the platform data-home default for the Agentera app home."""
    if sys.platform == "darwin":
        return home.expanduser() / "Library" / "Application Support" / "agentera"
    if os.name == "nt":
        appdata = env.get("APPDATA")
        base = Path(appdata).expanduser() if appdata else home.expanduser() / "AppData" / "Roaming"
        return base / "agentera"
    xdg = env.get("XDG_DATA_HOME")
    base = Path(xdg).expanduser() if xdg else home.expanduser() / ".local" / "share"
    return base / "agentera"


def _linux_default_app_home(env: Mapping[str, str], home: Path) -> Path:
    xdg = env.get("XDG_DATA_HOME")
    base = Path(xdg).expanduser() if xdg else home.expanduser() / ".local" / "share"
    return base / "agentera"


def _macos_default_app_home(home: Path) -> Path:
    return home.expanduser() / "Library" / "Application Support" / "agentera"


def _windows_default_app_home(env: Mapping[str, str], home: Path) -> Path:
    appdata = env.get("APPDATA")
    base = Path(appdata).expanduser() if appdata else home.expanduser() / "AppData" / "Roaming"
    return base / "agentera"


def known_platform_default_app_homes(env: Mapping[str, str], home: Path) -> frozenset[Path]:
    """Return every OS-native default app-home path, regardless of the current platform."""
    return frozenset(
        {
            _linux_default_app_home(env, home).expanduser().resolve(),
            _macos_default_app_home(home).expanduser().resolve(),
            _windows_default_app_home(env, home).expanduser().resolve(),
        }
    )


def is_foreign_platform_default_app_home(
    candidate: Path,
    *,
    env: Mapping[str, str],
    home: Path,
) -> bool:
    """Return true when ``candidate`` is another platform's default app home."""
    resolved = candidate.expanduser().resolve()
    platform_default = _default_app_home(env, home).expanduser().resolve()
    if resolved == platform_default:
        return False
    return resolved in known_platform_default_app_homes(env, home)


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
                    "Agentera is not installed in the normal directory yet; a preview can show the repair before anything changes",
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
                "Agentera was told to use a directory that does not exist",
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
                "Agentera was told to use a file instead of a directory",
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
                "This directory looks like a broken Agentera install",
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
            "This directory already has files Agentera does not recognize",
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
            "Agentera app files are ready",
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
            "Agentera app files need repair",
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


def format_resolved_app_home(
    explicit_root: str | Path | None = None,
    *,
    env: Mapping[str, str] | None = None,
    home: Path | None = None,
    output_format: str = "text",
) -> str:
    """Return the resolved app home for agent/bootstrap callers."""
    resolved_env = env if env is not None else os.environ
    resolved_home = home if home is not None else Path.home()
    path, source = resolve_candidate(explicit_root, env=resolved_env, home=resolved_home)
    if output_format == "json":
        return json.dumps(
            {
                "path": str(path),
                "source": source,
                "sourceLabel": SOURCE_LABELS.get(source, source),
                "platform": sys.platform,
            }
        )
    return str(path)


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Resolve Agentera app-home paths.")
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format (default: text prints the resolved app-home path only)",
    )
    parser.add_argument(
        "--install-root",
        type=Path,
        default=None,
        help="Explicit app home to resolve (default: AGENTERA_HOME, then platform data home)",
    )
    parser.add_argument(
        "--home",
        type=Path,
        default=Path.home(),
        help="Home directory used for the default app home",
    )
    args = parser.parse_args(argv)
    print(
        format_resolved_app_home(
            args.install_root,
            env=os.environ,
            home=args.home,
            output_format=args.format,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
