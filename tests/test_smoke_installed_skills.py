"""Tests for the offline installed skill bundle smoke."""

from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_smoke():
    path = REPO_ROOT / "scripts" / "smoke_installed_skills.py"
    spec = importlib.util.spec_from_file_location("smoke_installed_skills", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["smoke_installed_skills"] = module
    spec.loader.exec_module(module)
    return module


def _write_skill(root: Path, name: str, text: str) -> Path:
    skill = root / name
    (skill / "references").mkdir(parents=True)
    (skill / "scripts").mkdir()
    (skill / "SKILL.md").write_text(text, encoding="utf-8")
    (skill / "references" / "contract.md").write_text("contract\n", encoding="utf-8")
    (skill / "scripts" / "helper.py").write_text("print('ok')\n", encoding="utf-8")
    return skill


def test_offline_smoke_accepts_healthy_installed_bundle(tmp_path: Path) -> None:
    smoke = _load_smoke()
    source = tmp_path / "source" / "skills"
    installed = tmp_path / "installed"
    source.mkdir(parents=True)
    _write_skill(
        source,
        "hej",
        "Use references/contract.md and scripts/helper.py from the bundle.\n",
    )
    shutil.copytree(source, installed / "skills")

    result = smoke.validate_installed_bundles(
        installed,
        source_skills_root=source,
        skill_names=["hej"],
    )

    assert result.ok is True
    assert result.checked_skills == ["hej"]
    assert result.errors == []


def test_offline_smoke_fails_stale_installed_reference_before_runtime(
    tmp_path: Path,
) -> None:
    smoke = _load_smoke()
    source = tmp_path / "source" / "skills"
    installed = tmp_path / "installed"
    source.mkdir(parents=True)
    _write_skill(
        source,
        "hej",
        "Use references/contract.md and references/missing.md from the bundle.\n",
    )
    shutil.copytree(source, installed / "skills")

    result = smoke.validate_installed_bundles(
        installed,
        source_skills_root=source,
        skill_names=["hej"],
    )

    assert result.ok is False
    assert result.real_npx_attempted is False
    assert result.errors == ["hej: missing bundled support file references/missing.md"]


def test_default_smoke_does_not_run_real_npx(tmp_path: Path, monkeypatch) -> None:
    smoke = _load_smoke()
    source = tmp_path / "source" / "skills"
    installed = tmp_path / "installed"
    source.mkdir(parents=True)
    _write_skill(source, "hej", "Use references/contract.md from the bundle.\n")
    shutil.copytree(source, installed / "skills")
    called = False

    def fake_run_real_npx(home, config_home):
        nonlocal called
        called = True
        raise AssertionError("real npx must be opt-in")

    monkeypatch.setattr(smoke, "run_real_npx", fake_run_real_npx)
    result = smoke.run_smoke(
        installed_root=installed,
        real_npx=False,
        source_skills_root=source,
        skill_names=["hej"],
    )

    assert result.ok is True
    assert result.real_npx_attempted is False
    assert called is False


def test_real_npx_smoke_accepts_universal_agents_install_dir(
    tmp_path: Path,
    monkeypatch,
) -> None:
    smoke = _load_smoke()
    source = tmp_path / "source" / "skills"
    source.mkdir(parents=True)
    _write_skill(source, "hej", "Use references/contract.md from the bundle.\n")

    def fake_run_real_npx(home, config_home):
        installed = home / ".agents" / "skills"
        shutil.copytree(source, installed)
        return smoke.subprocess.CompletedProcess(
            smoke.REAL_NPX_COMMAND,
            0,
            stdout="installed to universal skills\n",
            stderr="",
        )

    monkeypatch.setattr(smoke, "run_real_npx", fake_run_real_npx)
    result = smoke.run_smoke(
        real_npx=True,
        source_skills_root=source,
        skill_names=["hej"],
    )

    assert result.ok is True
    assert result.real_npx_attempted is True
    assert result.errors == []
    assert result.installed_root.parts[-2:] == (".agents", "skills")
