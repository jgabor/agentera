#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Upgrade orchestration for Agentera v1-to-v2 installs.

This module is imported by ``scripts/agentera``. It deliberately keeps
side effects behind ``--yes`` and returns a structured plan so the upgrade
path is repeatable and testable.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
BOOTSTRAP_SOURCE_ROOT_ENV = "AGENTERA_BOOTSTRAP_SOURCE_ROOT"
DEFAULT_INSTALL_ROOT_ENV = "AGENTERA_DEFAULT_INSTALL_ROOT"
BUNDLE_MARKER = ".agentera-bundle.json"
PHASES = ("bundle", "artifacts", "runtime", "cleanup", "packages")
STATUSES = ("pending", "applied", "noop", "blocked", "failed", "skipped")
EXPECTED_STATE_COMMANDS = ("hej",)
USER_STATE_NAMES = ("PROFILE.md", "USAGE.md", "history", "corpus", "corpus.json")
ROOT_USER_STATE_NAMES = (*USER_STATE_NAMES, "TODO.md", "CHANGELOG.md", "DESIGN.md")
AGENTERA_USER_STATE_NAMES = (
    "progress.yaml",
    "decisions.yaml",
    "health.yaml",
    "plan.yaml",
    "docs.yaml",
    "session.yaml",
)



def _load_script_module(name: str, path: Path) -> ModuleType:
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    if spec is None:
        raise RuntimeError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    loader.exec_module(module)
    return module


def _migrate_module() -> ModuleType:
    return _load_script_module("agentera_migrate_artifacts", ROOT / "scripts" / "migrate_artifacts_v1_to_v2")


def _detect_module() -> ModuleType:
    return _load_script_module("agentera_detect_stale_v1", ROOT / "scripts" / "detect_stale_v1")


def _setup_codex_module() -> ModuleType:
    return _load_script_module("agentera_setup_codex", ROOT / "scripts" / "setup_codex.py")


def _setup_copilot_module() -> ModuleType:
    return _load_script_module("agentera_setup_copilot", ROOT / "scripts" / "setup_copilot.py")


def _setup_doctor_module() -> ModuleType:
    return _load_script_module("agentera_setup_doctor", ROOT / "scripts" / "setup_doctor.py")


def _install_root_module() -> ModuleType:
    return _load_script_module("agentera_install_root", ROOT / "scripts" / "install_root.py")


def _runtime_registry_module() -> ModuleType:
    return _load_script_module("agentera_runtime_adapter_registry", ROOT / "scripts" / "runtime_adapter_registry.py")


def _runtime_registry() -> Any:
    return _runtime_registry_module().load_registry()


def _runtime_ids() -> tuple[str, ...]:
    return _runtime_registry().runtime_ids


def _package_registry_module() -> ModuleType:
    return _load_script_module("agentera_package_registry", ROOT / "scripts" / "package_registry.py")


def _package_registry() -> Any:
    return _package_registry_module().load_registry()


def _relative(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def _read_text_or_none(path: Path) -> str | None:
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def _sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _source_root_missing(root: Path) -> list[str]:
    install_root = _install_root_module()
    return [entry for entry in install_root.SETUP_EVIDENCE if not (root / entry).exists()]


def _classify_root(root: Path, *, source: str = "explicit", expected_version: str | None = None) -> Any:
    return _install_root_module().classify_resolved_root(root, source=source, expected_version=expected_version)


def _active_bundle_root(app_home: Path) -> Path:
    return _doctor_roots(app_home)["active_bundle_root"]


def _valid_install_root(root: Path) -> bool:
    classification = _classify_root(_active_bundle_root(root))
    return classification.managed_status == "managed"


def _load_suite_version(source_root: Path) -> str | None:
    pkg = _package_registry()
    record = pkg.get("agentera")
    authority = record["version_authority"]
    authority_path = source_root / authority["persisted_authority"]
    if not authority_path.is_file():
        return None
    try:
        data = json.loads(authority_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if authority["selector"] != "skills[0].version":
        return None
    skills = data.get("skills")
    if not isinstance(skills, list) or not skills:
        return None
    first = skills[0]
    version = first.get("version") if isinstance(first, dict) else None
    return version if isinstance(version, str) and version else None


def load_suite_version(source_root: Path) -> str | None:
    return _load_suite_version(source_root)


def _read_bundle_marker(install_root: Path) -> dict[str, Any] | None:
    marker = _bundle_marker_path(install_root)
    if not marker.is_file():
        return None
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _bundle_marker_path(install_root: Path) -> Path:
    return install_root / BUNDLE_MARKER


def _managed_app_root(app_home: Path) -> Path:
    return app_home / "app"


def _legacy_default_app_home(home: Path) -> Path:
    return (home / ".agents" / "agentera").expanduser().resolve()


def _is_recoverable_stale_default_app_home(app_home: Path, *, root_source: str, home: Path) -> bool:
    return root_source == "AGENTERA_HOME" and app_home == _legacy_default_app_home(home)


def _platform_default_app_home(home: Path, env: dict[str, str]) -> Path:
    default_env = dict(env)
    default_env.pop("AGENTERA_HOME", None)
    default_env.pop(DEFAULT_INSTALL_ROOT_ENV, None)
    root, _source = _install_root_module().resolve_candidate(None, env=default_env, home=home)
    return root.resolve()


def _legacy_app_home_has_bundle(app_home: Path) -> bool:
    return _has_bundle_root_evidence(app_home) and not (app_home / ".git").exists()


def _agentera_user_state_dir_is_recognized(path: Path) -> bool:
    allowed = set(AGENTERA_USER_STATE_NAMES)
    if not path.is_dir():
        return False
    for entry in path.iterdir():
        if entry.name in allowed and entry.is_file():
            continue
        if entry.name == "optimera" and entry.is_dir():
            continue
        return False
    return True


def _app_home_is_user_data_only(app_home: Path) -> bool:
    """Return true only for app homes containing known Agentera user state."""
    if not app_home.exists():
        return True
    if not app_home.is_dir():
        return False
    allowed_root_files = set(ROOT_USER_STATE_NAMES)
    has_user_state = False
    for entry in app_home.iterdir():
        if entry.name in allowed_root_files and entry.is_file():
            has_user_state = True
            continue
        if entry.name == ".agentera" and _agentera_user_state_dir_is_recognized(entry):
            has_user_state = True
            continue
        return False
    return has_user_state


def _bundle_target_is_safe(app_home: Path, *, expected_version: str | None = None) -> bool:
    if not app_home.exists():
        return True
    if not app_home.is_dir():
        return False
    app_root = _managed_app_root(app_home)
    if app_root.exists():
        return _classify_root(app_root, expected_version=expected_version).managed_status == "managed"
    if _legacy_app_home_has_bundle(app_home):
        return _classify_root(app_home, expected_version=expected_version).managed_status == "managed"
    return _app_home_is_user_data_only(app_home)


def _shell_quote(value: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_@%+=:,./-]+", value):
        return value
    return "'" + value.replace("'", "'\"'\"'") + "'"


def _command_text(parts: list[str]) -> str:
    return " ".join(_shell_quote(part) for part in parts)


def resolve_doctor_install_root(
    value: Path | None,
    *,
    home: Path,
    env: dict[str, str] | None = None,
) -> tuple[Path, str]:
    env = env or os.environ
    root, source = _install_root_module().resolve_candidate(value, env=env, home=home)
    return root, _install_root_module().SOURCE_LABELS.get(source, source)


def _source_key(root_source: str) -> str:
    labels = _install_root_module().SOURCE_LABELS
    for key, label in labels.items():
        if root_source == label:
            return key
    if root_source == "AGENTERA_HOME":
        return "environment"
    return "explicit"


def _probe_bundle_cli(
    bundle_root: Path,
    *,
    app_home: Path,
    project: Path,
    expected_commands: tuple[str, ...],
) -> dict[str, Any]:
    cli = bundle_root / "scripts" / "agentera"
    if not cli.is_file():
        return {
            "ok": False,
            "command": None,
            "returnCode": None,
            "stdoutTail": [],
            "stderrTail": [],
            "missingCommands": list(expected_commands),
            "message": "scripts/agentera is missing",
        }
    command = ["uv", "run", str(cli), "--help"]
    try:
        result = subprocess.run(
            command,
            cwd=project,
            env={**os.environ, "AGENTERA_HOME": str(app_home)},
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {
            "ok": False,
            "command": command,
            "returnCode": None,
            "stdoutTail": [],
            "stderrTail": [str(exc)],
            "missingCommands": list(expected_commands),
            "message": f"CLI probe failed before command discovery: {exc}",
        }
    output = result.stdout + "\n" + result.stderr
    missing = [
        name
        for name in expected_commands
        if re.search(rf"\b{re.escape(name)}\b", output) is None
    ]
    return {
        "ok": result.returncode == 0 and not missing,
        "command": command,
        "returnCode": result.returncode,
        "stdoutTail": result.stdout.splitlines()[-5:],
        "stderrTail": result.stderr.splitlines()[-5:],
        "missingCommands": missing,
        "message": (
            "CLI help lists expected state commands"
            if result.returncode == 0 and not missing
            else "CLI help failed or is missing expected state commands"
        ),
    }


def _has_bundle_root_evidence(root: Path) -> bool:
    return (root / "scripts" / "agentera").is_file() and (root / "skills" / "agentera" / "SKILL.md").is_file()


def _doctor_roots(app_home: Path) -> dict[str, Path]:
    managed_app_root = app_home / "app"
    if _has_bundle_root_evidence(managed_app_root):
        active_bundle_root = managed_app_root
    elif managed_app_root.exists():
        active_bundle_root = managed_app_root
    elif _has_bundle_root_evidence(app_home):
        active_bundle_root = app_home
    else:
        active_bundle_root = app_home
    return {
        "app_home": app_home,
        "managed_app_root": managed_app_root,
        "active_bundle_root": active_bundle_root,
        "skill_root": active_bundle_root / "skills" / "agentera",
        "runtime_root": ROOT,
    }


def _recoverable_stale_default_signal(app_home: Path, roots: dict[str, Path]) -> dict[str, str]:
    return {
        "status": "stale",
        "kind": "recoverable_stale_default",
        "message": "Agentera found an old app directory and can repair it without asking you to edit shell settings",
        "deprecatedDefaultAppHome": str(app_home),
        "managedAppRoot": str(roots["managed_app_root"]),
    }


def _user_data_only_signal(app_home: Path, roots: dict[str, Path]) -> dict[str, str]:
    return {
        "status": "stale",
        "kind": "user_data_only_app_home",
        "message": "This Agentera directory only has your Agentera data, so Agentera can safely add fresh app files under app/",
        "appHome": str(app_home),
        "managedAppRoot": str(roots["managed_app_root"]),
    }


def _blocked_root_recovery_message(root_source: str) -> str:
    if root_source == "AGENTERA_HOME":
        return "choose a different Agentera directory, or use --force only if you checked this directory and want Agentera to replace files there"
    return "choose a different Agentera directory, or use --force only if you checked this directory and want Agentera to replace files there"


def resolve_active_app_model(
    value: Path | None = None,
    *,
    home: Path | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Path | str]:
    """Return the active app roots used by doctor without running diagnostics."""
    resolved_home = home or Path.home()
    app_home, app_home_source = resolve_doctor_install_root(value, home=resolved_home, env=env)
    roots = _doctor_roots(app_home)
    return {
        "appHome": roots["app_home"],
        "appHomeSource": app_home_source,
        "managedAppRoot": roots["managed_app_root"],
        "activeBundleRoot": roots["active_bundle_root"],
        "authoritativeRoot": roots["managed_app_root"],
        "skillRoot": roots["skill_root"],
        "runtimeRoot": roots["runtime_root"],
    }


def build_doctor_status(
    install_root: Path,
    *,
    root_source: str,
    source_root: Path,
    home: Path,
    project: Path,
    expected_version: str | None = None,
    expected_commands: tuple[str, ...] = EXPECTED_STATE_COMMANDS,
    probe_cli: bool = True,
) -> dict[str, Any]:
    expected = expected_version or _load_suite_version(source_root) or "unknown"
    roots = _doctor_roots(install_root)
    active_bundle_root = roots["active_bundle_root"]
    classification = _classify_root(active_bundle_root, source=_source_key(root_source), expected_version=expected)
    marker_version = classification.current_version
    signals: list[dict[str, Any]] = []
    blocked = False
    recoverable_stale_default = _is_recoverable_stale_default_app_home(install_root, root_source=root_source, home=home)
    legacy_bundle_root = (
        active_bundle_root == install_root
        and _has_bundle_root_evidence(install_root)
        and not (install_root / ".git").exists()
    )

    if classification.kind == "missing_default":
        root_status = "missing"
        signals.append({
            "status": "stale",
            "kind": "missing_bundle",
            "message": "Agentera is not installed in the normal directory yet",
        })
    elif classification.kind == "missing_explicit_or_environment" and recoverable_stale_default:
        root_status = "missing"
        signals.append(_recoverable_stale_default_signal(install_root, roots))
    elif classification.kind == "missing_explicit_or_environment":
        root_status = "missing"
        blocked = True
        signals.append({
            "status": "blocked",
            "kind": "invalid_install_root",
            "message": (
                "Agentera was told to use a directory that does not exist. "
                "Choose an existing Agentera directory, or install into the normal Agentera directory."
            ),
        })
    elif classification.kind == "file_valued_root":
        root_status = "invalid"
        blocked = True
        signals.append({
            "status": "blocked",
            "kind": "invalid_install_root",
            "message": f"Agentera was told to use a file instead of a directory; {_blocked_root_recovery_message(root_source)}",
        })
    elif classification.kind in {"invalid_bundle", "unmanaged_directory"} and recoverable_stale_default:
        root_status = "stale_default"
        signals.append(_recoverable_stale_default_signal(install_root, roots))
    elif classification.kind == "unmanaged_directory" and _app_home_is_user_data_only(install_root):
        root_status = "user_data_only"
        signals.append(_user_data_only_signal(install_root, roots))
    elif classification.kind == "unmanaged_directory":
        root_status = "unmanaged"
        blocked = True
        signals.append({
            "status": "blocked",
            "kind": "unmanaged_install_root",
            "message": f"This directory already has files Agentera does not recognize, so Agentera will not change it automatically; {_blocked_root_recovery_message(root_source)}",
        })
    elif classification.kind == "invalid_bundle":
        root_status = "invalid"
        blocked = True
        signals.append({
            "status": "blocked",
            "kind": "invalid_bundle",
            "message": f"This directory looks like a broken Agentera install; {_blocked_root_recovery_message(root_source)}",
        })
    else:
        root_status = "managed"
        if legacy_bundle_root:
            signals.append({
                "status": "migration_required",
                "kind": "migration_required",
                "message": "Agentera app files are in the old place and can be moved into app/",
                "legacyBundleRoot": str(install_root),
                "managedAppRoot": str(roots["managed_app_root"]),
            })
        reason = classification.diagnostic.evidence.get("reason")
        if classification.kind == "managed_stale" and reason == "missing_marker":
            if recoverable_stale_default:
                signals.append(_recoverable_stale_default_signal(install_root, roots))
            signals.append({
                "status": "stale",
                "kind": "missing_marker",
                "message": "Agentera cannot prove these app files are current, so it should refresh them",
            })
        elif classification.kind == "managed_stale" and reason == "version_mismatch":
            if recoverable_stale_default:
                signals.append(_recoverable_stale_default_signal(install_root, roots))
            signals.append({
                "status": "stale",
                "kind": "version_mismatch",
                "expected": expected,
                "actual": marker_version,
                "message": "Agentera app files are from a different version and should be refreshed",
            })
        probe = (
            _probe_bundle_cli(
                active_bundle_root,
                app_home=install_root,
                project=project,
                expected_commands=expected_commands,
            )
            if probe_cli
            else {"ok": True}
        )
        if not probe["ok"]:
            kind = "cli_probe_unavailable"
            if probe["returnCode"] is not None and probe["returnCode"] != 0:
                kind = "cli_probe_failed"
            elif probe["missingCommands"]:
                kind = "missing_command"
            signals.append({
                "status": "stale",
                "kind": kind,
                "message": probe["message"],
                "returnCode": probe["returnCode"],
                "missingCommands": probe["missingCommands"],
                "stdoutTail": probe["stdoutTail"],
                "stderrTail": probe["stderrTail"],
            })

    preview_parts = [
        "uvx",
        "--from",
        "git+https://github.com/jgabor/agentera",
        "agentera",
        "upgrade",
        "--only",
        "bundle",
        "--install-root",
        str(install_root),
        "--dry-run",
    ]
    apply_parts = [
        "uvx",
        "--from",
        "git+https://github.com/jgabor/agentera",
        "agentera",
        "upgrade",
        "--only",
        "bundle",
        "--install-root",
        str(install_root),
        "--yes",
    ]
    status = "blocked" if blocked else "migration_required" if any(signal["kind"] == "migration_required" for signal in signals) else "stale" if signals else "fresh"
    return {
        "schemaVersion": "agentera.bundleStatus.v1",
        "status": status,
        "expectedVersion": expected,
        "appHome": str(install_root),
        "appHomeSource": root_source,
        "managedAppRoot": str(roots["managed_app_root"]),
        "userDataRoot": str(install_root),
        "activeBundleRoot": str(active_bundle_root),
        "authoritativeRoot": str(roots["managed_app_root"]),
        "skillRoot": str(roots["skill_root"]),
        "runtimeRoot": str(roots["runtime_root"]),
        "sourceRoot": str(source_root),
        "installRoot": str(install_root),
        "installRootSource": root_source,
        "home": str(home),
        "project": str(project),
        "rootStatus": root_status,
        "markerVersion": marker_version,
        "signals": signals,
        "dryRunCommand": None if blocked else _command_text(preview_parts),
        "applyCommand": None if blocked else _command_text(apply_parts),
        "retryCommand": _command_text([
            "uv",
            "run",
            str(active_bundle_root / "scripts" / "agentera"),
            "hej",
        ]),
        "approval": f"approve app refresh for {install_root}",
    }


def _skip_bundle_path(path: Path, skip_parts: set[str], skip_suffixes: set[str]) -> bool:
    return any(part in skip_parts for part in path.parts) or path.suffix in skip_suffixes


def _bundle_rel_paths(source_root: Path) -> list[Path]:
    pkg = _package_registry()
    bs = pkg.get("agentera")["bundle_surfaces"]
    directories = tuple(entry["path"] for entry in bs["directories"])
    files = tuple(entry["path"] for entry in bs["files"])
    skip_parts = set(bs["skip_parts"])
    skip_suffixes = set(bs["skip_suffixes"])
    paths: set[Path] = set()
    for directory in directories:
        root = source_root / directory
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if path.is_file() and not _skip_bundle_path(path, skip_parts, skip_suffixes):
                paths.add(path.relative_to(source_root))
    for filename in files:
        path = source_root / filename
        if path.is_file() and not _skip_bundle_path(path, skip_parts, skip_suffixes):
            paths.add(path.relative_to(source_root))
    return sorted(paths)


def _copy_bundle_file(source_root: Path, bundle_root: Path, rel_path: Path) -> None:
    source = source_root / rel_path
    target = bundle_root / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def _remove_empty_parents(path: Path, stop_at: Path) -> None:
    current = path.parent
    while current != stop_at and stop_at in current.parents:
        try:
            current.rmdir()
        except OSError:
            break
        current = current.parent


def _remove_legacy_bundle_files(app_home: Path, rel_paths: list[Path]) -> int:
    removed = 0
    for rel_path in sorted(rel_paths, key=lambda path: len(path.parts), reverse=True):
        target = app_home / rel_path
        if target.is_file() or target.is_symlink():
            target.unlink()
            removed += 1
            _remove_empty_parents(target, app_home)
    marker = _bundle_marker_path(app_home)
    if marker.is_file() or marker.is_symlink():
        marker.unlink()
        removed += 1
    return removed


def _legacy_default_has_agentera_evidence(root: Path) -> bool:
    if not root.exists():
        return False
    return any((
        _has_bundle_root_evidence(root),
        _managed_app_has_bundle(root),
        _bundle_marker_path(root).exists(),
        _app_home_is_user_data_only(root) and any(root.iterdir()) if root.is_dir() else False,
    ))


def _managed_app_has_bundle(app_home: Path) -> bool:
    managed_app = _managed_app_root(app_home)
    return _has_bundle_root_evidence(managed_app) or _bundle_marker_path(managed_app).exists()


def _managed_top_level_names(rel_paths: list[Path]) -> set[str]:
    names = {rel_path.parts[0] for rel_path in rel_paths if rel_path.parts}
    names.update({BUNDLE_MARKER, "app"})
    return names


def _legacy_default_user_entries(legacy_root: Path, rel_paths: list[Path]) -> list[Path]:
    if not legacy_root.is_dir():
        return []
    managed_names = _managed_top_level_names(rel_paths)
    return sorted((entry for entry in legacy_root.iterdir() if entry.name not in managed_names), key=lambda path: path.name)


def _same_file(source: Path, target: Path) -> bool:
    return source.is_file() and target.is_file() and _sha256(source) == _sha256(target)


def _legacy_default_conflicts(legacy_root: Path, app_home: Path, rel_paths: list[Path]) -> list[str]:
    conflicts: list[str] = []
    for entry in _legacy_default_user_entries(legacy_root, rel_paths):
        target = app_home / entry.name
        if target.exists() and not _same_file(entry, target):
            conflicts.append(entry.name)
    return conflicts


def _legacy_default_managed_count(legacy_root: Path, rel_paths: list[Path]) -> int:
    count = sum(1 for rel_path in rel_paths if (legacy_root / rel_path).exists())
    if _bundle_marker_path(legacy_root).exists():
        count += 1
    if _managed_app_has_bundle(legacy_root):
        count += 1
    return count


def _plan_legacy_default_retirement(
    app_home: Path,
    home: Path,
    rel_paths: list[Path],
    *,
    force: bool,
) -> dict[str, Any] | None:
    legacy_root = _legacy_default_app_home(home)
    if legacy_root == app_home or not _legacy_default_has_agentera_evidence(legacy_root):
        return None
    if not legacy_root.is_dir():
        return {
            "status": "blocked",
            "action": "retire-legacy-default-app-home",
            "source": str(legacy_root),
            "target": str(app_home),
            "message": "The old Agentera location is a file, not a directory, so Agentera will not touch it automatically",
        }

    conflicts = _legacy_default_conflicts(legacy_root, app_home, rel_paths)
    user_entries = [entry.name for entry in _legacy_default_user_entries(legacy_root, rel_paths)]
    managed_count = _legacy_default_managed_count(legacy_root, rel_paths)
    return {
        "status": "blocked" if conflicts and not force else "pending",
        "action": "retire-legacy-default-app-home",
        "source": str(legacy_root),
        "target": str(app_home),
        "appHome": str(app_home),
        "legacyDefaultAppHome": str(legacy_root),
        "userStateCount": len(user_entries),
        "legacyManagedFileCount": managed_count,
        "changedPreview": user_entries[:20],
        "conflicts": conflicts,
        "message": (
            "Some old Agentera data already exists in the new directory; check it before using --force"
            if conflicts and not force
            else "will move your old Agentera data to the current directory and remove old app files"
        ),
    }


def _move_legacy_default_user_state(legacy_root: Path, app_home: Path, rel_paths: list[Path], *, force: bool) -> int:
    moved = 0
    app_home.mkdir(parents=True, exist_ok=True)
    for entry in _legacy_default_user_entries(legacy_root, rel_paths):
        target = app_home / entry.name
        if target.exists():
            if _same_file(entry, target):
                entry.unlink()
                moved += 1
                continue
            if not force or entry.is_dir() or target.is_dir():
                raise RuntimeError(f"legacy user state conflicts with selected app home: {entry.name}")
            target.unlink()
        shutil.move(str(entry), str(target))
        moved += 1
    return moved


def _remove_legacy_default_managed_files(legacy_root: Path, rel_paths: list[Path]) -> int:
    removed = _remove_legacy_bundle_files(legacy_root, rel_paths)
    managed_app = _managed_app_root(legacy_root)
    if managed_app.exists() and _managed_app_has_bundle(legacy_root):
        shutil.rmtree(managed_app)
        removed += 1
    return removed


def _remove_empty_legacy_default_root(legacy_root: Path, home: Path) -> bool:
    removed = False
    try:
        legacy_root.rmdir()
        removed = True
    except OSError:
        return False
    agents_dir = legacy_root.parent
    if agents_dir != home and agents_dir.parent == home:
        try:
            agents_dir.rmdir()
        except OSError:
            pass
    return removed


def plan_bundle_phase(source_root: Path, install_root: Path, home: Path, *, force: bool) -> dict[str, Any]:
    app_root = _managed_app_root(install_root)
    if source_root == install_root or source_root == app_root:
        return _phase(
            "bundle",
            [{
                "status": "noop",
                "action": "install-bundle",
                "source": str(source_root),
                "target": str(app_root),
                "message": "Agentera is already running from the selected app directory",
            }],
        )

    source_missing = _source_root_missing(source_root)
    if source_missing:
        return _phase(
            "bundle",
            [{
                "status": "blocked",
                "action": "install-bundle",
                "source": str(source_root),
                "target": str(install_root),
                "message": f"Agentera cannot find required app files: {', '.join(source_missing)}",
            }],
        )

    if not _bundle_target_is_safe(install_root, expected_version=_load_suite_version(source_root)) and not force:
        return _phase(
            "bundle",
            [{
                "status": "blocked",
                "action": "install-bundle",
                "source": str(source_root),
                "target": str(app_root),
                "message": (
                    "This directory already has files Agentera does not recognize. "
                    "Agentera will not change it automatically. Choose another "
                    "Agentera directory, or use --force only after checking this "
                    "directory is safe to replace."
                ),
            }],
        )

    rel_paths = _bundle_rel_paths(source_root)
    changed: list[str] = []
    for rel_path in rel_paths:
        source = source_root / rel_path
        target = app_root / rel_path
        if _sha256(source) != _sha256(target):
            changed.append(str(rel_path))

    marker_missing = not _bundle_marker_path(app_root).is_file()
    if not changed and not marker_missing:
        status = "noop"
        message = "Agentera app files are already current"
    else:
        status = "pending"
        message = "will install or refresh Agentera app files"

    items = [{
            "status": status,
            "action": "install-bundle",
            "source": str(source_root),
            "target": str(app_root),
            "appHome": str(install_root),
            "fileCount": len(rel_paths),
            "changedCount": len(changed),
            "changedPreview": changed[:20],
            "marker": str(_bundle_marker_path(app_root)),
            "message": message,
        }]
    if _legacy_app_home_has_bundle(install_root):
        legacy_files = [str(path) for path in rel_paths if (install_root / path).exists()]
        legacy_marker = _bundle_marker_path(install_root)
        legacy_count = len(legacy_files) + (1 if legacy_marker.exists() else 0)
        items.append({
            "status": "pending" if legacy_count else "noop",
            "action": "migrate-app-home",
            "source": str(install_root),
            "target": str(app_root),
            "appHome": str(install_root),
            "managedAppRoot": str(app_root),
            "legacyManagedFileCount": legacy_count,
            "changedPreview": legacy_files[:20],
            "message": (
                "will move Agentera app files into app/ and remove old copies from the directory root"
                if legacy_count
                else "old root-level Agentera app files are already removed"
            ),
        })

    legacy_default = _plan_legacy_default_retirement(install_root, home, rel_paths, force=force)
    if legacy_default is not None:
        items.append(legacy_default)

    return _phase("bundle", items)


def apply_bundle_phase(phase: dict[str, Any], source_root: Path, install_root: Path, *, force: bool) -> None:
    app_root = _managed_app_root(install_root)
    rel_paths = _bundle_rel_paths(source_root)
    for item in phase["items"]:
        if item["status"] != "pending":
            continue
        try:
            if not _bundle_target_is_safe(install_root, expected_version=_load_suite_version(source_root)) and not force:
                item["status"] = "blocked"
                item["message"] = "This directory already has files Agentera does not recognize. Agentera will not change it automatically."
                continue
            if item["action"] == "install-bundle":
                for rel_path in rel_paths:
                    _copy_bundle_file(source_root, app_root, rel_path)
                marker = {
                    "schemaVersion": "agentera.bundle.v1",
                    "version": _load_suite_version(source_root),
                    "source": str(source_root),
                    "fileCount": len(rel_paths),
                }
                _bundle_marker_path(app_root).write_text(
                    json.dumps(marker, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8",
                )
                item["message"] = "Agentera app files installed under app/"
            elif item["action"] == "migrate-app-home":
                if not _valid_install_root(install_root):
                    item["status"] = "blocked"
                    item["message"] = "Agentera could not find the refreshed app files after install"
                    continue
                removed = _remove_legacy_bundle_files(install_root, rel_paths)
                item["legacyManagedFileCount"] = removed
                item["message"] = "Agentera app files moved into app/"
            elif item["action"] == "retire-legacy-default-app-home":
                if not _valid_install_root(install_root):
                    item["status"] = "blocked"
                    item["message"] = "Agentera could not find the selected app directory after install"
                    continue
                legacy_root = Path(item["source"])
                moved = _move_legacy_default_user_state(legacy_root, install_root, rel_paths, force=force)
                removed = _remove_legacy_default_managed_files(legacy_root, rel_paths)
                item["userStateCount"] = moved
                item["legacyManagedFileCount"] = removed
                item["removedLegacyDefaultAppHome"] = _remove_empty_legacy_default_root(legacy_root, install_root.parent)
                item["message"] = "old Agentera directory cleaned up"
        except Exception as exc:  # noqa: BLE001
            item["status"] = "failed"
            item["message"] = f"Agentera app repair failed: {exc}"
            continue
        item["status"] = "applied"
    phase.update(_phase("bundle", phase["items"], message=phase.get("message", "")))


def _phase(name: str, items: list[dict[str, Any]], *, message: str = "") -> dict[str, Any]:
    summary = {status: 0 for status in STATUSES}
    for item in items:
        summary[item["status"]] += 1
    if summary["blocked"]:
        status = "blocked"
    elif summary["failed"]:
        status = "failed"
    elif summary["pending"]:
        status = "pending"
    elif summary["applied"]:
        status = "applied"
    elif summary["skipped"] and not any(summary[s] for s in ("noop", "applied")):
        status = "skipped"
    else:
        status = "noop"
    return {"name": name, "status": status, "summary": summary, "items": items, "message": message}


def _backup_path(project: Path, source: Path) -> Path:
    backup_root = project / ".agentera" / "backup-v1"
    rel = source.relative_to(project)
    if rel.parent == Path(".") or rel.parent == Path(".agentera"):
        return backup_root / rel.name
    return backup_root / rel


def _collect_v1_artifacts(project: Path, migrate: ModuleType) -> list[Path]:
    files: list[Path] = []
    agentera_dir = project / ".agentera"
    for name in migrate.AGENTERA_ARTIFACTS:
        path = agentera_dir / name
        if path.exists():
            files.append(path)
    for name in migrate.ROOT_ARTIFACTS:
        path = project / name
        if path.exists():
            files.append(path)
    files.extend(path for _name, path in migrate._find_optimera_artifacts(project))
    return files


def _migration_output_path(project: Path, source: Path, migrate: ModuleType) -> tuple[Any, Path] | None:
    name = source.name
    if name in migrate.OPTIMERA_PARSERS:
        return migrate.OPTIMERA_PARSERS[name], source.with_name(migrate._strip_md_extension(name) + ".yaml")
    if name in migrate.PARSERS:
        return migrate.PARSERS[name], migrate._get_output_path(name, project)
    return None


def plan_artifact_phase(project: Path, *, force: bool) -> dict[str, Any]:
    migrate = _migrate_module()
    if not project.is_dir():
        return _phase(
            "artifacts",
            [{"status": "blocked", "action": "validate", "message": f"project is not a directory: {project}"}],
        )

    items: list[dict[str, Any]] = []
    for source in _collect_v1_artifacts(project, migrate):
        mapping = _migration_output_path(project, source, migrate)
        if mapping is None:
            items.append({
                "status": "blocked",
                "action": "migrate",
                "source": _relative(source, project),
                "message": "no parser for v1 artifact",
            })
            continue
        parser, output = mapping
        backup = _backup_path(project, source)
        status = "pending"
        message = "will migrate v1 Markdown artifact to v2 YAML and archive source"
        if backup.exists():
            try:
                same_backup = backup.read_bytes() == source.read_bytes()
            except OSError as exc:
                same_backup = False
                message = f"cannot compare existing backup: {exc}"
            if not same_backup and not force:
                status = "blocked"
                message = f"backup already exists with different content: {_relative(backup, project)}"
        try:
            data = parser(source.read_text(encoding="utf-8"))
            clean_data = dict(data)
            warnings = clean_data.pop("warnings", []) if isinstance(data, dict) else []
            byte_count = len(migrate._build_yaml(clean_data, source.name))
        except Exception as exc:  # noqa: BLE001 - parser errors must surface in the plan.
            status = "blocked"
            warnings = []
            byte_count = 0
            message = f"migration parser failed: {exc}"
        items.append({
            "status": status,
            "action": "migrate",
            "source": _relative(source, project),
            "target": _relative(output, project),
            "backup": _relative(backup, project),
            "bytes": byte_count,
            "warnings": warnings,
            "message": message,
        })

    return _phase("artifacts", items, message="no v1 project artifacts found" if not items else "")


def apply_artifact_phase(phase: dict[str, Any], project: Path, *, force: bool) -> None:
    if phase["status"] == "blocked":
        return
    migrate = _migrate_module()
    for item in phase["items"]:
        if item["status"] != "pending":
            continue
        source = project / item["source"]
        target = project / item["target"]
        backup = project / item["backup"]
        mapping = _migration_output_path(project, source, migrate)
        if mapping is None:
            item["status"] = "failed"
            item["message"] = "no parser for v1 artifact"
            continue
        parser, _output = mapping
        try:
            if backup.exists() and backup.read_bytes() != source.read_bytes() and not force:
                item["status"] = "blocked"
                item["message"] = f"backup already exists with different content: {item['backup']}"
                continue
            data = parser(source.read_text(encoding="utf-8"))
            data.pop("warnings", None)
            yaml_content = migrate._build_yaml(data, source.name)
            backup.parent.mkdir(parents=True, exist_ok=True)
            if force or not backup.exists():
                shutil.copy2(source, backup)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(yaml_content, encoding="utf-8")
            source.unlink()
        except Exception as exc:  # noqa: BLE001 - apply failures are reported per item.
            item["status"] = "failed"
            item["message"] = f"migration failed: {exc}"
            continue
        item["status"] = "applied"
        item["message"] = "migrated and archived source"
    phase.update(_phase("artifacts", phase["items"], message=phase.get("message", "")))


def _copy_item(runtime: str, source: Path, target: Path, *, force: bool, action: str) -> dict[str, Any]:
    if not source.is_file():
        return {
            "status": "blocked",
            "runtime": runtime,
            "action": action,
            "source": str(source),
            "target": str(target),
            "message": "source file is missing",
        }
    src_hash = _sha256(source)
    dst_hash = _sha256(target)
    ownership = _runtime_surface_ownership(runtime, action, target)
    if src_hash == dst_hash and dst_hash is not None:
        status = "noop"
        message = "target already matches source"
    elif target.exists() and not force:
        status = "pending" if ownership["status"] == "agentera-owned" else "blocked"
        message = (
            "will refresh stale Agentera-managed runtime surface"
            if status == "pending"
            else "target exists without Agentera ownership proof; treating it as user-owned"
        )
    else:
        status = "pending"
        message = "will copy current Agentera file"
    return {
        "status": status,
        "runtime": runtime,
        "action": action,
        "source": str(source),
        "target": str(target),
        "ownership": ownership,
        "message": message,
    }


def _opencode_command_copy_item(source: Path, commands_dir: Path, *, force: bool) -> dict[str, Any]:
    return _copy_item(
        "opencode",
        source,
        commands_dir / source.name,
        force=force,
        action="copy-command",
    )


def _opencode_skill_item(
    name: str,
    source: Path,
    target: Path,
    *,
    force: bool,
    source_available: bool | None = None,
) -> dict[str, Any]:
    ownership = _runtime_surface_ownership("opencode", "link-skill", target)
    if source_available is None:
        source_available = (source / "SKILL.md").is_file()
    if not source_available:
        status = "blocked"
        message = "source skill is missing"
    elif (target / "SKILL.md").is_file():
        if ownership["status"] == "agentera-owned" and target.resolve() != source.resolve():
            status = "pending"
            message = "will refresh stale Agentera-managed OpenCode skill link"
        else:
            status = "noop"
            message = "target skill already resolves to SKILL.md"
    elif target.exists() or target.is_symlink():
        status = "pending" if force or ownership["status"] == "agentera-owned" else "blocked"
        message = (
            "will refresh stale Agentera-managed OpenCode skill link"
            if status == "pending"
            else "target exists without Agentera ownership proof; treating it as user-owned"
        )
    else:
        status = "pending"
        message = "will create OpenCode skill link"
    return {
        "status": status,
        "runtime": "opencode",
        "action": "link-skill",
        "skill": name,
        "source": str(source),
        "target": str(target),
        "ownership": ownership,
        "message": message,
    }


def _text_has_agentera_managed_marker(text: str) -> bool:
    lines = text.split("\n")
    if not lines or lines[0] != "---":
        return False
    try:
        closing = lines.index("---", 1)
    except ValueError:
        return False
    return any(line.strip() == "agentera_managed: true" for line in lines[1:closing])


def _runtime_surface_ownership(runtime: str, action: str, target: Path) -> dict[str, str]:
    if not target.exists():
        if target.is_symlink():
            if runtime == "opencode" and action == "link-skill" and _is_managed_opencode_skill_link(target):
                return {"status": "agentera-owned", "reason": "OpenCode skill symlink target contains Agentera identity"}
            return {"status": "user-owned", "reason": "broken target has no Agentera ownership proof"}
        return {
            "status": "agentera-owned",
            "reason": "target is absent and path is a known Agentera-generated runtime surface",
        }
    if runtime == "opencode" and action == "link-skill":
        if _is_managed_opencode_skill_link(target):
            return {"status": "agentera-owned", "reason": "OpenCode skill symlink target contains Agentera identity"}
        return {"status": "user-owned", "reason": "OpenCode skill path is not an Agentera-managed symlink"}
    if not target.is_file():
        return {"status": "user-owned", "reason": "target exists but is not a regular Agentera-managed file"}
    try:
        text = target.read_text(encoding="utf-8")
    except OSError as exc:
        return {"status": "user-owned", "reason": f"cannot read target to prove Agentera ownership: {exc}"}

    if runtime == "opencode" and action == "copy-plugin":
        if "Agentera plugin for OpenCode" in text and "AGENTERA_VERSION" in text:
            return {"status": "agentera-owned", "reason": "OpenCode plugin contains the Agentera plugin identity"}
    if runtime == "codex" and action == "copy-hooks":
        if "agentera v2 Codex hooks" in text or "${AGENTERA_HOME}/hooks/validate_artifact.py" in text:
            return {"status": "agentera-owned", "reason": "Codex hooks contain Agentera hook identity"}
    if _text_has_agentera_managed_marker(text):
        return {"status": "agentera-owned", "reason": "file frontmatter contains agentera_managed: true"}
    return {"status": "user-owned", "reason": "no Agentera ownership marker or runtime identity was found"}


def _is_managed_opencode_skill_link(target: Path) -> bool:
    try:
        link_target = os.readlink(target)
    except OSError:
        return False
    normalized = link_target.lower()
    return "agentera" in normalized or Path(link_target).name == target.name


def _opencode_config_dir(home: Path, env: dict[str, str]) -> Path:
    value = env.get("OPENCODE_CONFIG_DIR")
    return Path(value).expanduser().resolve() if value else home / ".config" / "opencode"


def _opencode_runtime_skill_source_root(install_root: Path) -> Path:
    return _active_bundle_root(install_root) if _valid_install_root(install_root) else _managed_app_root(install_root)


def _home_target(home: Path, target: str) -> Path:
    if target.startswith("~/"):
        return home / target[2:]
    return Path(target).expanduser()


def _first_target(adapter: dict[str, Any], group: str, field: str) -> str:
    targets = adapter[group][field]
    if not targets:
        raise ValueError(f"runtime {adapter['identity']['runtime_id']} has no {field} registry target")
    return targets[0]


def _write_label(adapter: dict[str, Any], fallback: str) -> str:
    labels = adapter["config_targets"]["write_safety_labels"]
    return labels[0] if labels else fallback


def _plan_codex_config(
    adapter: dict[str, Any],
    install_root: Path,
    home: Path,
    *,
    force: bool,
    hooks_path: Path,
) -> dict[str, Any]:
    setup_codex = _setup_codex_module()
    runtime_id = adapter["identity"]["runtime_id"]
    target = _home_target(home, _first_target(adapter, "config_targets", "runtime_config_files"))
    try:
        current = _read_text_or_none(target)
        if current is not None and current.strip():
            setup_codex.tomllib.loads(current)
        outcome = setup_codex.plan_change(
            current,
            install_root,
            force=force,
            hooks_path=hooks_path,
        )
    except Exception as exc:  # noqa: BLE001
        return {
            "status": "blocked",
            "runtime": runtime_id,
            "action": _write_label(adapter, "configure"),
            "target": str(target),
            "message": f"cannot safely plan Codex config change: {exc}",
        }
    status = "noop" if outcome.action == "noop" else "blocked" if outcome.action == "conflict" else "pending"
    ownership = (
        {"status": "agentera-owned", "reason": "Codex config is absent and can receive Agentera shell_environment_policy"}
        if current is None
        else {"status": "agentera-owned", "reason": "Codex config has Agentera-owned shell_environment_policy.AGENTERA_HOME"}
        if "AGENTERA_HOME" in current
        else {"status": "agentera-owned", "reason": "Codex config can be extended without overwriting existing user keys"}
        if status == "pending"
        else {"status": "user-owned", "reason": "existing Codex config needs explicit force before merging Agentera state"}
        if status == "blocked"
        else {"status": "agentera-owned", "reason": "Codex config already has the requested Agentera state"}
    )
    return {
        "status": status,
        "runtime": runtime_id,
        "action": _write_label(adapter, "configure"),
        "target": str(target),
        "ownership": ownership,
        "message": outcome.message,
        "newText": outcome.new_text,
    }


def _plan_copilot_config(
    adapter: dict[str, Any],
    install_root: Path,
    home: Path,
    env: dict[str, str],
    rc_file: Path | None,
) -> dict[str, Any]:
    runtime_id = adapter["identity"]["runtime_id"]
    action = _write_label(adapter, "configure")
    shell_name = Path(env.get("SHELL", "")).name if env.get("SHELL") else ""
    if rc_file is not None:
        target = rc_file
    elif shell_name == "bash":
        target = home / ".bashrc"
    elif shell_name == "zsh":
        target = home / ".zshrc"
    elif shell_name == "fish":
        target = home / ".config" / "fish" / "config.fish"
    else:
        target = None
    prefix = ""
    if target is not None:
        try:
            current = _read_text_or_none(target)
        except OSError:
            current = None
        if current and "AGENTERA_HOME" in current:
            prefix = "Legacy Agentera shell startup line detected. "
    return {
        "status": "blocked",
        "runtime": runtime_id,
        "action": action,
        "target": str(target) if target is not None else None,
        "ownership": {"status": "user-owned", "reason": "shell startup files are user-owned and off-limits"},
        "message": (
            f"{prefix}Agentera will not edit shell startup files; cleanup is a "
            "user-owned manual boundary. For Copilot app context, pass "
            "AGENTERA_HOME for a single invocation or use runtime-native "
            "environment support when available."
        ),
    }


def plan_runtime_phase(
    install_root: Path,
    runtime_source_root: Path,
    home: Path,
    env: dict[str, str],
    runtimes: set[str],
    *,
    force: bool,
    copilot_rc_file: Path | None,
) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    registry = _runtime_registry()
    adapters = {runtime_id: registry.consumer_view("upgrade", runtime_id) for runtime_id in runtimes}
    if "codex" in runtimes:
        adapter = adapters["codex"]
        labels = adapter["config_targets"]["write_safety_labels"]
        hook_target = _home_target(home, _first_target(adapter, "config_targets", "hook_targets"))
        items.append(_plan_codex_config(
            adapter,
            install_root,
            home,
            force=force,
            hooks_path=hook_target,
        ))
        items.append(_copy_item(
            adapter["identity"]["runtime_id"],
            runtime_source_root / "hooks" / "codex-hooks.json",
            hook_target,
            force=force,
            action=labels[1] if len(labels) > 1 else "copy-hooks",
        ))
    if "copilot" in runtimes:
        items.append(_plan_copilot_config(adapters["copilot"], install_root, home, env, copilot_rc_file))
    if "opencode" in runtimes:
        adapter = adapters["opencode"]
        opencode_config_dir = _opencode_config_dir(home, env)
        plugin_source = _first_target(adapter, "config_targets", "plugin_targets")
        items.append(_copy_item(
            adapter["identity"]["runtime_id"],
            runtime_source_root / plugin_source,
            opencode_config_dir / "plugins" / "agentera.js",
            force=force,
            action=_write_label(adapter, "copy-plugin"),
        ))
        commands_dir = opencode_config_dir / "commands"
        for command_source in sorted((runtime_source_root / ".opencode" / "commands").glob("*.md")):
            items.append(_opencode_command_copy_item(command_source, commands_dir, force=force))
        skills_dir = opencode_config_dir / "skills"
        skill_source_root = _opencode_runtime_skill_source_root(install_root)
        for name in ("agentera", "hej"):
            source_available = (
                (skill_source_root / "skills" / name / "SKILL.md").is_file()
                or (runtime_source_root / "skills" / name / "SKILL.md").is_file()
            )
            items.append(_opencode_skill_item(
                name,
                skill_source_root / "skills" / name,
                skills_dir / name,
                force=force,
                source_available=source_available,
            ))
    if "claude" in runtimes:
        adapter = adapters["claude"]
        items.append({
            "status": "noop",
            "runtime": adapter["identity"]["runtime_id"],
            "action": "configure",
            "target": None,
            "message": _write_label(adapter, "Claude Code plugin installs expose the app home without local config writes"),
        })
    return _phase("runtime", items)


def _replan_codex_config_item(item: dict[str, Any], install_root: Path, *, force: bool) -> dict[str, Any]:
    setup_codex = _setup_codex_module()
    target = Path(item["target"])
    hooks_path = None
    for candidate in item.get("phaseItems", []):
        if candidate.get("runtime") == "codex" and candidate.get("action") == "copy-hooks":
            hooks_path = Path(candidate["target"])
            break
    try:
        current = _read_text_or_none(target)
        if current is not None and current.strip():
            setup_codex.tomllib.loads(current)
        outcome = setup_codex.plan_change(current, install_root, force=force, hooks_path=hooks_path)
    except Exception as exc:  # noqa: BLE001
        return {**item, "status": "blocked", "message": f"runtime safety recheck blocked Codex config change: {exc}"}
    if outcome.action == "conflict":
        return {**item, "status": "blocked", "message": f"runtime safety recheck blocked Codex config change: {outcome.message}"}
    if outcome.action == "noop":
        return {**item, "status": "noop", "message": "target already matches source"}
    return {**item, "status": "pending", "message": outcome.message, "newText": outcome.new_text}


def _runtime_write_still_safe(item: dict[str, Any], install_root: Path, *, force: bool) -> dict[str, Any]:
    if item["action"] in ("copy-hooks", "copy-plugin", "copy-command"):
        return _copy_item(
            item["runtime"],
            Path(item["source"]),
            Path(item["target"]),
            force=force,
            action=item["action"],
        )
    if item["runtime"] == "opencode" and item["action"] == "link-skill":
        return _opencode_skill_item(item["skill"], Path(item["source"]), Path(item["target"]), force=force)
    if item["runtime"] == "codex" and item["action"] == "configure":
        return _replan_codex_config_item(item, install_root, force=force)
    return item


def apply_runtime_phase(phase: dict[str, Any], install_root: Path, *, force: bool) -> None:
    for item in phase["items"]:
        if item["status"] != "pending":
            continue
        rechecked = _runtime_write_still_safe({**item, "phaseItems": phase["items"]}, install_root, force=force)
        rechecked.pop("phaseItems", None)
        if rechecked["status"] != "pending":
            item.update(rechecked)
            continue
        item.update(rechecked)
        try:
            target = Path(item["target"])
            target.parent.mkdir(parents=True, exist_ok=True)
            if item["action"] in ("copy-hooks", "copy-plugin", "copy-command"):
                shutil.copy2(Path(item["source"]), target)
            elif item["action"] == "link-skill":
                if target.is_symlink() or target.is_file():
                    target.unlink()
                elif target.exists():
                    shutil.rmtree(target)
                target.symlink_to(Path(item["source"]), target_is_directory=True)
            else:
                target.write_text(item["newText"], encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            item["status"] = "failed"
            item["message"] = f"runtime write failed: {exc}"
            continue
        item["status"] = "applied"
        item["message"] = "runtime update applied"
    phase.update(_phase("runtime", phase["items"]))


def block_runtime_phase(phase: dict[str, Any], message: str) -> None:
    for item in phase["items"]:
        if item["status"] == "pending":
            item["status"] = "blocked"
            item["message"] = message
    phase.update(_phase("runtime", phase["items"]))


def plan_cleanup_phase(home: Path, env: dict[str, str]) -> dict[str, Any]:
    detect = _detect_module()
    findings = detect.run_detection(home=home, env=env)
    items = []
    for finding in findings:
        ownership = _cleanup_finding_ownership(finding)
        status = "pending" if ownership["status"] == "agentera-owned" and finding.kind != "stale_agent" else "blocked"
        message = (
            "will remove stale Agentera-owned runtime artifact"
            if status == "pending"
            else "stale runtime surface has no safe removal plan because it is user-owned"
        )
        items.append({
            "status": status,
            "surface": finding.surface,
            "kind": finding.kind,
            "path": finding.path,
            "detail": finding.detail,
            "ownership": ownership,
            "message": message,
        })
    return _phase("cleanup", items, message="no stale v1 runtime artifacts found" if not items else "")


def _cleanup_finding_ownership(finding: Any) -> dict[str, str]:
    path = Path(finding.path)
    if finding.kind == "dead_symlink":
        return {"status": "agentera-owned", "reason": "path is a known v1 Agentera skill symlink name"}
    if finding.kind == "stale_command":
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            return {"status": "user-owned", "reason": f"cannot read command file to prove Agentera ownership: {exc}"}
        if _text_has_agentera_managed_marker(text):
            return {"status": "agentera-owned", "reason": "OpenCode command frontmatter contains agentera_managed: true"}
        return {"status": "user-owned", "reason": "OpenCode command lacks agentera_managed: true frontmatter"}
    if finding.kind == "stale_agent":
        return {"status": "user-owned", "reason": "Codex config may contain unrelated user agents and is not removed by cleanup"}
    return {"status": "user-owned", "reason": "no Agentera ownership proof is defined for this stale surface"}


def _cleanup_item(finding: Any, status: str, message: str) -> dict[str, Any]:
    return {
        "status": status,
        "surface": finding.surface,
        "kind": finding.kind,
        "path": finding.path,
        "detail": finding.detail,
        "ownership": _cleanup_finding_ownership(finding),
        "message": message,
    }


def apply_cleanup_phase(phase: dict[str, Any], home: Path, env: dict[str, str]) -> None:
    detect = _detect_module()
    pending_paths = {item["path"] for item in phase["items"] if item["status"] == "pending"}
    findings = []
    for finding in detect.run_detection(home=home, env=env):
        if finding.path not in pending_paths:
            continue
        ownership = _cleanup_finding_ownership(finding)
        if ownership["status"] == "agentera-owned" and finding.kind != "stale_agent":
            findings.append(finding)
    results = detect.fix_findings(findings)
    items: list[dict[str, Any]] = []
    for finding, result in results:
        status = "applied" if "removed" in result else "failed"
        items.append(_cleanup_item(finding, status, result))

    remaining = detect.run_detection(home=home, env=env)
    removed_paths = {finding.path for finding, _result in results}
    for finding in remaining:
        if finding.path in removed_paths and finding.kind != "stale_agent":
            continue
        ownership = _cleanup_finding_ownership(finding)
        status = "pending" if ownership["status"] == "agentera-owned" and finding.kind != "stale_agent" else "blocked"
        message = (
            "Codex stale agent entries require manual removal or a runtime-specific config rewrite"
            if finding.kind == "stale_agent"
            else "still present after cleanup"
            if status == "pending"
            else "stale runtime surface has no safe removal plan because it is user-owned"
        )
        items.append(_cleanup_item(finding, status, message))

    phase["items"] = items
    phase.update(_phase("cleanup", phase["items"], message=phase.get("message", "")))


def plan_package_phase(runtimes: set[str], *, enabled: bool) -> dict[str, Any]:
    pkg = _package_registry()
    record = pkg.get("agentera")
    commands = record["package_commands"]["commands"]
    safety = record["package_commands"]["safety"]
    items: list[dict[str, Any]] = []
    cleanup_commands = [cmd for cmd in commands if cmd["phase"] == safety["cleanup_phase"]]
    if runtimes.intersection({"claude", "opencode"}):
        for cmd in cleanup_commands:
            items.append({
                "status": "pending" if enabled else "skipped",
                "runtime": cmd["runtime"],
                "action": cmd["action"],
                "command": cmd["argv"],
                "message": (
                    "will remove legacy v1 package-managed skill entries"
                    if enabled
                    else cmd["skipped_without_update_packages_message"]
                ),
            })
    install_commands = [cmd for cmd in commands if cmd["phase"] == safety["runtime_install_phase"]]
    for cmd in install_commands:
        if cmd["runtime"] not in runtimes:
            continue
        items.append({
            "status": "pending" if enabled else "skipped",
            "runtime": cmd["runtime"],
            "action": cmd["action"],
            "command": cmd["argv"],
            "message": (
                "will run external package update"
                if enabled
                else cmd["skipped_without_update_packages_message"]
            ),
        })
    return _phase("packages", items, message="no package-managed runtime selected" if not items else "")


def apply_package_phase(phase: dict[str, Any]) -> None:
    for item in phase["items"]:
        if item["status"] != "pending":
            continue
        try:
            result = subprocess.run(item["command"], capture_output=True, text=True, timeout=120)
        except Exception as exc:  # noqa: BLE001
            item["status"] = "failed"
            item["message"] = f"package update failed to start: {exc}"
            continue
        item["exitCode"] = result.returncode
        item["stdoutTail"] = result.stdout.splitlines()[-5:]
        item["stderrTail"] = result.stderr.splitlines()[-5:]
        if result.returncode == 0:
            item["status"] = "applied"
            item["message"] = "package update completed"
        else:
            item["status"] = "failed"
            item["message"] = "package update failed"
    phase.update(_phase("packages", phase["items"], message=phase.get("message", "")))


def resolve_source_root() -> Path:
    root = Path(os.environ.get(BOOTSTRAP_SOURCE_ROOT_ENV, str(ROOT))).expanduser().resolve()
    missing = _source_root_missing(root)
    if missing:
        raise ValueError(f"bootstrap source root {root} is missing: {', '.join(missing)}")
    return root


def _should_recover_stale_default_env(candidate: Path, source_root: Path, home: Path) -> bool:
    if candidate != _legacy_default_app_home(home):
        return False
    active_root = _active_bundle_root(candidate)
    expected = _load_suite_version(source_root)
    classification = _classify_root(active_root, source="environment", expected_version=expected)
    if classification.kind in {"missing_explicit_or_environment", "unmanaged_directory", "invalid_bundle"}:
        return True
    return classification.kind == "managed_stale"


def _legacy_default_residue_signal(
    *,
    selected_app_home: Path,
    source_name: str,
    source_value: Path,
) -> dict[str, str]:
    return {
        "kind": "legacy_default_residue",
        "source": source_name,
        "deprecatedDefaultAppHome": str(source_value),
        "selectedAppHome": str(selected_app_home),
        "message": (
            "The deprecated default app home was treated as legacy residue, "
            "so Agentera selected the normal platform app directory instead."
        ),
    }


def resolve_install_root(value: Path | None, source_root: Path, home: Path, env: dict[str, str] | None = None) -> Path:
    env = env or os.environ
    if value is not None:
        return value.expanduser().resolve()
    configured = env.get("AGENTERA_HOME")
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if _should_recover_stale_default_env(candidate, source_root, home):
            return _platform_default_app_home(home, env)
        return candidate
    default = env.get(DEFAULT_INSTALL_ROOT_ENV)
    if default:
        candidate = Path(default).expanduser().resolve()
        if _should_recover_stale_default_env(candidate, source_root, home):
            return _platform_default_app_home(home, env)
        return candidate
    return _platform_default_app_home(home, env)


def _app_home_resolution_signal(
    value: Path | None,
    source_root: Path,
    home: Path,
    env: dict[str, str],
    selected_app_home: Path,
) -> dict[str, str] | None:
    if value is not None:
        return None
    for source_name in ("AGENTERA_HOME", DEFAULT_INSTALL_ROOT_ENV):
        configured = env.get(source_name)
        if not configured:
            continue
        candidate = Path(configured).expanduser().resolve()
        if candidate == selected_app_home:
            return None
        if _should_recover_stale_default_env(candidate, source_root, home):
            return _legacy_default_residue_signal(
                selected_app_home=selected_app_home,
                source_name=source_name,
                source_value=candidate,
            )
        return None
    return None


def _custom_environment_app_home_requires_decision(value: Path | None, home: Path, env: dict[str, str], selected_app_home: Path) -> bool:
    if value is not None:
        return False
    configured = env.get("AGENTERA_HOME")
    if not configured:
        return False
    candidate = Path(configured).expanduser().resolve()
    if candidate != selected_app_home or candidate == _legacy_default_app_home(home):
        return False
    return not candidate.exists() or not _bundle_target_is_safe(candidate)


def _custom_environment_app_home_block(app_home: Path, source_root: Path) -> dict[str, Any]:
    return _phase(
        "bundle",
        [{
            "status": "blocked",
            "action": "install-bundle",
            "source": str(source_root),
            "target": str(_managed_app_root(app_home)),
            "appHome": str(app_home),
            "message": (
                "Agentera was told to use a directory it cannot safely use. "
                "Choose another Agentera directory, or rerun with an explicit --install-root "
                "after checking the directory is safe."
            ),
        }],
    )


def build_upgrade_plan(args: argparse.Namespace) -> dict[str, Any]:
    project = args.project.expanduser().resolve()
    home = args.home.expanduser().resolve()
    env = dict(os.environ)
    if args.opencode_config_dir is not None:
        env["OPENCODE_CONFIG_DIR"] = str(args.opencode_config_dir.expanduser().resolve())
    source_root = resolve_source_root()
    install_root = resolve_install_root(args.install_root, source_root, home, env=env)
    app_home_resolution = _app_home_resolution_signal(args.install_root, source_root, home, env, install_root)
    runtimes = set(args.runtime or _runtime_ids())
    only = set(args.only or PHASES)

    phases: list[dict[str, Any]] = []
    bundle_selected = "bundle" in only
    if bundle_selected:
        if not args.force and _custom_environment_app_home_requires_decision(args.install_root, home, env, install_root):
            phases.append(_custom_environment_app_home_block(install_root, source_root))
        else:
            phases.append(plan_bundle_phase(source_root, install_root, home, force=args.force))
    if "artifacts" in only:
        phases.append(plan_artifact_phase(project, force=args.force))
    if "runtime" in only:
        if not _valid_install_root(install_root) and not bundle_selected:
            phases.append(_phase(
                "runtime",
                [{
                    "status": "blocked",
                    "runtime": "all",
                    "action": "configure",
                    "target": str(install_root),
                    "message": (
                        "Agentera app files are missing or incomplete. Run the normal upgrade flow first, "
                        "or choose a different Agentera directory."
                    ),
                }],
            ))
        else:
            runtime_source_root = source_root if bundle_selected else _active_bundle_root(install_root)
            phases.append(plan_runtime_phase(
                install_root,
                runtime_source_root,
                home,
                env,
                runtimes,
                force=args.force,
                copilot_rc_file=args.copilot_rc_file,
            ))
    if "cleanup" in only:
        phases.append(plan_cleanup_phase(home, env))
    if "packages" in only:
        phases.append(plan_package_phase(runtimes, enabled=args.update_packages))

    summary = {status: 0 for status in STATUSES}
    for phase in phases:
        for status, count in phase["summary"].items():
            summary[status] += count
    mode = "apply" if args.yes else "plan"
    status = "blocked" if summary["blocked"] else "failed" if summary["failed"] else "pending" if summary["pending"] else "noop"
    return {
        "schemaVersion": "agentera.upgrade.v1",
        "mode": mode,
        "status": status,
        "project": str(project),
        "sourceRoot": str(source_root),
        "appHome": str(install_root),
        "managedAppRoot": str(install_root / "app"),
        "userDataRoot": str(install_root),
        "installRoot": str(install_root),
        "appHomeResolution": app_home_resolution,
        "home": str(home),
        "runtimes": sorted(runtimes),
        "force": args.force,
        "updatePackages": args.update_packages,
        "summary": summary,
        "phases": phases,
        "postflight": None,
    }


def apply_upgrade_plan(plan: dict[str, Any], args: argparse.Namespace) -> None:
    project = Path(plan["project"])
    home = Path(plan["home"])
    source_root = Path(plan["sourceRoot"])
    install_root = Path(plan["installRoot"])
    env = dict(os.environ)
    if args.opencode_config_dir is not None:
        env["OPENCODE_CONFIG_DIR"] = str(args.opencode_config_dir.expanduser().resolve())

    for phase in plan["phases"]:
        if phase["name"] == "bundle":
            apply_bundle_phase(phase, source_root, install_root, force=args.force)
        elif phase["name"] == "artifacts":
            apply_artifact_phase(phase, project, force=args.force)
        elif phase["name"] == "runtime":
            if not _valid_install_root(install_root):
                block_runtime_phase(phase, "Agentera app files are not available after the app repair step")
            else:
                apply_runtime_phase(phase, install_root, force=args.force)
        elif phase["name"] == "cleanup":
            apply_cleanup_phase(phase, home, env)
        elif phase["name"] == "packages":
            apply_package_phase(phase)

    summary = {status: 0 for status in STATUSES}
    for phase in plan["phases"]:
        for status, count in phase["summary"].items():
            summary[status] += count
    plan["summary"] = summary
    plan["status"] = "blocked" if summary["blocked"] else "failed" if summary["failed"] else "applied" if summary["applied"] else "noop"

    if any(phase["name"] == "runtime" for phase in plan["phases"]):
        doctor = _setup_doctor_module()
        selected_runtimes = tuple(plan["runtimes"])
        plan["postflight"] = doctor.build_report(
            install_root=install_root,
            home=home,
            env=env,
            runtimes=selected_runtimes,
            run_smoke=False,
            live_model_allowed=False,
        )


def _public_plan(plan: dict[str, Any]) -> dict[str, Any]:
    public = json.loads(json.dumps(plan, default=str))
    public.pop("installRoot", None)
    for phase in public["phases"]:
        for item in phase["items"]:
            item.pop("newText", None)
    return public


def public_doctor_status(status: dict[str, Any]) -> dict[str, Any]:
    public = json.loads(json.dumps(status, default=str))
    public.pop("installRoot", None)
    public.pop("installRootSource", None)
    return public


PLAIN_STATUS = {
    "pending": "ready to fix",
    "applied": "fixed",
    "noop": "already OK",
    "blocked": "needs a decision",
    "failed": "failed",
    "skipped": "skipped",
    "fresh": "ready",
    "stale": "needs repair",
    "migration_required": "needs repair",
}

PHASE_LABELS = {
    "bundle": "Agentera app files",
    "artifacts": "Project notes",
    "runtime": "Runtime setup",
    "cleanup": "Old Agentera files",
    "packages": "Skill package refresh",
}

ACTION_LABELS = {
    "install-bundle": "install or refresh Agentera app files",
    "migrate-app-home": "move Agentera app files into app/",
    "retire-legacy-default-app-home": "move old Agentera data and clean up old app files",
    "migrate": "convert old project notes",
    "copy": "copy current Agentera file",
    "configure": "connect Agentera to a runtime",
    "cleanup": "remove old Agentera runtime files",
    "validate": "check the project directory",
}


def _plain_status(value: str) -> str:
    return PLAIN_STATUS.get(value, value.replace("_", " ").replace("-", " "))


def _plain_action(item: dict[str, Any]) -> str:
    action = str(item.get("action") or item.get("kind") or "check")
    return ACTION_LABELS.get(action, action.replace("-", " ").replace("_", " "))


def _plain_location(item: dict[str, Any]) -> str | None:
    for key in ("target", "path", "runtime", "source"):
        value = item.get(key)
        if value:
            return str(value)
    return None


def render_upgrade(plan: dict[str, Any]) -> str:
    lines = [
        "Agentera repair",
        f"status: {_plain_status(plan['status'])}",
        (
            "mode: preview only; no files were changed"
            if plan["mode"] == "plan"
            else "mode: applying approved changes"
        ),
        f"project: {plan['project']}",
        f"Agentera directory: {plan['appHome']}",
        f"App files directory: {plan['managedAppRoot']}",
        f"Your Agentera data directory: {plan['userDataRoot']}",
    ]
    if plan.get("appHomeResolution"):
        lines.append(plan["appHomeResolution"]["message"])
    for phase in plan["phases"]:
        lines.append("")
        lines.append(f"{PHASE_LABELS.get(phase['name'], phase['name'])}:")
        if phase.get("message") and not phase["items"]:
            lines.append(f"  {_plain_status(phase['status'])}: {phase['message']}")
        for item in phase["items"]:
            lines.append(f"  - {_plain_status(item['status'])}: {_plain_action(item)}")
            if item.get("message"):
                lines.append(f"    {item['message']}")
            location = _plain_location(item)
            if location:
                lines.append(f"    directory: {location}")
    if plan["mode"] == "plan" and plan["summary"]["pending"]:
        lines.append("")
        lines.append(
            "Next: if this preview looks right, rerun the same command "
            "with `--yes` to make the changes."
        )
    if plan["summary"]["blocked"]:
        lines.append("")
        lines.append(
            "Next: choose a safer Agentera directory, or use `--force` "
            "only after checking the directory is safe to replace."
        )
    if plan.get("postflight") is not None:
        after = plan["postflight"]
        lines.append("")
        lines.append(f"After-check: {'passed' if after.get('ok') else 'failed'} {after.get('summary')}")
    return "\n".join(lines)


def cmd_upgrade(args: argparse.Namespace) -> int:
    if args.yes and args.dry_run:
        print("upgrade error: --yes and --dry-run are mutually exclusive", file=sys.stderr)
        return 2
    try:
        plan = build_upgrade_plan(args)
    except ValueError as exc:
        print(f"upgrade error: {exc}", file=sys.stderr)
        return 2
    if args.yes:
        apply_upgrade_plan(plan, args)

    if args.json:
        print(json.dumps(_public_plan(plan), indent=2, sort_keys=True))
    else:
        print(render_upgrade(plan))

    if plan["summary"]["blocked"] or plan["summary"]["failed"]:
        return 1
    if plan["mode"] == "plan" and plan["summary"]["pending"]:
        return 1
    return 0


def render_doctor_status(status: dict[str, Any]) -> str:
    lines = [
        "Agentera doctor",
        f"status: {_plain_status(status['status'])}",
        f"expected version: {status['expectedVersion']}",
        f"Agentera directory: {status['appHome']}",
        f"App files directory: {status['managedAppRoot']}",
        f"Your Agentera data directory: {status['userDataRoot']}",
    ]
    if status["signals"]:
        lines.append("")
        lines.append("What needs attention:")
        for signal in status["signals"]:
            lines.append(f"  - {_plain_status(signal['status'])}: {signal['message']}")
            if signal.get("missingCommands"):
                lines.append(f"    Missing command: {', '.join(signal['missingCommands'])}")
    if status["dryRunCommand"]:
        lines.append("")
        lines.append("Next:")
        lines.append(f"  1. Preview the repair: {status['dryRunCommand']}")
        lines.append(f"  2. If the preview looks right, apply it: {status['applyCommand']}")
        lines.append(f"  3. Then retry Agentera: {status['retryCommand']}")
    else:
        lines.append("")
        lines.append(
            "Next: choose a safer Agentera directory, or use `--force` "
            "only after checking the directory is safe to replace."
        )
    return "\n".join(lines)


def cmd_doctor(args: argparse.Namespace) -> int:
    try:
        source_root = resolve_source_root()
    except ValueError as exc:
        print(f"doctor error: {exc}", file=sys.stderr)
        return 2
    home = args.home.expanduser().resolve()
    install_root, root_source = resolve_doctor_install_root(
        args.install_root,
        home=home,
    )
    status = build_doctor_status(
        install_root,
        root_source=root_source,
        source_root=source_root,
        home=home,
        project=args.project.expanduser().resolve(),
        expected_version=args.expected_version,
        expected_commands=tuple(args.expect_command or EXPECTED_STATE_COMMANDS),
    )
    if args.json:
        print(json.dumps(public_doctor_status(status), indent=2, sort_keys=True))
    else:
        print(render_doctor_status(status))
    return 0 if status["status"] == "fresh" else 1
