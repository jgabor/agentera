#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Validate user-facing app-home terminology for release readiness."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


TEXT_SURFACES = (
    "README.md",
    "UPGRADE.md",
    "docs/vocabulary.md",
    "skills/agentera/SKILL.md",
    "skills/agentera/capabilities/hej/prose.md",
    "skills/agentera/references/contract.md",
)
CLI_HELP_COMMANDS = (
    ("--help",),
    ("hej", "--help"),
    ("doctor", "--help"),
    ("upgrade", "--help"),
)
CLI_OUTPUT_COMMANDS = (
    ("hej",),
    ("hej", "--format", "json"),
    ("doctor", "--json"),
    ("upgrade", "--only", "bundle", "--dry-run"),
    ("upgrade", "--only", "bundle", "--dry-run", "--json"),
    ("upgrade", "--only", "runtime", "--runtime", "claude", "--dry-run"),
)
FORBIDDEN = (
    (re.compile(r"\bbundle[- ]root\b", re.IGNORECASE), "bundle-root wording"),
    (re.compile(r"\blive bundle\b", re.IGNORECASE), "live-bundle wording"),
    (re.compile(r"\bdurable bundle\b.*\bAGENTERA_HOME\b", re.IGNORECASE), "durable bundle named as AGENTERA_HOME"),
    (re.compile(r"\bAGENTERA_HOME\b.*\bdurable bundle\b", re.IGNORECASE), "AGENTERA_HOME named as durable bundle"),
    (re.compile(r"\bAGENTERA_HOME\b.*\binstall root\b", re.IGNORECASE), "AGENTERA_HOME named as install root"),
    (re.compile(r"\binstall root\b.*\bAGENTERA_HOME\b", re.IGNORECASE), "install root named as AGENTERA_HOME"),
    (re.compile(r"\bdefault durable root\b", re.IGNORECASE), "default durable root wording"),
)


def _check_text(surface: str, text: str) -> list[str]:
    errors: list[str] = []
    for number, line in enumerate(text.splitlines(), start=1):
        for pattern, reason in FORBIDDEN:
            if pattern.search(line):
                errors.append(f"{surface}:{number}: {reason}: {line.strip()}")
        if surface.startswith("agentera "):
            if re.search(r"\binstall root:", line, re.IGNORECASE):
                errors.append(f"{surface}:{number}: CLI output names app home as install root: {line.strip()}")
            if "installRoot" in line:
                errors.append(f"{surface}:{number}: public JSON exposes installRoot instead of appHome: {line.strip()}")
    return errors


def _read_surface(root: Path, relative: str) -> tuple[str, str] | None:
    path = root / relative
    if not path.is_file():
        return None
    return relative, path.read_text(encoding="utf-8")


def _cli_help_surfaces(root: Path) -> list[tuple[str, str]]:
    cli = root / "scripts" / "agentera"
    if not cli.is_file():
        return []
    surfaces: list[tuple[str, str]] = []
    env = {**os.environ, "AGENTERA_HOME": str(root)}
    for args in CLI_HELP_COMMANDS:
        command = [sys.executable, str(cli), *args]
        result = subprocess.run(
            command,
            cwd=root,
            env=env,
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
        )
        label = "agentera " + " ".join(args)
        surfaces.append((label, result.stdout + result.stderr))
        if result.returncode != 0:
            surfaces.append((label, f"help command exited {result.returncode}"))
    return surfaces


def _cli_output_surfaces(root: Path) -> list[tuple[str, str]]:
    cli = root / "scripts" / "agentera"
    if not cli.is_file():
        return []
    surfaces: list[tuple[str, str]] = []
    env = {**os.environ, "AGENTERA_HOME": str(root), "AGENTERA_BOOTSTRAP_SOURCE_ROOT": str(root)}
    with tempfile.TemporaryDirectory(prefix="agentera-app-home-validator-") as project:
        for args in CLI_OUTPUT_COMMANDS:
            command = [sys.executable, str(cli), *args]
            result = subprocess.run(
                command,
                cwd=project,
                env=env,
                text=True,
                capture_output=True,
                check=False,
                timeout=30,
            )
            surfaces.append(("agentera " + " ".join(args), result.stdout + result.stderr))
    return surfaces


def validate(root: Path) -> list[str]:
    errors: list[str] = []
    for relative in TEXT_SURFACES:
        surface = _read_surface(root, relative)
        if surface is None:
            continue
        errors.extend(_check_text(*surface))
    for surface, text in _cli_help_surfaces(root):
        errors.extend(_check_text(surface, text))
    for surface, text in _cli_output_surfaces(root):
        errors.extend(_check_text(surface, text))
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate Agentera app-home user-facing terminology")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1], help="Repository root to validate")
    args = parser.parse_args(argv)
    errors = validate(args.root.resolve())
    if errors:
        print("App-home contract validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("OK: app-home contract terminology is release-ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
