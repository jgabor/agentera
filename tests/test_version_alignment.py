from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent


def _authoritative_version() -> str:
    registry = json.loads((REPO_ROOT / "registry.json").read_text(encoding="utf-8"))
    version = registry["skills"][0]["version"]
    assert isinstance(version, str) and version
    return version


def _version_files() -> list[str]:
    docs = yaml.safe_load((REPO_ROOT / ".agentera" / "docs.yaml").read_text(encoding="utf-8"))
    return list(docs["conventions"]["version_files"])


def _version_in_file(path: str, version: str) -> bool:
    text = (REPO_ROOT / path).read_text(encoding="utf-8")
    return version in text


def test_version_files_align_with_registry() -> None:
    version = _authoritative_version()
    for path in _version_files():
        assert _version_in_file(path, version), f"{path} does not contain version {version}"


def test_changelog_has_release_header() -> None:
    version = _authoritative_version()
    changelog = (REPO_ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    assert f"## [{version}]" in changelog, f"CHANGELOG.md missing release header for [{version}]"


def test_git_tag_matches_version() -> None:
    version = _authoritative_version()
    result = subprocess.run(
        ["git", "tag", "-l", f"v{version}"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    tag = result.stdout.strip()
    if not tag:
        pytest.skip(f"git tag v{version} not created yet; tag at release approval")
    assert tag == f"v{version}", f"git tag v{version} not found"
