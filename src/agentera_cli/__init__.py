"""Packaged entry point for the Agentera CLI."""

from __future__ import annotations

import os
import runpy
import sys
from importlib import resources
from pathlib import Path


def _repo_fallback_bundle() -> Path:
    return Path(__file__).resolve().parents[2]


def _bundle_root() -> Path:
    packaged = resources.files(__package__) / "bundle"
    with resources.as_file(packaged) as path:
        candidate = Path(path)
        if (candidate / "scripts" / "agentera").is_file():
            return candidate
    return _repo_fallback_bundle()


def main() -> int:
    bundle = _bundle_root()
    scripts = bundle / "scripts"
    os.environ.setdefault("AGENTERA_BOOTSTRAP_SOURCE_ROOT", str(bundle))
    os.environ.setdefault(
        "AGENTERA_DEFAULT_INSTALL_ROOT",
        str(Path.home() / ".agents" / "agentera"),
    )
    sys.path.insert(0, str(scripts))
    original_argv0 = sys.argv[0]
    sys.argv[0] = "agentera"
    try:
        runpy.run_path(str(scripts / "agentera"), run_name="__main__")
    except SystemExit as exc:
        code = exc.code
        if code is None:
            return 0
        if isinstance(code, int):
            return code
        print(code, file=sys.stderr)
        return 1
    finally:
        sys.argv[0] = original_argv0
    return 0
