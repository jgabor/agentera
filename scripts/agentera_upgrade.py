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
import shutil
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
RUNTIMES = ("claude", "opencode", "copilot", "codex")
PHASES = ("artifacts", "runtime", "cleanup", "packages")
STATUSES = ("pending", "applied", "noop", "blocked", "failed", "skipped")
PACKAGE_COMMANDS = {
    "claude": ["npx", "skills", "update", "-g", "-a", "claude-code", "--skill", "*", "-y"],
    "opencode": ["npx", "skills", "update", "-g", "-a", "opencode", "-y"],
}


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


def _plan_codex_config(install_root: Path, home: Path, *, force: bool) -> dict[str, Any]:
    setup_codex = _setup_codex_module()
    target = home / ".codex" / "config.toml"
    try:
        current = _read_text_or_none(target)
        if current is not None and current.strip():
            setup_codex.tomllib.loads(current)
        outcome = setup_codex.plan_change(current, install_root, force=force)
    except Exception as exc:  # noqa: BLE001
        return {
            "status": "blocked",
            "runtime": "codex",
            "action": "configure",
            "target": str(target),
            "message": f"cannot safely plan Codex config change: {exc}",
        }
    status = "noop" if outcome.action == "noop" else "blocked" if outcome.action == "conflict" else "pending"
    return {
        "status": status,
        "runtime": "codex",
        "action": "configure",
        "target": str(target),
        "message": outcome.message,
        "newText": outcome.new_text,
    }


def _plan_copilot_config(install_root: Path, home: Path, env: dict[str, str], rc_file: Path | None) -> dict[str, Any]:
    setup_copilot = _setup_copilot_module()
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
                "runtime": "copilot",
                "action": "configure",
                "target": None,
                "message": f"unsupported shell for Copilot rc automation: {shell_name or '(unset $SHELL)'}",
            }
    try:
        outcome = setup_copilot.plan_change(_read_text_or_none(target), install_root, syntax)
    except Exception as exc:  # noqa: BLE001
        return {
            "status": "blocked",
            "runtime": "copilot",
            "action": "configure",
            "target": str(target),
            "message": f"cannot safely plan Copilot rc change: {exc}",
        }
    return {
        "status": "noop" if outcome.action == "noop" else "pending",
        "runtime": "copilot",
        "action": "configure",
        "target": str(target),
        "message": outcome.message,
        "newText": outcome.new_text,
    }


def plan_runtime_phase(
    install_root: Path,
    home: Path,
    env: dict[str, str],
    runtimes: set[str],
    *,
    force: bool,
    copilot_rc_file: Path | None,
) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    if "codex" in runtimes:
        items.append(_plan_codex_config(install_root, home, force=force))
        items.append(_copy_item(
            "codex",
            install_root / "hooks" / "codex-hooks.json",
            home / ".codex" / "hooks.json",
            force=force,
            action="copy-hooks",
        ))
    if "copilot" in runtimes:
        items.append(_plan_copilot_config(install_root, home, env, copilot_rc_file))
    if "opencode" in runtimes:
        items.append(_copy_item(
            "opencode",
            install_root / ".opencode" / "plugins" / "agentera.js",
            _opencode_config_dir(home, env) / "plugins" / "agentera.js",
            force=force,
            action="copy-plugin",
        ))
    if "claude" in runtimes:
        items.append({
            "status": "noop",
            "runtime": "claude",
            "action": "configure",
            "target": None,
            "message": "Claude Code plugin installs expose the bundle root without local config writes",
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
    items: list[dict[str, Any]] = []
    for runtime in ("claude", "opencode"):
        if runtime not in runtimes:
            continue
        command = PACKAGE_COMMANDS[runtime]
        items.append({
            "status": "pending" if enabled else "skipped",
            "runtime": runtime,
            "action": "run-command",
            "command": command,
            "message": (
                "will run external package update"
                if enabled
                else "external package update skipped; pass --update-packages to run"
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


def resolve_install_root(value: Path | None) -> Path:
    root = (value or ROOT).expanduser().resolve()
    missing = [entry for entry in ("scripts/agentera", "hooks", "skills", "skills/agentera/SKILL.md") if not (root / entry).exists()]
    if missing:
        raise ValueError(f"install root {root} is missing: {', '.join(missing)}")
    return root


def build_upgrade_plan(args: argparse.Namespace) -> dict[str, Any]:
    project = args.project.expanduser().resolve()
    home = args.home.expanduser().resolve()
    install_root = resolve_install_root(args.install_root)
    runtimes = set(args.runtime or RUNTIMES)
    only = set(args.only or PHASES)
    env = dict(os.environ)
    if args.opencode_config_dir is not None:
        env["OPENCODE_CONFIG_DIR"] = str(args.opencode_config_dir.expanduser().resolve())

    phases: list[dict[str, Any]] = []
    if "artifacts" in only:
        phases.append(plan_artifact_phase(project, force=args.force))
    if "runtime" in only:
        phases.append(plan_runtime_phase(
            install_root,
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
    install_root = Path(plan["installRoot"])
    env = dict(os.environ)
    if args.opencode_config_dir is not None:
        env["OPENCODE_CONFIG_DIR"] = str(args.opencode_config_dir.expanduser().resolve())

    for phase in plan["phases"]:
        if phase["name"] == "artifacts":
            apply_artifact_phase(phase, project, force=args.force)
        elif phase["name"] == "runtime":
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
