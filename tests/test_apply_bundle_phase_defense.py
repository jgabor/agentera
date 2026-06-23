"""Regression tests for `_validate_installed_script` defense in `apply_bundle_phase`.

The defense was added after a user install corrupted `scripts/agentera` to 2
lines (`#!/usr/bin/env node\\nsub.add_parser('hej')`). Investigation (commit
10d2c44d) confirmed the v2 source is innocent — the corruption was
environmental — but the install path had no defensive check. This module
covers the defense so a future environmental or build-time regression
surfaces as an explicit error instead of a silently broken install.
"""

from __future__ import annotations

import importlib.util
import shutil
import textwrap
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_SCRIPT = REPO_ROOT / "scripts" / "agentera"


def _load_upgrade_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "agentera_upgrade_validate_test", REPO_ROOT / "scripts" / "agentera_upgrade.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_validate_installed_script_accepts_real_source(tmp_path: Path) -> None:
    """The v2.7.10 source passes the defense (8528 lines, valid Python)."""
    upgrade = _load_upgrade_module()
    target = tmp_path / "scripts" / "agentera"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SOURCE_SCRIPT, target)
    upgrade._validate_installed_script(target)  # must not raise


def test_validate_installed_script_rejects_short_stub(tmp_path: Path) -> None:
    """A 2-line Node-shebang + Python body stub (the original corruption class) is rejected."""
    upgrade = _load_upgrade_module()
    target = tmp_path / "scripts" / "agentera"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        textwrap.dedent(
            """\
            #!/usr/bin/env node
            sub.add_parser('hej')
            """
        ),
        encoding="utf-8",
    )
    with pytest.raises(RuntimeError, match="suspiciously short"):
        upgrade._validate_installed_script(target)


def test_validate_installed_script_rejects_missing_shebang(tmp_path: Path) -> None:
    """A long-but-valid-Python file without a shebang is rejected."""
    upgrade = _load_upgrade_module()
    target = tmp_path / "scripts" / "agentera"
    target.parent.mkdir(parents=True, exist_ok=True)
    body = "x = 1\n" * 9000
    target.write_text(body, encoding="utf-8")
    with pytest.raises(RuntimeError, match="missing a shebang"):
        upgrade._validate_installed_script(target)


def test_validate_installed_script_rejects_non_python_long_file(tmp_path: Path) -> None:
    """A long file with a shebang but invalid Python body is rejected."""
    upgrade = _load_upgrade_module()
    target = tmp_path / "scripts" / "agentera"
    target.parent.mkdir(parents=True, exist_ok=True)
    body = "#!/usr/bin/env python3\n" + ("x = 1..\n" * 8500)
    target.write_text(body, encoding="utf-8")
    with pytest.raises(RuntimeError, match="not valid Python"):
        upgrade._validate_installed_script(target)


def test_validate_installed_script_rejects_missing_file(tmp_path: Path) -> None:
    """A missing file is rejected with an explicit message."""
    upgrade = _load_upgrade_module()
    target = tmp_path / "scripts" / "agentera"
    with pytest.raises(RuntimeError, match="missing"):
        upgrade._validate_installed_script(target)


def test_apply_bundle_phase_aborts_on_short_corruption(tmp_path: Path) -> None:
    """End-to-end: if the source itself is corrupted, apply_bundle_phase aborts.

    Guards against a build-time mix-in where a v2 source tarball has a short
    stub at scripts/agentera. The defense surfaces it as an explicit failure
    instead of silently writing the bad content.
    """
    upgrade = _load_upgrade_module()
    # Build a fake source root with a short stub at scripts/agentera.
    # Must include all required app files (validate_capability.py, hooks, etc.)
    # so the phase is "pending" and apply_bundle_phase reaches the defense.
    fake_source = tmp_path / "fake-source"
    (fake_source / "scripts").mkdir(parents=True)
    (fake_source / "scripts" / "validate_capability.py").write_text("# stub\n", encoding="utf-8")
    (fake_source / "scripts" / "agentera").write_text(
        "#!/usr/bin/env node\nsub.add_parser('hej')\n", encoding="utf-8"
    )
    (fake_source / "hooks").mkdir()
    (fake_source / "hooks" / "validate_artifact.py").write_text("# stub\n", encoding="utf-8")
    (fake_source / "skills" / "agentera").mkdir(parents=True)
    (fake_source / "skills" / "agentera" / "SKILL.md").write_text(
        "---\nname: agentera\n---\n", encoding="utf-8"
    )
    (fake_source / "registry.json").write_text('{"skills":[{"name":"agentera"}]}', encoding="utf-8")
    (fake_source / ".agentera-bundle.json").write_text(
        '{"schemaVersion":"agentera.bundle.v1","version":"test"}', encoding="utf-8"
    )

    home = tmp_path / "home"
    install_root = home / ".local" / "share" / "agentera"
    phase = upgrade.plan_bundle_phase(
        source_root=fake_source,
        install_root=install_root,
        home=home,
        force=True,
        env={},
    )
    with pytest.raises(RuntimeError, match="suspiciously short"):
        upgrade.apply_bundle_phase(phase, fake_source, install_root, force=True)
