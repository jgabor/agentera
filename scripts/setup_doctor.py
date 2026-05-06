#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Setup diagnosis and confirmed installation for an Agentera suite bundle.

The default doctor mode answers one question without mutating anything: can
the current runtime reach the Agentera install root and its shared helper
scripts?

It reports the aggregate bundle root first, then classifies runtime-native
setup shapes for Claude Code, OpenCode, Copilot CLI, and Codex CLI as
``pass``, ``warn``, ``fail``, or ``skip``. The JSON output is intentionally
stable so later installer and smoke-check tasks can consume the same envelope.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
from collections.abc import Mapping
from pathlib import Path
from re import compile as compile_re
from re import Pattern
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
import install_root as install_root_module

SCHEMA_VERSION = "agentera.setupDoctor.v1"
STATUSES = ("pass", "warn", "fail", "skip")
RUNTIMES = ("claude", "opencode", "copilot", "codex")
WRITABLE_RUNTIMES = ("copilot", "codex")
RUNTIME_BINARIES = {
    "claude": "claude",
    "opencode": "opencode",
    "copilot": "copilot",
    "codex": "codex",
}
OPENCODE_SKILL_INSTALL_COMMAND = "npx skills add jgabor/agentera -g -a opencode --skill agentera -y"
OPENCODE_SKILL_NAMES = (
    "agentera",
)
OPENCODE_COMMAND_DESCRIPTIONS = {
    "agentera": "Compound agent orchestration suite: 12 capabilities in one bundled skill",
}
CANONICAL_ENTRIES = install_root_module.SETUP_EVIDENCE
HELPER_ENTRIES = (
    "scripts/validate_capability.py",
    "hooks/validate_artifact.py",
)
SMOKE_TIMEOUT_SECONDS = 30
ENV_FALLBACKS = ("AGENTERA_HOME", "CLAUDE_PLUGIN_ROOT")
COPILOT_MARKER = "# agentera: AGENTERA_HOME (managed)"
INSTALLER_SCHEMA_VERSION = "agentera.setupInstaller.v1"
SUPPORT_PATH_RE: Pattern[str] = compile_re(
    r"(?<![\w/.$-])"
    r"(?P<path>references/[A-Za-z0-9][A-Za-z0-9_./-]*)"
)


def verify_install_root(root: Path) -> list[str]:
    classification = install_root_module.classify_resolved_root(root, source="explicit")
    if classification.kind == "managed_fresh":
        return []
    return [entry for entry in install_root_module.SETUP_EVIDENCE if not (root / entry).exists()]


def verify_helper_access(root: Path) -> list[str]:
    return [entry for entry in HELPER_ENTRIES if not (root / entry).is_file()]


def auto_detect_install_root(
    env: Mapping[str, str],
    *,
    start: Path | None = None,
) -> Path | None:
    for var in ENV_FALLBACKS:
        value = env.get(var)
        if value:
            candidate = Path(value).expanduser().resolve()
            if not verify_install_root(candidate):
                return candidate

    current = (start or Path(__file__).resolve().parent).resolve()
    for candidate in (current, *current.parents):
        if not verify_install_root(candidate):
            return candidate
    return None


def _root_classification(root: Path, source: str) -> install_root_module.Classification:
    return install_root_module.classify_resolved_root(root, source=source)


def _setup_missing(root: Path) -> list[str]:
    return [entry for entry in install_root_module.SETUP_EVIDENCE if not (root / entry).exists()]


def classify_install_root(
    explicit_root: Path | None,
    env: Mapping[str, str],
) -> dict[str, Any]:
    source = "argument" if explicit_root is not None else "auto"
    root = explicit_root.expanduser().resolve() if explicit_root is not None else auto_detect_install_root(env)
    if root is None:
        return {
            "status": "fail",
            "path": None,
            "source": source,
            "kind": None,
            "gap": "user_environment",
            "message": (
                "could not resolve an Agentera install root; pass --install-root "
                "or set AGENTERA_HOME"
            ),
            "missing": list(install_root_module.SETUP_EVIDENCE),
        }

    classification = _root_classification(root, "explicit" if explicit_root is not None else "default")
    if classification.kind != "managed_fresh":
        return {
            "status": "fail",
            "path": str(root),
            "source": source,
            "kind": None,
            "gap": "bundle_packaging",
            "message": "install root is missing canonical Agentera entries",
            "missing": _setup_missing(root),
        }

    helper_missing = verify_helper_access(root)
    status = "pass" if not helper_missing else "fail"
    return {
        "status": status,
        "path": str(root),
        "source": source,
        "kind": "local-clone" if (root / ".git").exists() else "installed-bundle",
        "gap": None if status == "pass" else "bundle_packaging",
        "message": (
            "install root is valid"
            if status == "pass"
            else "install root is valid but shared helper scripts are missing"
        ),
        "missing": helper_missing,
    }


def _check(
    name: str,
    status: str,
    message: str,
    *,
    source: str | None = None,
    path: Path | str | None = None,
    gap: str | None = None,
    details: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "name": name,
        "status": status,
        "message": message,
        "source": source,
        "path": str(path) if path is not None else None,
        "gap": gap,
        "details": details or [],
    }


def _aggregate_status(checks: list[dict[str, Any]]) -> str:
    statuses = [check["status"] for check in checks]
    if statuses and all(status == "skip" for status in statuses):
        return "skip"
    if "fail" in statuses:
        return "fail"
    if "warn" in statuses:
        return "warn"
    if "pass" in statuses:
        return "pass"
    return "skip"


def _summarize_statuses(
    items: Mapping[str, dict[str, Any]] | list[dict[str, Any]],
) -> dict[str, int]:
    counts = {status: 0 for status in STATUSES}
    values = items.values() if isinstance(items, Mapping) else items
    for item in values:
        counts[item["status"]] += 1
    return counts


def _tail(text: str, *, limit: int = 5) -> list[str]:
    lines = [line for line in text.splitlines() if line.strip()]
    return lines[-limit:]


def _runtime_skip(runtime: str, env: Mapping[str, str]) -> dict[str, Any]:
    binary = RUNTIME_BINARIES[runtime]
    return {
        "runtime": runtime,
        "status": "skip",
        "available": False,
        "binary": None,
        "checks": [
            _check(
                "runtime_binary",
                "skip",
                f"{binary} executable not found on PATH",
                source="PATH",
                gap="user_environment",
                details=[env.get("PATH", "")],
            )
        ],
    }


def _configured_root_check(
    name: str,
    candidate: Path,
    install_root: Path,
    source: str,
) -> dict[str, Any]:
    classification = _root_classification(candidate, "environment")
    if classification.kind.startswith("missing_"):
        return _check(
            name,
            "fail",
            "configured Agentera root does not exist",
            source=source,
            path=candidate,
            gap="runtime_config",
        )

    if classification.kind != "managed_fresh":
        return _check(
            name,
            "fail",
            "configured Agentera root is not a valid suite bundle",
            source=source,
            path=candidate,
            gap="bundle_packaging",
            details=_setup_missing(candidate),
        )

    helper_missing = verify_helper_access(candidate)
    if helper_missing:
        return _check(
            name,
            "fail",
            "configured Agentera root cannot reach shared helper scripts",
            source=source,
            path=candidate,
            gap="bundle_packaging",
            details=helper_missing,
        )

    if candidate.resolve() != install_root.resolve():
        return _check(
            name,
            "warn",
            "runtime points at a different valid Agentera install root",
            source=source,
            path=candidate,
            gap="runtime_config",
        )

    return _check(
        name,
        "pass",
        "runtime can reach shared Agentera helper scripts",
        source=source,
        path=candidate,
    )


def _binary_path(runtime: str, env: Mapping[str, str]) -> str | None:
    return shutil.which(RUNTIME_BINARIES[runtime], path=env.get("PATH"))


def _runtime_host_path_problem(
    runtime: str,
    env: Mapping[str, str],
) -> tuple[Path, str] | None:
    binary = RUNTIME_BINARIES[runtime]
    for entry in env.get("PATH", "").split(os.pathsep):
        if not entry:
            continue
        candidate = Path(entry) / binary
        if candidate.is_dir():
            return candidate, f"{binary} PATH candidate is a directory, not an executable"
        if candidate.exists() and not os.access(candidate, os.X_OK):
            return candidate, f"{binary} PATH candidate is not executable"
    return None


def _runtime_result(
    runtime: str,
    env: Mapping[str, str],
    checks: list[dict[str, Any]],
) -> dict[str, Any]:
    binary = _binary_path(runtime, env)
    if binary is None:
        return _runtime_skip(runtime, env)
    binary_check = _check(
        "runtime_binary",
        "pass",
        f"{RUNTIME_BINARIES[runtime]} executable found",
        source="PATH",
        path=binary,
    )
    all_checks = [binary_check, *checks]
    return {
        "runtime": runtime,
        "status": _aggregate_status(all_checks),
        "available": True,
        "binary": binary,
        "checks": all_checks,
    }


def _opencode_config_dir(home: Path, env: Mapping[str, str]) -> Path:
    value = env.get("OPENCODE_CONFIG_DIR")
    return Path(value).expanduser().resolve() if value else home / ".config" / "opencode"


def _opencode_command_template(name: str) -> str:
    return (
        "---\n"
        f"description: \"{OPENCODE_COMMAND_DESCRIPTIONS[name]}\"\n"
        "agentera_managed: true\n"
        "---\n"
        f"Load and execute the {name} skill for this project.\n"
    )


def _has_managed_marker(text: str) -> bool:
    lines = text.split("\n")
    if not lines or lines[0] != "---":
        return False
    try:
        closing = lines.index("---", 1)
    except ValueError:
        return False
    return any(line.strip() == "agentera_managed: true" for line in lines[1:closing])


def _diagnose_opencode_commands(home: Path, env: Mapping[str, str]) -> dict[str, Any]:
    commands_dir = _opencode_config_dir(home, env) / "commands"
    missing: list[str] = []
    stale: list[str] = []
    user_owned: list[str] = []

    for name in OPENCODE_SKILL_NAMES:
        command = commands_dir / f"{name}.md"
        expected = _opencode_command_template(name)
        try:
            actual = command.read_text(encoding="utf-8")
        except FileNotFoundError:
            missing.append(name)
            continue
        if actual == expected:
            continue
        if _has_managed_marker(actual):
            stale.append(name)
        else:
            user_owned.append(name)

    if not missing and not stale:
        details = [f"user-owned command preserved: {name}" for name in user_owned]
        return _check(
            "opencode_managed_commands",
            "pass",
            "OpenCode managed Agentera commands are current",
            path=commands_dir,
            details=details,
        )

    details = [*(f"missing: {name}" for name in missing), *(f"stale: {name}" for name in stale)]
    if user_owned:
        details.extend(f"user-owned command preserved: {name}" for name in user_owned)
    details.append("action: start OpenCode with the Agentera plugin to restore managed commands")
    return _check(
        "opencode_managed_commands",
        "warn",
        "OpenCode managed Agentera commands are missing or stale",
        path=commands_dir,
        gap="command_drift",
        details=details,
    )


def _is_agentera_managed_skill_path(target: Path, name: str) -> bool:
    try:
        link_target = os.readlink(target)
    except OSError:
        return False
    normalized = link_target.lower()
    return "agentera" in normalized or Path(link_target).name == name


def _diagnose_opencode_skill_paths(install_root: Path, home: Path, env: Mapping[str, str]) -> dict[str, Any]:
    skills_dir = _opencode_config_dir(home, env) / "skills"
    missing: list[str] = []
    broken: list[str] = []
    user_owned: list[str] = []
    missing_source: list[str] = []

    for name in OPENCODE_SKILL_NAMES:
        source = install_root / "skills" / name / "SKILL.md"
        target = skills_dir / name
        if not source.is_file():
            missing_source.append(name)
            continue
        if not target.exists() and not target.is_symlink():
            missing.append(name)
            continue
        if (target / "SKILL.md").is_file():
            continue
        if _is_agentera_managed_skill_path(target, name):
            broken.append(name)
        else:
            user_owned.append(name)

    if not missing and not broken and not missing_source:
        details = [f"user-owned skill path preserved: {name}" for name in user_owned]
        return _check(
            "opencode_skill_paths",
            "pass",
            "OpenCode Agentera skill paths resolve to SKILL.md",
            path=skills_dir,
            details=details,
        )

    details = [*(f"missing: {name}" for name in missing), *(f"broken: {name}" for name in broken)]
    if missing_source:
        details.extend(f"missing install source: {name}" for name in missing_source)
        details.append(f"action: {OPENCODE_SKILL_INSTALL_COMMAND}")
    else:
        details.append("action: start OpenCode with the Agentera plugin to restore managed skill paths")
    if user_owned:
        details.extend(f"user-owned skill path preserved: {name}" for name in user_owned)
    return _check(
        "opencode_skill_paths",
        "warn",
        "OpenCode Agentera skill paths are missing or broken",
        path=skills_dir,
        gap="skill_path_drift",
        details=details,
    )


def _normalize_reference(raw: str) -> str | None:
    candidate = raw.strip("`'\"()[]{}.,:;")
    path = Path(candidate)
    if not candidate or path.is_absolute() or "\\" in candidate:
        return None
    parts = candidate.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        return None
    return candidate


def _extract_reference_paths(text: str) -> list[str]:
    refs: list[str] = []
    seen: set[str] = set()
    for match in SUPPORT_PATH_RE.finditer(text):
        ref = _normalize_reference(match.group("path"))
        if ref is not None and ref not in seen:
            refs.append(ref)
            seen.add(ref)
    return refs


def _diagnose_bundled_reference_validation(install_root: Path) -> dict[str, Any]:
    skills_dir = install_root / "skills"
    missing: list[str] = []
    for skill_file in sorted(skills_dir.glob("*/SKILL.md")):
        text = skill_file.read_text(encoding="utf-8")
        for ref in _extract_reference_paths(text):
            if not (skill_file.parent / ref).exists():
                missing.append(f"{skill_file.parent.name}: {ref}")

    if not missing:
        return _check(
            "bundled_support_references",
            "pass",
            "bundled support references validate separately from installer freshness",
            path=skills_dir,
        )

    return _check(
        "bundled_support_references",
        "warn",
        "bundled reference validation drift found despite installer freshness",
        path=skills_dir,
        gap="validation_drift",
        details=missing,
    )


def _smoke_check(
    name: str,
    category: str,
    status: str,
    message: str,
    *,
    command: list[str] | None = None,
    path: Path | str | None = None,
    details: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "name": name,
        "category": category,
        "status": status,
        "message": message,
        "command": command or [],
        "path": str(path) if path is not None else None,
        "details": details or [],
    }


def _run_helper_smoke(install_root: Path) -> dict[str, Any]:
    helper = install_root / "scripts" / "validate_capability.py"
    capability = install_root / "skills" / "agentera" / "capabilities" / "hej"
    command = [sys.executable, str(helper), str(capability)]
    if not helper.is_file():
        return _smoke_check(
            "helper.validate_capability",
            "helper",
            "fail",
            "validate_capability.py helper is missing",
            command=command,
            path=helper,
            details=["bundle_packaging"],
        )
    if not capability.is_dir():
        return _smoke_check(
            "helper.validate_capability",
            "helper",
            "fail",
            "hej capability directory for helper smoke is missing",
            command=command,
            path=capability,
            details=["bundle_packaging"],
        )

    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            cwd=str(install_root),
            timeout=SMOKE_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return _smoke_check(
            "helper.validate_capability",
            "helper",
            "fail",
            f"validate_capability.py smoke timed out after {SMOKE_TIMEOUT_SECONDS}s",
            command=command,
            path=helper,
        )

    if result.returncode != 0:
        return _smoke_check(
            "helper.validate_capability",
            "helper",
            "fail",
            f"validate_capability.py exited {result.returncode}",
            command=command,
            path=helper,
            details=_tail(result.stdout) + _tail(result.stderr),
        )

    return _smoke_check(
        "helper.validate_capability",
        "helper",
        "pass",
        "validate_capability.py reached a packaged capability successfully",
        command=command,
        path=helper,
        details=_tail(result.stdout, limit=3),
    )


def _run_hook_smoke(install_root: Path) -> dict[str, Any]:
    hook = install_root / "hooks" / "validate_artifact.py"
    command = [sys.executable, str(hook)]
    if not hook.is_file():
        return _smoke_check(
            "hook.artifact_validation",
            "hook",
            "fail",
            "validate_artifact.py hook is missing",
            command=command,
            path=hook,
            details=["bundle_packaging"],
        )

    with tempfile.TemporaryDirectory(prefix="agentera-doctor-smoke-") as tmp:
        project = Path(tmp)
        payload = {
            "runtime": "opencode",
            "hook_event_name": "tool.execute.before",
            "cwd": str(project),
            "tool_input": {
                "file_path": str(project / "TODO.md"),
                "content": "# TODO\n\n## Missing required severity sections\n",
            },
        }
        try:
            result = subprocess.run(
                command,
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                cwd=str(install_root),
                timeout=SMOKE_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return _smoke_check(
                "hook.artifact_validation",
                "hook",
                "fail",
                f"validate_artifact.py smoke timed out after {SMOKE_TIMEOUT_SECONDS}s",
                command=command,
                path=hook,
            )

    if result.returncode in (0, 2) and not result.stdout.strip():
        label = "denied" if result.returncode == 2 else "accepted"
        return _smoke_check(
            "hook.artifact_validation",
            "hook",
            "pass",
            f"validate_artifact.py is functional ({label} smoke candidate, v2 exit-code protocol)",
            command=command,
            path=hook,
            details=_tail(result.stderr),
        )

    if result.returncode not in (0, 2):
        return _smoke_check(
            "hook.artifact_validation",
            "hook",
            "fail",
            f"validate_artifact.py exited {result.returncode}",
            command=command,
            path=hook,
            details=_tail(result.stdout) + _tail(result.stderr),
        )

    try:
        decision = json.loads(result.stdout)
    except json.JSONDecodeError:
        return _smoke_check(
            "hook.artifact_validation",
            "hook",
            "fail",
            "validate_artifact.py did not emit a pre-write decision",
            command=command,
            path=hook,
            details=_tail(result.stdout) + _tail(result.stderr),
        )

    if decision.get("permissionDecision") != "deny":
        return _smoke_check(
            "hook.artifact_validation",
            "hook",
            "fail",
            "artifact hook allowed an invalid TODO.md candidate",
            command=command,
            path=hook,
            details=[json.dumps(decision, sort_keys=True)],
        )

    return _smoke_check(
        "hook.artifact_validation",
        "hook",
        "pass",
        "artifact hook denied an invalid TODO.md candidate as expected",
        command=command,
        path=hook,
        details=[decision.get("permissionDecisionReason", "")],
    )


def _run_runtime_host_smokes(
    env: Mapping[str, str],
    runtimes: tuple[str, ...],
    *,
    live_model_allowed: bool,
) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    for runtime in runtimes:
        binary = _binary_path(runtime, env)
        if binary is None:
            path_problem = _runtime_host_path_problem(runtime, env)
            if path_problem is not None:
                path, message = path_problem
                checks.append(
                    _smoke_check(
                        f"host.{runtime}",
                        "runtime_host",
                        "fail",
                        message,
                        path=path,
                        details=[
                            "runtime host was not invoked",
                            "no live model call attempted",
                        ],
                    )
                )
                continue
            checks.append(
                _smoke_check(
                    f"host.{runtime}",
                    "runtime_host",
                    "skip",
                    f"{RUNTIME_BINARIES[runtime]} executable not found on PATH",
                    path=RUNTIME_BINARIES[runtime],
                    details=["no live model call attempted"],
                )
            )
            continue
        checks.append(
            _smoke_check(
                f"host.{runtime}",
                "runtime_host",
                "pass",
                (
                    f"{RUNTIME_BINARIES[runtime]} executable found; "
                    "bounded doctor smoke does not invoke live model hosts"
                ),
                path=binary,
                details=[
                    "live model permission supplied"
                    if live_model_allowed
                    else "no live model permission supplied",
                    "no live model call attempted",
                ],
            )
        )
    return checks


def run_smoke_checks(
    root_report: Mapping[str, Any],
    env: Mapping[str, str],
    runtimes: tuple[str, ...],
    *,
    live_model_allowed: bool = False,
) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    root_path = Path(root_report["path"]) if root_report.get("path") else None
    if root_path is None or root_report.get("status") == "fail":
        checks.append(
            _smoke_check(
                "install_root",
                "setup",
                "fail",
                "smoke checks require a valid Agentera install root",
                details=list(root_report.get("missing") or []),
            )
        )
    else:
        checks.append(_run_helper_smoke(root_path))
        checks.append(_run_hook_smoke(root_path))

    checks.extend(
        _run_runtime_host_smokes(
            env,
            runtimes,
            live_model_allowed=live_model_allowed,
        )
    )
    summary = _summarize_statuses(checks)
    return {
        "enabled": True,
        "liveModelAllowed": live_model_allowed,
        "modelCallsAttempted": False,
        "summary": summary,
        "checks": checks,
    }


def diagnose_claude(install_root: Path, home: Path, env: Mapping[str, str]) -> dict[str, Any]:
    value = env.get("CLAUDE_PLUGIN_ROOT")
    if not value:
        checks = [
            _check(
                "CLAUDE_PLUGIN_ROOT",
                "warn",
                "Claude Code plugin root is not present in this process environment",
                source="environment",
                gap="user_environment",
            )
        ]
    else:
        checks = [
            _configured_root_check(
                "CLAUDE_PLUGIN_ROOT",
                Path(value).expanduser().resolve(),
                install_root,
                "environment",
            )
        ]
    return _runtime_result("claude", env, checks)


def diagnose_opencode(install_root: Path, home: Path, env: Mapping[str, str]) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    config_dir = _opencode_config_dir(home, env)
    plugin = config_dir / "plugins" / "agentera.js"
    if plugin.is_file():
        checks.append(_check("plugin_file", "pass", "OpenCode plugin file is present", path=plugin))
    else:
        checks.append(
            _check(
                "plugin_file",
                "warn",
                "OpenCode plugin file is not installed at the native plugin path",
                path=plugin,
                gap="runtime_config",
            )
        )

    if env.get("AGENTERA_HOME"):
        path = Path(env["AGENTERA_HOME"]).expanduser().resolve()
        checks.append(_configured_root_check("AGENTERA_HOME", path, install_root, "environment"))
    else:
        candidates = [
            ("default-install-root", home / ".agents" / "agentera"),
            ("default-skill-root", home / ".agents" / "skills" / "agentera"),
        ]
        existing = [(source, path) for source, path in candidates if path.exists()]
        if existing:
            source, path = existing[0]
            checks.append(_configured_root_check("AGENTERA_HOME", path.resolve(), install_root, source))
        else:
            checks.append(
                _check(
                    "AGENTERA_HOME",
                    "warn",
                    "OpenCode cannot see AGENTERA_HOME or a documented default Agentera root",
                    source="environment/defaults",
                    gap="runtime_config",
            )
        )

    checks.append(_diagnose_opencode_commands(home, env))
    checks.append(_diagnose_opencode_skill_paths(install_root, home, env))
    checks.append(_diagnose_bundled_reference_validation(install_root))

    return _runtime_result("opencode", env, checks)


def _copilot_rc_paths(home: Path) -> tuple[Path, ...]:
    return (
        home / ".bashrc",
        home / ".zshrc",
        home / ".config" / "fish" / "config.fish",
    )


def _extract_copilot_marker_root(text: str) -> str | None:
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.rstrip() != COPILOT_MARKER:
            continue
        if index + 1 >= len(lines):
            return None
        export = lines[index + 1].strip()
        for prefix in ('export AGENTERA_HOME="', "set -x AGENTERA_HOME \""):
            if export.startswith(prefix) and export.endswith('"'):
                return export[len(prefix):-1]
    return None


def diagnose_copilot(install_root: Path, home: Path, env: Mapping[str, str]) -> dict[str, Any]:
    value = env.get("AGENTERA_HOME")
    if value:
        checks = [
            _configured_root_check(
                "AGENTERA_HOME",
                Path(value).expanduser().resolve(),
                install_root,
                "environment",
            )
        ]
        return _runtime_result("copilot", env, checks)

    for rc_path in _copilot_rc_paths(home):
        if not rc_path.is_file():
            continue
        marker_root = _extract_copilot_marker_root(rc_path.read_text(encoding="utf-8"))
        if marker_root is None:
            continue
        check = _configured_root_check(
            "AGENTERA_HOME",
            Path(marker_root).expanduser().resolve(),
            install_root,
            str(rc_path),
        )
        if check["status"] == "pass":
            check["message"] = (
                "Copilot rc file is configured; restart the shell to load AGENTERA_HOME"
            )
        return _runtime_result("copilot", env, [check])

    checks = [
        _check(
            "AGENTERA_HOME",
            "warn",
            "Copilot helper access is not configured in the environment or known shell rc files",
            source="environment/rc",
            gap="runtime_config",
        )
    ]
    return _runtime_result("copilot", env, checks)


def _read_codex_agentera_home(config_path: Path) -> tuple[str | None, str | None]:
    if not config_path.is_file():
        return None, "missing"
    try:
        data = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        return None, f"invalid TOML: {exc}"
    policy = data.get("shell_environment_policy")
    if not isinstance(policy, dict):
        return None, "missing shell_environment_policy.set.AGENTERA_HOME"
    set_table = policy.get("set")
    if not isinstance(set_table, dict):
        return None, "missing shell_environment_policy.set.AGENTERA_HOME"
    value = set_table.get("AGENTERA_HOME")
    if not isinstance(value, str) or not value:
        return None, "missing shell_environment_policy.set.AGENTERA_HOME"
    return value, None


def diagnose_codex(install_root: Path, home: Path, env: Mapping[str, str]) -> dict[str, Any]:
    config = home / ".codex" / "config.toml"
    value, error = _read_codex_agentera_home(config)
    if error is not None:
        status = "warn" if error == "missing" or error.startswith("missing ") else "fail"
        checks = [
            _check(
                "config.AGENTERA_HOME",
                status,
                f"Codex config cannot provide helper-script access: {error}",
                source=str(config),
                path=config,
                gap="runtime_config",
            )
        ]
    else:
        checks = [
            _configured_root_check(
                "config.AGENTERA_HOME",
                Path(value).expanduser().resolve(),
                install_root,
                str(config),
            )
        ]
    return _runtime_result("codex", env, checks)


DIAGNOSTICS = {
    "claude": diagnose_claude,
    "opencode": diagnose_opencode,
    "copilot": diagnose_copilot,
    "codex": diagnose_codex,
}


def _load_setup_helper(name: str) -> Any:
    path = ROOT / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load setup helper at {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _read_text_or_none(path: Path) -> str | None:
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def _installer_change(
    *,
    runtime: str,
    target: Path | None,
    reason: str,
    status: str,
    action: str,
    message: str,
    new_text: str = "",
    diff: str = "",
) -> dict[str, Any]:
    return {
        "runtime": runtime,
        "target": str(target) if target is not None else None,
        "reason": reason,
        "status": status,
        "action": action,
        "message": message,
        "newText": new_text,
        "diff": diff,
    }


def _fixable_reason(
    runtime_report: Mapping[str, Any],
    check_name: str,
    *,
    gaps: tuple[str, ...] = ("runtime_config", "user_environment"),
) -> str | None:
    if not runtime_report.get("available"):
        return None
    for check in runtime_report.get("checks", []):
        if check.get("name") != check_name:
            continue
        if check.get("status") not in ("warn", "fail"):
            continue
        if check.get("gap") not in gaps:
            continue
        return str(check.get("message") or "doctor found a fixable setup gap")
    return None


def _plan_codex_installer_change(
    install_root: Path,
    home: Path,
    runtime_report: Mapping[str, Any],
) -> dict[str, Any] | None:
    reason = _fixable_reason(
        runtime_report,
        "config.AGENTERA_HOME",
        gaps=("runtime_config",),
    )
    if reason is None:
        return None

    target = home / ".codex" / "config.toml"
    helper = _load_setup_helper("setup_codex")
    try:
        current_text = _read_text_or_none(target)
        outcome = helper.plan_change(current_text, install_root, force=False)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        return _installer_change(
            runtime="codex",
            target=target,
            reason=reason,
            status="blocked",
            action="blocked",
            message=f"cannot safely plan Codex config change: {exc}",
        )

    if outcome.action == "noop":
        return _installer_change(
            runtime="codex",
            target=target,
            reason=reason,
            status="noop",
            action=outcome.action,
            message=outcome.message,
        )
    if outcome.action == "conflict":
        return _installer_change(
            runtime="codex",
            target=target,
            reason=reason,
            status="blocked",
            action=outcome.action,
            message=outcome.message,
            diff=outcome.diff,
        )
    return _installer_change(
        runtime="codex",
        target=target,
        reason=reason,
        status="pending",
        action=outcome.action,
        message=outcome.message,
        new_text=outcome.new_text,
        diff=outcome.diff,
    )


def _copilot_target(
    home: Path,
    env: Mapping[str, str],
) -> tuple[Path | None, str | None, str]:
    shell_name = Path(env.get("SHELL", "")).name if env.get("SHELL") else ""
    if shell_name == "bash":
        return home / ".bashrc", "export", "bash"
    if shell_name == "zsh":
        return home / ".zshrc", "export", "zsh"
    if shell_name == "fish":
        return home / ".config" / "fish" / "config.fish", "fish", "fish"
    return None, None, shell_name or "(unset $SHELL)"


def _plan_copilot_installer_change(
    install_root: Path,
    home: Path,
    env: Mapping[str, str],
    runtime_report: Mapping[str, Any],
) -> dict[str, Any] | None:
    reason = _fixable_reason(runtime_report, "AGENTERA_HOME")
    if reason is None:
        return None

    target, syntax, shell_name = _copilot_target(home, env)
    if target is None or syntax is None:
        return _installer_change(
            runtime="copilot",
            target=None,
            reason=reason,
            status="blocked",
            action="unsupported-shell",
            message=(
                f"Copilot installer supports bash, zsh, and fish rc files; "
                f"detected {shell_name}"
            ),
        )

    helper = _load_setup_helper("setup_copilot")
    try:
        current_text = _read_text_or_none(target)
        outcome = helper.plan_change(current_text, install_root, syntax)
    except OSError as exc:
        return _installer_change(
            runtime="copilot",
            target=target,
            reason=reason,
            status="blocked",
            action="blocked",
            message=f"cannot safely plan Copilot rc change: {exc}",
        )

    if outcome.action == "noop":
        return _installer_change(
            runtime="copilot",
            target=target,
            reason=reason,
            status="noop",
            action=outcome.action,
            message=outcome.message,
        )
    return _installer_change(
        runtime="copilot",
        target=target,
        reason=reason,
        status="pending",
        action=outcome.action,
        message=outcome.message,
        new_text=outcome.new_text,
        diff=outcome.diff,
    )


def _summarize_installer(changes: list[dict[str, Any]]) -> dict[str, int]:
    statuses = ("pending", "applied", "noop", "blocked", "failed")
    summary = {status: 0 for status in statuses}
    for change in changes:
        summary[change["status"]] += 1
    return summary


def build_installer_plan(
    report: Mapping[str, Any],
    *,
    home: Path,
    env: Mapping[str, str],
    runtimes: tuple[str, ...],
    confirmed: bool,
    dry_run: bool,
) -> dict[str, Any]:
    changes: list[dict[str, Any]] = []
    root_path = report.get("installRoot", {}).get("path")
    if not root_path or report.get("installRoot", {}).get("status") == "fail":
        return {
            "schemaVersion": INSTALLER_SCHEMA_VERSION,
            "confirmed": confirmed,
            "dryRun": dry_run,
            "changes": changes,
            "summary": _summarize_installer(changes),
            "afterDoctor": None,
            "message": "installer requires a valid Agentera install root",
        }

    install_root = Path(root_path)
    for runtime in runtimes:
        runtime_report = report["runtimes"][runtime]
        if runtime == "codex":
            change = _plan_codex_installer_change(install_root, home, runtime_report)
        elif runtime == "copilot":
            change = _plan_copilot_installer_change(
                install_root,
                home,
                env,
                runtime_report,
            )
        else:
            change = None
        if change is not None:
            changes.append(change)

    return {
        "schemaVersion": INSTALLER_SCHEMA_VERSION,
        "confirmed": confirmed,
        "dryRun": dry_run,
        "changes": changes,
        "summary": _summarize_installer(changes),
        "afterDoctor": None,
        "message": (
            "no installer changes needed"
            if not changes
            else "installer changes planned"
        ),
    }


def apply_installer_plan(plan: dict[str, Any]) -> None:
    for change in plan["changes"]:
        if change["status"] != "pending":
            continue
        target = Path(change["target"])
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(change["newText"], encoding="utf-8")
        except OSError as exc:
            change["status"] = "failed"
            change["message"] = f"error writing {target}: {exc}"
            continue
        change["status"] = "applied"
        change["message"] = (
            f"wrote {target}: {change['message'].replace('would ', '')}"
        )
    plan["summary"] = _summarize_installer(plan["changes"])


def _summarize(runtimes: Mapping[str, dict[str, Any]]) -> dict[str, int]:
    return _summarize_statuses(runtimes)


def build_report(
    *,
    install_root: Path | None = None,
    home: Path | None = None,
    env: Mapping[str, str] | None = None,
    runtimes: tuple[str, ...] = RUNTIMES,
    run_smoke: bool = False,
    live_model_allowed: bool = False,
) -> dict[str, Any]:
    source_env = dict(os.environ if env is None else env)
    root_report = classify_install_root(install_root, source_env)
    root_path = Path(root_report["path"]) if root_report["path"] else None
    home_path = (home or Path.home()).expanduser().resolve()

    runtime_reports: dict[str, dict[str, Any]] = {}
    if root_path is None or root_report["status"] == "fail":
        for runtime in runtimes:
            runtime_reports[runtime] = _runtime_result(
                runtime,
                source_env,
                [
                    _check(
                        "install_root",
                        "fail",
                        "runtime diagnosis requires a valid Agentera install root",
                        gap=root_report["gap"],
                        details=root_report["missing"],
                    )
                ],
            )
    else:
        for runtime in runtimes:
            runtime_reports[runtime] = DIAGNOSTICS[runtime](root_path, home_path, source_env)

    summary = _summarize(runtime_reports)
    smoke_report: dict[str, Any] = {
        "enabled": False,
        "liveModelAllowed": live_model_allowed,
        "modelCallsAttempted": False,
        "summary": {status: 0 for status in STATUSES},
        "checks": [],
    }
    if run_smoke:
        smoke_report = run_smoke_checks(
            root_report,
            source_env,
            runtimes,
            live_model_allowed=live_model_allowed,
        )

    ok = (
        root_report["status"] != "fail"
        and summary["fail"] == 0
        and smoke_report["summary"]["fail"] == 0
    )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "ok": ok,
        "installRoot": root_report,
        "runtimes": runtime_reports,
        "summary": summary,
        "smoke": smoke_report,
    }


def render_human(report: Mapping[str, Any]) -> str:
    lines = [
        "Agentera setup doctor",
        f"install root: {report['installRoot']['status']} - {report['installRoot']['message']}",
    ]
    if report["installRoot"].get("path"):
        lines.append(f"  path: {report['installRoot']['path']}")
    if report["installRoot"].get("missing"):
        lines.append("  missing: " + ", ".join(report["installRoot"]["missing"]))

    for runtime, result in report["runtimes"].items():
        lines.append(f"{runtime}: {result['status']}")
        for check in result["checks"]:
            suffix = f" [{check['gap']}]" if check.get("gap") else ""
            lines.append(f"  - {check['name']}: {check['status']} - {check['message']}{suffix}")
            if check.get("path"):
                lines.append(f"    path: {check['path']}")
            if check.get("details"):
                lines.append("    details: " + ", ".join(check["details"]))

    smoke = report.get("smoke", {})
    if smoke.get("enabled"):
        lines.append("smoke: enabled")
        lines.append(f"  model calls attempted: {smoke.get('modelCallsAttempted')}")
        for check in smoke.get("checks", []):
            lines.append(
                f"  - {check['name']}: {check['status']} - "
                f"{check['message']} [{check['category']}]"
            )
            if check.get("path"):
                lines.append(f"    path: {check['path']}")
            if check.get("details"):
                lines.append("    details: " + ", ".join(check["details"]))
    return "\n".join(lines)


def render_installer(installer: Mapping[str, Any]) -> str:
    lines = ["Agentera setup installer", f"status: {installer['message']}"]
    if not installer["changes"]:
        return "\n".join(lines)

    for change in installer["changes"]:
        lines.append(f"{change['runtime']}: {change['status']}")
        lines.append(f"  target: {change['target'] or '(none)'}")
        lines.append(f"  reason: {change['reason']}")
        lines.append(f"  action: {change['action']} - {change['message']}")
    if installer.get("afterDoctor") is not None:
        after = installer["afterDoctor"]
        lines.append(
            "doctor after install: "
            f"{'pass' if after.get('ok') else 'fail'} "
            f"(summary: {after.get('summary')})"
        )
    elif installer["summary"]["pending"] and not installer.get("dryRun"):
        lines.append("confirmation required: re-run with --yes to apply these changes")
    return "\n".join(lines)


def _public_installer(installer: Mapping[str, Any] | None) -> Mapping[str, Any] | None:
    if installer is None:
        return None
    public = dict(installer)
    public["changes"] = [
        {
            key: value
            for key, value in change.items()
            if key not in {"newText", "diff"}
        }
        for change in installer["changes"]
    ]
    return public


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Diagnose Agentera setup without writing files by default. "
            "Use --install --yes for confirmed runtime-native config writes."
        )
    )
    parser.add_argument("--install-root", type=Path, default=None)
    parser.add_argument("--home", type=Path, default=None, help=argparse.SUPPRESS)
    parser.add_argument("--runtime", choices=RUNTIMES, action="append", help="limit diagnosis to one runtime")
    parser.add_argument("--smoke", action="store_true", help="run bounded offline smoke checks")
    parser.add_argument(
        "--install",
        action="store_true",
        help="plan runtime-native fixes for doctor findings; writes only with --yes",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="confirm installer writes selected runtime-native config files",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="with --install, print planned changes without writing",
    )
    parser.add_argument(
        "--allow-live-model",
        action="store_true",
        help="record explicit permission for future live model smoke probes; no live calls are made by this doctor",
    )
    parser.add_argument("--json", action="store_true", help="emit the stable machine-readable summary")
    args = parser.parse_args(argv)

    if args.yes and not args.install:
        parser.error("--yes requires --install")
    if args.dry_run and not args.install:
        parser.error("--dry-run requires --install")

    runtimes = tuple(args.runtime) if args.runtime else RUNTIMES
    source_env = dict(os.environ)
    home = (args.home or Path.home()).expanduser().resolve()
    report = build_report(
        install_root=args.install_root,
        home=home,
        env=source_env,
        runtimes=runtimes,
        run_smoke=args.smoke,
        live_model_allowed=args.allow_live_model,
    )

    installer: dict[str, Any] | None = None
    if args.install:
        installer = build_installer_plan(
            report,
            home=home,
            env=source_env,
            runtimes=runtimes,
            confirmed=args.yes,
            dry_run=args.dry_run,
        )
        if args.yes:
            apply_installer_plan(installer)
            installer["afterDoctor"] = build_report(
                install_root=args.install_root,
                home=home,
                env=source_env,
                runtimes=runtimes,
                run_smoke=args.smoke,
                live_model_allowed=args.allow_live_model,
            )

    if args.json:
        payload: Mapping[str, Any] = (
            {"doctor": report, "installer": _public_installer(installer)}
            if installer is not None
            else report
        )
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(render_human(report))
        if installer is not None:
            print()
            print(render_installer(installer))

    if installer is None:
        return 0 if report["ok"] else 1
    if installer["summary"]["failed"] or installer["summary"]["blocked"]:
        return 1
    if installer["summary"]["pending"] and not args.dry_run and not args.yes:
        return 1
    if installer.get("afterDoctor") is not None and not installer["afterDoctor"]["ok"]:
        return 1
    if not report["ok"] and not (
        installer["summary"]["pending"] or installer["summary"]["applied"]
    ):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
