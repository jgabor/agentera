#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Diagnose Cursor AGENTERA_HOME setup without editing shell startup files.

Cursor IDE exports AGENTERA_HOME through sessionStart hook JSON by default.
This helper is a conditional fallback seam: it reports legacy managed rc
markers and prints per-invocation guidance when shell-tool smoke shows session
env does not propagate to CLI subprocesses.

Agentera never creates, rewrites, or removes shell startup files from this
helper. Cleanup of legacy managed markers remains user-owned.

Usage::

    uv run scripts/setup_cursor.py
    uv run scripts/setup_cursor.py --install-root /opt/agentera
    uv run scripts/setup_cursor.py --dry-run

Exit codes:

    0  diagnostic completed; no shell startup file was changed
    2  error: bad Agentera directory or unreadable diagnostic target
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
import install_root as install_root_module

MANAGED_KEY = "AGENTERA_HOME"
MARKER_COMMENT = f"# agentera: {MANAGED_KEY} (managed)"
ENV_FALLBACKS = ("AGENTERA_HOME", "CLAUDE_PLUGIN_ROOT")


class InstallRootError(RuntimeError):
    pass


def verify_install_root(root: Path) -> list[str]:
    classification = install_root_module.classify_resolved_root(root, source="explicit")
    if classification.kind == "managed_fresh":
        return []
    return [entry for entry in install_root_module.SETUP_EVIDENCE if not (root / entry).exists()]


def auto_detect_install_root(start: Path | None = None) -> Path | None:
    for var in ENV_FALLBACKS:
        candidate = os.environ.get(var)
        if candidate:
            path = Path(candidate).expanduser().resolve()
            if not verify_install_root(path):
                return path
    if start is None:
        start = Path(__file__).resolve().parent
    current = start.resolve()
    for candidate in (current, *current.parents):
        if not verify_install_root(candidate):
            return candidate
    return None


def resolve_install_root(explicit: str | None) -> Path:
    if explicit is not None:
        root = Path(explicit).expanduser().resolve()
        if install_root_module.classify_resolved_root(root, source="explicit").kind != "managed_fresh":
            missing = verify_install_root(root)
            raise InstallRootError(
                f"--install-root {root} is not a valid Agentera directory: "
                f"missing canonical entries: {', '.join(missing)}"
            )
        return root
    detected = auto_detect_install_root()
    if detected is None:
        raise InstallRootError(
            "could not auto-detect the Agentera directory; pass --install-root PATH"
        )
    return detected


def _rc_paths(home: Path) -> tuple[Path, ...]:
    return (
        home / ".bashrc",
        home / ".zshrc",
        home / ".config" / "fish" / "config.fish",
    )


def _find_marker(text: str) -> str | None:
    for line in text.splitlines():
        if line.strip() == MARKER_COMMENT:
            return line
    return None


def diagnose(install_root: Path, home: Path) -> dict[str, object]:
    checks: list[dict[str, str]] = []
    env_value = os.environ.get(MANAGED_KEY)
    if env_value:
        checks.append(
            {
                "name": MANAGED_KEY,
                "status": "pass" if Path(env_value).resolve() == install_root else "warn",
                "message": f"{MANAGED_KEY}={env_value}",
            }
        )
    else:
        checks.append(
            {
                "name": MANAGED_KEY,
                "status": "warn",
                "message": (
                    f"{MANAGED_KEY} is unset in this process; Cursor sessionStart hook "
                    "should export it for IDE sessions"
                ),
            }
        )

    hooks_path = install_root / ".cursor" / "hooks.json"
    if hooks_path.is_file():
        checks.append({"name": "cursor.hooks", "status": "pass", "message": str(hooks_path)})
    else:
        checks.append(
            {
                "name": "cursor.hooks",
                "status": "fail",
                "message": "missing repo-native .cursor/hooks.json",
            }
        )

    for rc in _rc_paths(home):
        if not rc.is_file():
            continue
        text = rc.read_text(encoding="utf-8", errors="replace")
        if _find_marker(text):
            checks.append(
                {
                    "name": f"rc.{rc.name}",
                    "status": "warn",
                    "message": (
                        f"legacy managed {MANAGED_KEY} marker found in {rc}; "
                        "Agentera will not edit it automatically"
                    ),
                }
            )

    overall = "fail" if any(item["status"] == "fail" for item in checks) else "pass"
    return {
        "runtime": "cursor",
        "status": overall,
        "install_root": str(install_root),
        "checks": checks,
        "guidance": (
            "Prefer Cursor sessionStart env export. Use per-invocation "
            f"export {MANAGED_KEY}={install_root} for cursor-agent when shell smoke fails."
        ),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Diagnose Cursor AGENTERA_HOME wiring")
    parser.add_argument("--install-root", type=Path, default=None)
    parser.add_argument("--dry-run", action="store_true", help="report only; never writes rc files")
    args = parser.parse_args(argv)

    try:
        install_root = resolve_install_root(
            str(args.install_root) if args.install_root is not None else None
        )
    except InstallRootError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    report = diagnose(install_root, Path.home())
    print(report["guidance"])
    for check in report["checks"]:
        print(f"[{check['status']}] {check['name']}: {check['message']}")
    return 0 if report["status"] != "fail" else 2


if __name__ == "__main__":
    sys.exit(main())
