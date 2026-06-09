#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
# ///
"""Cursor sessionStart hook: export AGENTERA_HOME and preload session context."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = SCRIPT_DIR.parent
REPO_ROOT = PLUGIN_ROOT
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
if str(REPO_ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "scripts"))

import install_root as install_root_module
from session_start import build_digest


def _resolve_install_root(cwd: Path) -> Path | None:
    env_root = os.environ.get("AGENTERA_HOME")
    if env_root:
        candidate = Path(env_root).expanduser().resolve()
        if install_root_module.classify_resolved_root(candidate, source="environment").kind in {
            "managed_fresh",
            "managed_stale",
        }:
            return candidate
    for parent in (cwd, *cwd.parents):
        if install_root_module.classify_resolved_root(parent, source="walk").kind == "managed_fresh":
            return parent
    if install_root_module.classify_resolved_root(PLUGIN_ROOT, source="plugin").kind == "managed_fresh":
        return PLUGIN_ROOT
    default_root, _source = install_root_module.resolve_candidate(None, env=os.environ, home=Path.home())
    if install_root_module.classify_resolved_root(default_root, source="default").kind in {
        "managed_fresh",
        "managed_stale",
    }:
        return default_root
    return None


def main() -> int:
    raw = sys.stdin.read()
    cwd = "."
    if raw.strip():
        try:
            hook_input = json.loads(raw)
        except json.JSONDecodeError:
            hook_input = {}
        if isinstance(hook_input, dict):
            cwd = hook_input.get("cwd") or (
                hook_input.get("workspace_roots", ["."])[0]
                if hook_input.get("workspace_roots")
                else "."
            )

    project_root = Path(str(cwd)).resolve()
    install_root = _resolve_install_root(project_root)
    payload: dict[str, object] = {}
    if install_root is not None:
        payload["env"] = {"AGENTERA_HOME": str(install_root)}

    digest = build_digest(project_root)
    if digest:
        payload["additional_context"] = digest

    if payload:
        print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
