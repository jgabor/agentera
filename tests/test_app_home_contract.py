from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR_PATH = REPO_ROOT / "scripts" / "validate_app_home_contract.py"


def _load_validator() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "validate_app_home_contract",
        VALIDATOR_PATH,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def validator() -> ModuleType:
    return _load_validator()


def test_app_home_contract_validator_passes_current_user_surfaces(validator: ModuleType) -> None:
    errors = validator.validate(REPO_ROOT)
    assert errors == []


@pytest.mark.integration
def test_app_home_contract_validator_cli_smoke() -> None:
    result = subprocess.run(
        [sys.executable, str(VALIDATOR_PATH), "--root", str(REPO_ROOT)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "OK: app-home contract terminology is release-ready" in result.stdout


def test_app_home_contract_validator_reports_offending_surface(
    validator: ModuleType,
    tmp_path: Path,
) -> None:
    (tmp_path / "README.md").write_text(
        "AGENTERA_HOME points at the live bundle root\n",
        encoding="utf-8",
    )

    errors = validator.validate(tmp_path)

    assert errors
    assert any("README.md:1" in error for error in errors)
    assert any("live-bundle wording" in error for error in errors)


def test_app_home_contract_validator_rejects_recovery_jargon(
    validator: ModuleType,
    tmp_path: Path,
) -> None:
    (tmp_path / "README.md").write_text(
        "Agentera-managed bundle install is blocked; use the platform app-home recovery path\n",
        encoding="utf-8",
    )

    errors = validator.validate(tmp_path)

    assert errors
    assert any("README.md:1" in error for error in errors)
    assert any("jargon in recovery wording" in error for error in errors)


def test_app_home_contract_validator_inspects_authoritative_contract_reference(
    validator: ModuleType,
    tmp_path: Path,
) -> None:
    contract = tmp_path / "skills" / "agentera" / "references" / "contract.md"
    contract.parent.mkdir(parents=True)
    contract.write_text(
        "AGENTERA_HOME names the agentera install root where helper scripts live\n",
        encoding="utf-8",
    )

    errors = validator.validate(tmp_path)

    assert errors
    assert any("skills/agentera/references/contract.md:1" in error for error in errors)
    assert any("AGENTERA_HOME named as install root" in error for error in errors)


def test_app_home_contract_validator_inspects_cli_output(
    validator: ModuleType,
    tmp_path: Path,
) -> None:
    cli = tmp_path / "scripts" / "agentera"
    cli.parent.mkdir(parents=True)
    cli.write_text(
        "import sys\nprint('AGENTERA_HOME points at the live bundle root')\n",
        encoding="utf-8",
    )

    errors = validator.validate(tmp_path)

    assert errors
    assert any("agentera hej" in error for error in errors)
    assert any("live-bundle wording" in error for error in errors)


def test_app_home_contract_validator_inspects_upgrade_output(
    validator: ModuleType,
    tmp_path: Path,
) -> None:
    cli = tmp_path / "scripts" / "agentera"
    cli.parent.mkdir(parents=True)
    cli.write_text(
        "import sys\n"
        "if len(sys.argv) > 1 and sys.argv[1] == 'upgrade':\n"
        "    print('install root: /tmp/agentera')\n"
        "    print('{\\\"installRoot\\\": \\\"/tmp/agentera\\\"}')\n",
        encoding="utf-8",
    )

    errors = validator.validate(tmp_path)

    assert errors
    assert any("--runtime claude --dry-run" in error for error in errors)
    assert any("CLI output names app home as install root" in error for error in errors)
    assert any("public JSON exposes installRoot instead of appHome" in error for error in errors)


def test_app_home_contract_validator_rejects_structured_cli_install_root_fields(
    validator: ModuleType,
    tmp_path: Path,
) -> None:
    cli = tmp_path / "scripts" / "agentera"
    cli.parent.mkdir(parents=True)
    cli.write_text(
        "import sys\n"
        "if len(sys.argv) > 1 and sys.argv[1] in {'hej', 'doctor'}:\n"
        "    print('{\"installRoot\": \"/tmp/agentera\", \"installRootSource\": \"AGENTERA_HOME\"}')\n",
        encoding="utf-8",
    )

    errors = validator.validate(tmp_path)

    assert errors
    assert any("agentera hej --format json" in error for error in errors)
    assert any("agentera doctor --json" in error for error in errors)
    assert any("public JSON exposes installRoot instead of appHome" in error for error in errors)
