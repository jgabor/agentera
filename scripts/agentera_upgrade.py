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


def _valid_install_root(root: Path) -> bool:
    classification = _classify_root(root)
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


def _bundle_target_is_safe(install_root: Path, *, expected_version: str | None = None) -> bool:
    if not install_root.exists():
        return True
    classification = _classify_root(install_root, expected_version=expected_version)
    return classification.managed_status == "managed"


def _shell_quote(value: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_@%+=:,./-]+", value):
        return value
    return "'" + value.replace("'", "'\"'\"'") + "'"


def _command_text(parts: list[str]) -> str:
    return " ".join(_shell_quote(part) for part in parts)


def resolve_bundle_status_install_root(
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
    install_root: Path,
    *,
    project: Path,
    expected_commands: tuple[str, ...],
) -> dict[str, Any]:
    cli = install_root / "scripts" / "agentera"
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
            env={**os.environ, "AGENTERA_HOME": str(install_root)},
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


def build_bundle_status(
    install_root: Path,
    *,
    root_source: str,
    source_root: Path,
    home: Path,
    project: Path,
    expected_version: str | None = None,
    expected_commands: tuple[str, ...] = EXPECTED_STATE_COMMANDS,
) -> dict[str, Any]:
    expected = expected_version or _load_suite_version(source_root) or "unknown"
    classification = _classify_root(install_root, source=_source_key(root_source), expected_version=expected)
    marker_version = classification.current_version
    signals: list[dict[str, Any]] = []
    blocked = False

    if classification.kind == "missing_default":
        root_status = "missing"
        signals.append({
            "status": "stale",
            "kind": "missing_bundle",
            "message": "default durable Agentera bundle is not installed",
        })
    elif classification.kind == "missing_explicit_or_environment":
        root_status = "missing"
        blocked = True
        signals.append({
            "status": "blocked",
            "kind": "invalid_install_root",
            "message": (
                f"{root_source} points at a missing path; fix the setting, "
                "choose a managed --install-root, or rerun with explicit force guidance"
            ),
        })
    elif classification.kind == "file_valued_root":
        root_status = "invalid"
        blocked = True
        signals.append({
            "status": "blocked",
            "kind": "invalid_install_root",
            "message": f"{root_source} points at a file, not an install root directory",
        })
    elif classification.kind == "unmanaged_directory":
        root_status = "unmanaged"
        blocked = True
        signals.append({
            "status": "blocked",
            "kind": "unmanaged_install_root",
            "message": "target exists but is not an Agentera-managed bundle",
        })
    elif classification.kind == "invalid_bundle":
        root_status = "invalid"
        blocked = True
        signals.append({
            "status": "blocked",
            "kind": "invalid_bundle",
            "message": classification.diagnostic.message,
        })
    else:
        root_status = "managed"
        reason = classification.diagnostic.evidence.get("reason")
        if classification.kind == "managed_stale" and reason == "missing_marker":
            signals.append({
                "status": "stale",
                "kind": "missing_marker",
                "message": f"{BUNDLE_MARKER} is missing or unreadable",
            })
        elif classification.kind == "managed_stale" and reason == "version_mismatch":
            signals.append({
                "status": "stale",
                "kind": "version_mismatch",
                "expected": expected,
                "actual": marker_version,
                "message": "bundle marker version does not match the expected suite version",
            })
        probe = _probe_bundle_cli(
            install_root,
            project=project,
            expected_commands=expected_commands,
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
    status = "blocked" if blocked else "stale" if signals else "fresh"
    return {
        "schemaVersion": "agentera.bundleStatus.v1",
        "status": status,
        "expectedVersion": expected,
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
            str(install_root / "scripts" / "agentera"),
            "hej",
        ]),
        "approval": f"approve bundle refresh for {install_root}",
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


def _copy_bundle_file(source_root: Path, install_root: Path, rel_path: Path) -> None:
    source = source_root / rel_path
    target = install_root / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def plan_bundle_phase(source_root: Path, install_root: Path, *, force: bool) -> dict[str, Any]:
    if source_root == install_root:
        return _phase(
            "bundle",
            [{
                "status": "noop",
                "action": "install-bundle",
                "source": str(source_root),
                "target": str(install_root),
                "message": "running from the selected Agentera install root",
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
                "message": f"bootstrap source is missing: {', '.join(source_missing)}",
            }],
        )

    if not _bundle_target_is_safe(install_root, expected_version=_load_suite_version(source_root)) and not force:
        return _phase(
            "bundle",
            [{
                "status": "blocked",
                "action": "install-bundle",
                "source": str(source_root),
                "target": str(install_root),
                "message": "target exists but is not an Agentera-managed bundle; use --force or --install-root",
            }],
        )

    changed: list[str] = []
    for rel_path in _bundle_rel_paths(source_root):
        source = source_root / rel_path
        target = install_root / rel_path
        if _sha256(source) != _sha256(target):
            changed.append(str(rel_path))

    marker_missing = not _bundle_marker_path(install_root).is_file()
    if not changed and not marker_missing:
        status = "noop"
        message = "durable Agentera bundle already matches source"
    else:
        status = "pending"
        message = "will install or refresh the durable Agentera bundle"

    return _phase(
        "bundle",
        [{
            "status": status,
            "action": "install-bundle",
            "source": str(source_root),
            "target": str(install_root),
            "fileCount": len(_bundle_rel_paths(source_root)),
            "changedCount": len(changed),
            "changedPreview": changed[:20],
            "marker": str(_bundle_marker_path(install_root)),
            "message": message,
        }],
    )


def apply_bundle_phase(phase: dict[str, Any], source_root: Path, install_root: Path, *, force: bool) -> None:
    for item in phase["items"]:
        if item["status"] != "pending":
            continue
        try:
            if not _bundle_target_is_safe(install_root, expected_version=_load_suite_version(source_root)) and not force:
                item["status"] = "blocked"
                item["message"] = "target exists but is not an Agentera-managed bundle"
                continue
            rel_paths = _bundle_rel_paths(source_root)
            for rel_path in rel_paths:
                _copy_bundle_file(source_root, install_root, rel_path)
            marker = {
                "schemaVersion": "agentera.bundle.v1",
                "version": _load_suite_version(source_root),
                "source": str(source_root),
                "fileCount": len(rel_paths),
            }
            _bundle_marker_path(install_root).write_text(
                json.dumps(marker, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
        except Exception as exc:  # noqa: BLE001
            item["status"] = "failed"
            item["message"] = f"bundle install failed: {exc}"
            continue
        item["status"] = "applied"
        item["message"] = "durable Agentera bundle installed"
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
    if src_hash == dst_hash and dst_hash is not None:
        status = "noop"
        message = "target already matches source"
    elif target.exists() and not force:
        status = "blocked"
        message = "target exists with different content; use --force to overwrite"
    else:
        status = "pending"
        message = "will copy current Agentera file"
    return {
        "status": status,
        "runtime": runtime,
        "action": action,
        "source": str(source),
        "target": str(target),
        "message": message,
    }


def _opencode_config_dir(home: Path, env: dict[str, str]) -> Path:
    value = env.get("OPENCODE_CONFIG_DIR")
    return Path(value).expanduser().resolve() if value else home / ".config" / "opencode"


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


def _plan_codex_config(adapter: dict[str, Any], install_root: Path, home: Path, *, force: bool) -> dict[str, Any]:
    setup_codex = _setup_codex_module()
    runtime_id = adapter["identity"]["runtime_id"]
    target = _home_target(home, _first_target(adapter, "config_targets", "runtime_config_files"))
    try:
        current = _read_text_or_none(target)
        if current is not None and current.strip():
            setup_codex.tomllib.loads(current)
        outcome = setup_codex.plan_change(current, install_root, force=force)
    except Exception as exc:  # noqa: BLE001
        return {
            "status": "blocked",
            "runtime": runtime_id,
            "action": _write_label(adapter, "configure"),
            "target": str(target),
            "message": f"cannot safely plan Codex config change: {exc}",
        }
    status = "noop" if outcome.action == "noop" else "blocked" if outcome.action == "conflict" else "pending"
    return {
        "status": status,
        "runtime": runtime_id,
        "action": _write_label(adapter, "configure"),
        "target": str(target),
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
    setup_copilot = _setup_copilot_module()
    runtime_id = adapter["identity"]["runtime_id"]
    action = _write_label(adapter, "configure")
    if rc_file is not None:
        shell_target = setup_copilot.resolve_rc_target(rc_file)
        target, syntax = shell_target.rc_path, shell_target.syntax
    else:
        shell_name = Path(env.get("SHELL", "")).name if env.get("SHELL") else ""
        if shell_name == "bash":
            target, syntax = home / ".bashrc", "export"
        elif shell_name == "zsh":
            target, syntax = home / ".zshrc", "export"
        elif shell_name == "fish":
            target, syntax = home / ".config" / "fish" / "config.fish", "fish"
        else:
            return {
                "status": "blocked",
                "runtime": runtime_id,
                "action": action,
                "target": None,
                "message": f"unsupported shell for Copilot rc automation: {shell_name or '(unset $SHELL)'}",
            }
    try:
        outcome = setup_copilot.plan_change(_read_text_or_none(target), install_root, syntax)
    except Exception as exc:  # noqa: BLE001
        return {
            "status": "blocked",
            "runtime": runtime_id,
            "action": action,
            "target": str(target),
            "message": f"cannot safely plan Copilot rc change: {exc}",
        }
    return {
        "status": "noop" if outcome.action == "noop" else "pending",
        "runtime": runtime_id,
        "action": action,
        "target": str(target),
        "message": outcome.message,
        "newText": outcome.new_text,
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
        items.append(_plan_codex_config(adapter, install_root, home, force=force))
        items.append(_copy_item(
            adapter["identity"]["runtime_id"],
            runtime_source_root / "hooks" / "codex-hooks.json",
            _home_target(home, _first_target(adapter, "config_targets", "hook_targets")),
            force=force,
            action=labels[1] if len(labels) > 1 else "copy-hooks",
        ))
    if "copilot" in runtimes:
        items.append(_plan_copilot_config(adapters["copilot"], install_root, home, env, copilot_rc_file))
    if "opencode" in runtimes:
        adapter = adapters["opencode"]
        plugin_source = _first_target(adapter, "config_targets", "plugin_targets")
        items.append(_copy_item(
            adapter["identity"]["runtime_id"],
            runtime_source_root / plugin_source,
            _opencode_config_dir(home, env) / "plugins" / "agentera.js",
            force=force,
            action=_write_label(adapter, "copy-plugin"),
        ))
    if "claude" in runtimes:
        adapter = adapters["claude"]
        items.append({
            "status": "noop",
            "runtime": adapter["identity"]["runtime_id"],
            "action": "configure",
            "target": None,
            "message": _write_label(adapter, "Claude Code plugin installs expose the bundle root without local config writes"),
        })
    return _phase("runtime", items)


def apply_runtime_phase(phase: dict[str, Any]) -> None:
    for item in phase["items"]:
        if item["status"] != "pending":
            continue
        try:
            target = Path(item["target"])
            target.parent.mkdir(parents=True, exist_ok=True)
            if item["action"] in ("copy-hooks", "copy-plugin"):
                shutil.copy2(Path(item["source"]), target)
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
        status = "blocked" if finding.kind == "stale_agent" else "pending"
        message = (
            "Codex stale agent entries require Codex config rewrite with --force"
            if finding.kind == "stale_agent"
            else "will remove stale v1 runtime artifact"
        )
        items.append({
            "status": status,
            "surface": finding.surface,
            "kind": finding.kind,
            "path": finding.path,
            "detail": finding.detail,
            "message": message,
        })
    return _phase("cleanup", items, message="no stale v1 runtime artifacts found" if not items else "")


def _cleanup_item(finding: Any, status: str, message: str) -> dict[str, Any]:
    return {
        "status": status,
        "surface": finding.surface,
        "kind": finding.kind,
        "path": finding.path,
        "detail": finding.detail,
        "message": message,
    }


def apply_cleanup_phase(phase: dict[str, Any], home: Path, env: dict[str, str]) -> None:
    detect = _detect_module()
    findings = [f for f in detect.run_detection(home=home, env=env) if f.kind != "stale_agent"]
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
        status = "blocked" if finding.kind == "stale_agent" else "pending"
        message = (
            "Codex stale agent entries require manual removal or a runtime-specific config rewrite"
            if finding.kind == "stale_agent"
            else "still present after cleanup"
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


def resolve_install_root(value: Path | None, source_root: Path, home: Path) -> Path:
    if value is not None:
        return value.expanduser().resolve()
    default = os.environ.get(DEFAULT_INSTALL_ROOT_ENV)
    if default:
        return Path(default).expanduser().resolve()
    return source_root if source_root == ROOT.resolve() else (home / ".agents" / "agentera").resolve()


def build_upgrade_plan(args: argparse.Namespace) -> dict[str, Any]:
    project = args.project.expanduser().resolve()
    home = args.home.expanduser().resolve()
    source_root = resolve_source_root()
    install_root = resolve_install_root(args.install_root, source_root, home)
    runtimes = set(args.runtime or _runtime_ids())
    only = set(args.only or PHASES)
    env = dict(os.environ)
    if args.opencode_config_dir is not None:
        env["OPENCODE_CONFIG_DIR"] = str(args.opencode_config_dir.expanduser().resolve())

    phases: list[dict[str, Any]] = []
    bundle_selected = "bundle" in only
    if bundle_selected:
        phases.append(plan_bundle_phase(source_root, install_root, force=args.force))
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
                        "install root is missing or incomplete; include --only bundle, "
                        "choose a valid --install-root, or run the default upgrade flow"
                    ),
                }],
            ))
        else:
            runtime_source_root = source_root if bundle_selected else install_root
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
        "installRoot": str(install_root),
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
                block_runtime_phase(phase, "durable Agentera bundle is not available after bundle phase")
            else:
                apply_runtime_phase(phase)
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
    for phase in public["phases"]:
        for item in phase["items"]:
            item.pop("newText", None)
    return public


def render_upgrade(plan: dict[str, Any]) -> str:
    lines = [
        "Agentera upgrade",
        f"mode: {plan['mode']}",
        f"status: {plan['status']}",
        f"project: {plan['project']}",
        f"install root: {plan['installRoot']}",
    ]
    for phase in plan["phases"]:
        lines.append(f"{phase['name']}: {phase['status']} {phase['summary']}")
        if phase.get("message") and not phase["items"]:
            lines.append(f"  {phase['message']}")
        for item in phase["items"]:
            label = item.get("source") or item.get("target") or item.get("path") or item.get("runtime")
            lines.append(f"  - {item['status']}: {item.get('action') or item.get('kind')} {label}")
            if item.get("message"):
                lines.append(f"    {item['message']}")
    if plan["mode"] == "plan" and plan["summary"]["pending"]:
        lines.append("run with --yes to apply pending changes")
    if plan.get("postflight") is not None:
        after = plan["postflight"]
        lines.append(f"postflight doctor: {'pass' if after.get('ok') else 'fail'} {after.get('summary')}")
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


def render_bundle_status(status: dict[str, Any]) -> str:
    lines = [
        "Agentera bundle status",
        f"status: {status['status']}",
        f"expected version: {status['expectedVersion']}",
        f"install root: {status['installRoot']}",
        f"install root source: {status['installRootSource']}",
        f"root status: {status['rootStatus']}",
        f"marker version: {status.get('markerVersion') or '-'}",
    ]
    for signal in status["signals"]:
        lines.append(f"- {signal['status']}: {signal['kind']} - {signal['message']}")
        if signal.get("missingCommands"):
            lines.append(f"  missing commands: {', '.join(signal['missingCommands'])}")
    if status["dryRunCommand"]:
        lines.append(f"dry run: {status['dryRunCommand']}")
        lines.append(f"apply after approval: {status['applyCommand']}")
        lines.append(f"approval phrase: {status['approval']}")
        lines.append(f"retry: {status['retryCommand']}")
    else:
        lines.append(
            "recovery: fix AGENTERA_HOME, choose a managed --install-root, "
            "or rerun upgrade with explicit force guidance"
        )
    return "\n".join(lines)


def cmd_bundle_status(args: argparse.Namespace) -> int:
    try:
        source_root = resolve_source_root()
    except ValueError as exc:
        print(f"bundle-status error: {exc}", file=sys.stderr)
        return 2
    home = args.home.expanduser().resolve()
    install_root, root_source = resolve_bundle_status_install_root(
        args.install_root,
        home=home,
    )
    status = build_bundle_status(
        install_root,
        root_source=root_source,
        source_root=source_root,
        home=home,
        project=args.project.expanduser().resolve(),
        expected_version=args.expected_version,
        expected_commands=tuple(args.expect_command or EXPECTED_STATE_COMMANDS),
    )
    if args.json:
        print(json.dumps(status, indent=2, sort_keys=True))
    else:
        print(render_bundle_status(status))
    return 0 if status["status"] == "fresh" else 1
