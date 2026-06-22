#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""v2/v3 coexistence doctor probe (authority: references/cli/coexistence-probe.yaml)."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from yaml_mapping import load_yaml_mapping_file

COEXISTENCE_PROBE_AUTHORITY = Path("references/cli/coexistence-probe.yaml")
NPX_BUNDLE_SENTINEL = ".agentera-npx-bundle.json"


def _authority_path(source_root: Path) -> Path:
    candidate = source_root / COEXISTENCE_PROBE_AUTHORITY
    if candidate.exists():
        return candidate
    return Path(__file__).resolve().parents[1] / COEXISTENCE_PROBE_AUTHORITY


def load_coexistence_probe_authority(source_root: Path) -> dict[str, Any]:
    return load_yaml_mapping_file(_authority_path(source_root))


def _parse_major(version: str) -> int | None:
    token = version.strip().lstrip("v").split(".", 1)[0]
    if not token.isdigit():
        return None
    return int(token)


def agentera_package_dir_is_v3(pkg_dir: Path) -> bool:
    """Return true when an on-disk agentera npm package looks like the v3 line."""
    if (pkg_dir / NPX_BUNDLE_SENTINEL).is_file():
        return True
    pkg_json = pkg_dir / "package.json"
    if not pkg_json.is_file():
        return False
    try:
        data = json.loads(pkg_json.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return False
    if not isinstance(data, dict):
        return False
    major = _parse_major(str(data.get("version", "")))
    return major is not None and major >= 3


def scan_npx_v3_installs(home: Path) -> list[Path]:
    """Probe ~/.npm/_npx/<hash>/node_modules/agentera for v3 package evidence."""
    npx_root = home.expanduser() / ".npm" / "_npx"
    if not npx_root.is_dir():
        return []
    found: list[Path] = []
    for entry in npx_root.iterdir():
        if not entry.is_dir():
            continue
        pkg_dir = entry / "node_modules" / "agentera"
        if agentera_package_dir_is_v3(pkg_dir):
            found.append(pkg_dir)
    return found


def probe_global_npm_v3() -> Path | None:
    """Run `npm ls -g agentera --json` when npm is available; return v3 package dir."""
    npm = shutil.which("npm")
    if not npm:
        return None
    try:
        proc = subprocess.run(
            [npm, "ls", "-g", "agentera", "--json", "--depth=0"],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode not in {0, 1}:
        return None
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    dependencies = data.get("dependencies")
    if not isinstance(dependencies, dict):
        return None
    entry = dependencies.get("agentera")
    if not isinstance(entry, dict):
        return None
    resolved = str(entry.get("resolved", "")).strip()
    if resolved.startswith("file:"):
        pkg_dir = Path(resolved.removeprefix("file:")).expanduser()
    else:
        path_value = entry.get("path")
        if isinstance(path_value, str) and path_value.strip():
            pkg_dir = Path(path_value).expanduser()
        else:
            return None
    if pkg_dir.is_dir() and agentera_package_dir_is_v3(pkg_dir):
        return pkg_dir
    version = str(entry.get("version", ""))
    major = _parse_major(version)
    if major is not None and major >= 3:
        return pkg_dir if pkg_dir.is_dir() else None
    return None


def detect_v3_coexistence(home: Path) -> list[str]:
    """Return human-readable evidence paths when a v3 install is present."""
    evidence: list[str] = []
    for pkg_dir in scan_npx_v3_installs(home):
        evidence.append(f"npx cache: {pkg_dir}")
    global_pkg = probe_global_npm_v3()
    if global_pkg is not None:
        label = f"global npm: {global_pkg}"
        if label not in evidence:
            evidence.append(label)
    return evidence


def format_coexistence_doctor_lines(
    contract: dict[str, Any],
    *,
    evidence: list[str],
) -> list[str]:
    del evidence  # surfaced only via the shared warning contract
    section = str(contract.get("section_header", "Coexistence"))
    warning = contract.get("warning")
    if not isinstance(warning, dict):
        raise ValueError("coexistence probe contract: warning must be a mapping")
    headline = str(warning.get("headline", "")).strip()
    resolutions = warning.get("resolutions")
    if not headline or not isinstance(resolutions, list) or not resolutions:
        raise ValueError("coexistence probe contract: warning headline and resolutions required")
    lines = [section, headline]
    for item in resolutions:
        lines.append(f"  - {item}")
    return lines


def resolve_coexistence_doctor_lines(*, home: Path, source_root: Path) -> list[str] | None:
    evidence = detect_v3_coexistence(home)
    if not evidence:
        return None
    contract = load_coexistence_probe_authority(source_root)
    return format_coexistence_doctor_lines(contract, evidence=evidence)


def prepend_coexistence_doctor_section(text: str, section_lines: list[str] | None) -> str:
    if not section_lines:
        return text
    return "\n".join(section_lines) + "\n\n" + text
