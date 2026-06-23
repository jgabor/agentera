"""Regression test for v2 install path byte-equality of scripts/agentera.

The v2.7.10 install corrupted ``~/.local/share/agentera/app/scripts/agentera``
on a user machine to 2 lines: ``#!/usr/bin/env node\\nsub.add_parser('hej')``.
Neither the v2 source nor any v2 test stub matches that pattern (all v2
test stubs use ``#!/usr/bin/env python3``; the Node shebang only exists in
v3's ``packages/cli/bin/agentera.mjs``). This test exercises the v2 install
path end-to-end and asserts the installed ``scripts/agentera`` byte-equals
the source from the same commit.

If the test ever fails on a clean temp dir, the v2 install path has been
regressed and a fresh install would corrupt the script. If the test passes,
the corruption the user observed cannot be reproduced from the v2 source on
``origin/main`` HEAD — the root cause is environmental and the test serves
as a guard against future regression.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType


REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_SCRIPT = REPO_ROOT / "scripts" / "agentera"
SOURCE_LINE_COUNT = 8528
NODE_SHEBANG = "#!/usr/bin/env node"
CORRUPTION_MARKER = "sub.add_parser"


def _load_upgrade_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("agentera_upgrade_apply", REPO_ROOT / "scripts" / "agentera_upgrade.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_apply_bundle_phase_installs_source_scripts_agentera_byte_equal(tmp_path: Path) -> None:
    upgrade = _load_upgrade_module()
    home = tmp_path / "home"
    install_root = home / ".local" / "share" / "agentera"

    phase = upgrade.plan_bundle_phase(REPO_ROOT, install_root, home, force=True, env={})
    assert phase["status"] in {"pending", "noop"}, phase
    upgrade.apply_bundle_phase(phase, REPO_ROOT, install_root, force=True)

    installed = install_root / "app" / "scripts" / "agentera"
    assert installed.is_file(), f"expected {installed} to be installed by apply_bundle_phase"
    assert installed.read_bytes() == SOURCE_SCRIPT.read_bytes(), (
        f"installed scripts/agentera ({installed.stat().st_size} bytes) does not "
        f"byte-equal source scripts/agentera ({SOURCE_SCRIPT.stat().st_size} bytes); "
        "the v2 install path is corrupting scripts/agentera"
    )


def test_apply_bundle_phase_installs_full_length_python_script_not_stub(tmp_path: Path) -> None:
    upgrade = _load_upgrade_module()
    home = tmp_path / "home"
    install_root = home / ".local" / "share" / "agentera"

    phase = upgrade.plan_bundle_phase(REPO_ROOT, install_root, home, force=True, env={})
    upgrade.apply_bundle_phase(phase, REPO_ROOT, install_root, force=True)

    installed = install_root / "app" / "scripts" / "agentera"
    assert installed.is_file()
    text = installed.read_text(encoding="utf-8")
    lines = text.splitlines()

    assert len(lines) >= 8000, (
        f"scripts/agentera is suspiciously short ({len(lines)} lines); the v2 source is "
        f"{SOURCE_LINE_COUNT} lines, so anything under 8000 lines indicates the install "
        "replaced the source with a stub (this is the user-reported corruption pattern)"
    )
    assert not lines[0].startswith(NODE_SHEBANG), (
        f"scripts/agentera shebang is a Node shebang ({lines[0]!r}); the v2 source uses "
        "'#!/usr/bin/env -S uv run --script', so a Node shebang means the v2 install "
        "path leaked a v3 file"
    )
    assert CORRUPTION_MARKER not in text or "import argparse" in text, (
        f"scripts/agentera contains '{CORRUPTION_MARKER}' without a Python argparse "
        "header; the user-reported 2-line stub had 'sub.add_parser(\\'hej\\')' as a "
        "body line with a Node shebang"
    )


def test_apply_bundle_phase_does_not_mix_v3_cli_shim_into_scripts_path(tmp_path: Path) -> None:
    upgrade = _load_upgrade_module()
    home = tmp_path / "home"
    install_root = home / ".local" / "share" / "agentera"

    phase = upgrade.plan_bundle_phase(REPO_ROOT, install_root, home, force=True, env={})
    upgrade.apply_bundle_phase(phase, REPO_ROOT, install_root, force=True)

    rel_paths = upgrade._bundle_rel_paths(REPO_ROOT)
    scripts_paths = [path for path in rel_paths if path.parts[:1] == ("scripts",)]
    assert scripts_paths, "v2 install did not discover any scripts/ paths"
    for path in scripts_paths:
        target = install_root / "app" / path
        assert target.is_file(), f"{target} missing from installed bundle"
        first_line = target.read_text(encoding="utf-8").splitlines()[0]
        assert not first_line.startswith(NODE_SHEBANG), (
            f"{path} has a Node shebang in the installed bundle; the v2 install path "
            "wrote a v3 npm shim into a v2 scripts/ path"
        )
