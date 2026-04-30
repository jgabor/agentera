#!/usr/bin/env python3
"""Offline smoke-test for installed Agentera skill bundles.

Default mode is offline and credential-free. It creates an isolated HOME and
XDG config directory, mirrors the repository's skill payload into that sandbox,
and validates the installed shape without invoking a runtime or package manager.

Real ``npx skills`` verification is deliberately opt-in via ``--real-npx``.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
REGISTRY = REPO_ROOT / "registry.json"
SOURCE_SKILLS = REPO_ROOT / "skills"
SUPPORT_DIRS = ("references", "scripts", "agents")
LOCAL_SUPPORT_PREFIXES = tuple(f"{name}/" for name in SUPPORT_DIRS)
REAL_NPX_COMMAND = ("npx", "skills", "add", "jgabor/agentera", "-g", "-a", "opencode", "-y")


@dataclass(frozen=True)
class SmokeResult:
    ok: bool
    installed_root: Path
    errors: list[str]
    checked_skills: list[str]
    real_npx_attempted: bool


def load_registry_skill_names(registry_path: Path = REGISTRY) -> list[str]:
    payload = json.loads(registry_path.read_text(encoding="utf-8"))
    return [skill["name"] for skill in payload["skills"]]


def extract_support_refs(text: str) -> list[str]:
    """Use the release validator's parser so smoke and spec checks agree."""
    scripts_dir = str(REPO_ROOT / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    import validate_spec  # type: ignore[import-not-found]

    return validate_spec._extract_support_refs(text)


def prepare_offline_install(source_root: Path, installed_root: Path) -> None:
    """Copy the package surfaces needed to inspect installed skill bundles."""
    if installed_root.exists():
        shutil.rmtree(installed_root)
    installed_root.mkdir(parents=True)
    shutil.copy2(REGISTRY, installed_root / "registry.json")
    shutil.copytree(source_root, installed_root / "skills")
    for dirname in ("scripts", "hooks"):
        source = REPO_ROOT / dirname
        if source.exists():
            shutil.copytree(source, installed_root / dirname)


def resolve_installed_roots(installed_root: Path) -> tuple[Path, Path]:
    """Return ``(package_root, skills_root)`` for a package or skills path."""
    if (installed_root / "skills").is_dir():
        return installed_root, installed_root / "skills"
    return installed_root.parent, installed_root


def validate_installed_bundles(
    installed_root: Path,
    *,
    source_skills_root: Path = SOURCE_SKILLS,
    skill_names: list[str] | None = None,
) -> SmokeResult:
    package_root, skills_root = resolve_installed_roots(installed_root)
    names = skill_names or load_registry_skill_names()
    errors: list[str] = []

    for name in names:
        source_skill = source_skills_root / name
        installed_skill = skills_root / name
        skill_md = installed_skill / "SKILL.md"

        if not skill_md.is_file():
            errors.append(f"{name}: missing SKILL.md")
            continue

        for dirname in SUPPORT_DIRS:
            if (source_skill / dirname).is_dir() and not (installed_skill / dirname).is_dir():
                errors.append(f"{name}: missing bundled support directory {dirname}/")

        for ref in extract_support_refs(skill_md.read_text(encoding="utf-8")):
            if not ref.startswith(LOCAL_SUPPORT_PREFIXES):
                continue
            local_path = installed_skill / ref
            package_path = package_root / ref
            source_local_path = source_skill / ref
            if local_path.exists() or package_path.exists():
                continue
            if not ref.startswith("references/") and not source_local_path.exists():
                # Suite-root helper prose is valid in package installs but may
                # be absent from skill-only runtime surfaces.
                continue
            if ref.startswith("scripts/"):
                cross_skill_path = next(skills_root.glob(f"*/{ref}"), None)
                if cross_skill_path is not None:
                    continue
            errors.append(f"{name}: missing bundled support file {ref}")

    return SmokeResult(
        ok=not errors,
        installed_root=installed_root,
        errors=errors,
        checked_skills=names,
        real_npx_attempted=False,
    )


def run_real_npx(home: Path, config_home: Path) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.update(
        {
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(config_home),
        }
    )
    return subprocess.run(
        REAL_NPX_COMMAND,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def run_smoke(
    *,
    installed_root: Path | None = None,
    real_npx: bool = False,
    skill_names: list[str] | None = None,
    source_skills_root: Path = SOURCE_SKILLS,
) -> SmokeResult:
    with tempfile.TemporaryDirectory(prefix="agentera-install-smoke-") as tmp:
        sandbox = Path(tmp)
        home = sandbox / "home"
        config_home = sandbox / "config"
        home.mkdir()
        config_home.mkdir()

        target = installed_root or sandbox / "agentera"
        if real_npx:
            result = run_real_npx(home, config_home)
            if result.returncode != 0:
                return SmokeResult(
                    ok=False,
                    installed_root=target,
                    errors=[f"real npx skills failed with exit {result.returncode}: {result.stderr.strip() or result.stdout.strip()}"],
                    checked_skills=[],
                    real_npx_attempted=True,
                )
            if installed_root is None:
                target = config_home / "opencode" / "skills"
        elif installed_root is None:
            prepare_offline_install(SOURCE_SKILLS, target)

        smoke = validate_installed_bundles(
            target,
            source_skills_root=source_skills_root,
            skill_names=skill_names,
        )
        return SmokeResult(
            ok=smoke.ok,
            installed_root=target,
            errors=smoke.errors,
            checked_skills=smoke.checked_skills,
            real_npx_attempted=real_npx,
        )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--installed-root",
        type=Path,
        help="Validate an existing installed package root or skills directory instead of creating an offline sandbox.",
    )
    parser.add_argument(
        "--real-npx",
        action="store_true",
        help="Opt in to running `npx skills add jgabor/agentera -g -a opencode -y` before validation.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    result = run_smoke(installed_root=args.installed_root, real_npx=args.real_npx)
    if result.ok:
        npx = "attempted" if result.real_npx_attempted else "not attempted"
        print(
            f"PASS: installed skill bundle smoke checked {len(result.checked_skills)} skills; "
            f"real npx {npx}"
        )
        return 0
    for error in result.errors:
        print(f"FAIL: {error}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
