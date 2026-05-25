"""Coverage and import smoke for the extensionless scripts/agentera CLI entry point."""

from __future__ import annotations

import importlib.machinery
import importlib.util
from pathlib import Path
from types import ModuleType


REPO_ROOT = Path(__file__).resolve().parent.parent
AGENTERA_CLI = REPO_ROOT / "scripts" / "agentera"


def _load_agentera_cli() -> ModuleType:
    loader = importlib.machinery.SourceFileLoader("agentera_cli", str(AGENTERA_CLI))
    spec = importlib.util.spec_from_loader("agentera_cli", loader)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_agentera_cli_module_exposes_main_entrypoint() -> None:
    module = _load_agentera_cli()
    assert callable(module.main)
