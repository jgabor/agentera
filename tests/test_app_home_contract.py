from __future__ import annotations

import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "validate_app_home_contract.py"


def test_app_home_contract_validator_passes_current_user_surfaces() -> None:
    result = subprocess.run(
        [sys.executable, str(VALIDATOR), "--root", str(REPO_ROOT)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "OK: app-home contract terminology is release-ready" in result.stdout


def test_app_home_contract_validator_reports_offending_surface(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text(
        "AGENTERA_HOME points at the live bundle root\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), "--root", str(tmp_path)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    assert "README.md:1" in result.stderr
    assert "live-bundle wording" in result.stderr


def test_app_home_contract_validator_inspects_authoritative_contract_reference(tmp_path: Path) -> None:
    contract = tmp_path / "skills" / "agentera" / "references" / "contract.md"
    contract.parent.mkdir(parents=True)
    contract.write_text(
        "AGENTERA_HOME names the agentera install root where helper scripts live\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), "--root", str(tmp_path)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    assert "skills/agentera/references/contract.md:1" in result.stderr
    assert "AGENTERA_HOME named as install root" in result.stderr


def test_app_home_contract_validator_inspects_cli_output(tmp_path: Path) -> None:
    cli = tmp_path / "scripts" / "agentera"
    cli.parent.mkdir(parents=True)
    cli.write_text(
        "import sys\nprint('AGENTERA_HOME points at the live bundle root')\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), "--root", str(tmp_path)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    assert "agentera hej" in result.stderr
    assert "live-bundle wording" in result.stderr


def test_app_home_contract_validator_inspects_upgrade_output(tmp_path: Path) -> None:
    cli = tmp_path / "scripts" / "agentera"
    cli.parent.mkdir(parents=True)
    cli.write_text(
        "import sys\n"
        "if len(sys.argv) > 1 and sys.argv[1] == 'upgrade':\n"
        "    print('install root: /tmp/agentera')\n"
        "    print('{\\\"installRoot\\\": \\\"/tmp/agentera\\\"}')\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), "--root", str(tmp_path)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    assert "agentera upgrade --only bundle --dry-run" in result.stderr
    assert "CLI output names app home as install root" in result.stderr
    assert "public JSON exposes installRoot instead of appHome" in result.stderr


def test_app_home_contract_validator_rejects_structured_cli_install_root_fields(tmp_path: Path) -> None:
    cli = tmp_path / "scripts" / "agentera"
    cli.parent.mkdir(parents=True)
    cli.write_text(
        "import sys\n"
        "if len(sys.argv) > 1 and sys.argv[1] in {'hej', 'doctor'}:\n"
        "    print('{\"installRoot\": \"/tmp/agentera\", \"installRootSource\": \"AGENTERA_HOME\"}')\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), "--root", str(tmp_path)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    assert "agentera hej --format json" in result.stderr
    assert "agentera doctor --json" in result.stderr
    assert "public JSON exposes installRoot instead of appHome" in result.stderr
