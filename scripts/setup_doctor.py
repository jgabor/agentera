#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Read-only setup diagnosis for an Agentera suite bundle.

The doctor answers one question without mutating anything: can the current
runtime reach the Agentera install root and its shared helper scripts?

It reports the aggregate bundle root first, then classifies runtime-native
setup shapes for Claude Code, OpenCode, Copilot CLI, and Codex CLI as
``pass``, ``warn``, ``fail``, or ``skip``. The JSON output is intentionally
stable so later installer and smoke-check tasks can consume the same envelope.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
from collections.abc import Mapping
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_VERSION = "agentera.setupDoctor.v1"
STATUSES = ("pass", "warn", "fail", "skip")
RUNTIMES = ("claude", "opencode", "copilot", "codex")
RUNTIME_BINARIES = {
    "claude": "claude",
    "opencode": "opencode",
    "copilot": "copilot",
    "codex": "codex",
}
CANONICAL_ENTRIES = (
    "scripts/validate_spec.py",
    "hooks",
    "skills",
    "SPEC.md",
)
HELPER_ENTRIES = (
    "scripts/compact_artifact.py",
    "scripts/validate_spec.py",
    "hooks/validate_artifact.py",
)
SMOKE_TIMEOUT_SECONDS = 30
ENV_FALLBACKS = ("AGENTERA_HOME", "CLAUDE_PLUGIN_ROOT")
COPILOT_MARKER = "# agentera: AGENTERA_HOME (managed)"


def verify_install_root(root: Path) -> list[str]:
    return [entry for entry in CANONICAL_ENTRIES if not (root / entry).exists()]


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
            "missing": list(CANONICAL_ENTRIES),
        }

    missing = verify_install_root(root)
    if missing:
        return {
            "status": "fail",
            "path": str(root),
            "source": source,
            "kind": None,
            "gap": "bundle_packaging",
            "message": "install root is missing canonical Agentera entries",
            "missing": missing,
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
    if not candidate.exists():
        return _check(
            name,
            "fail",
            "configured Agentera root does not exist",
            source=source,
            path=candidate,
            gap="runtime_config",
        )

    missing = verify_install_root(candidate)
    if missing:
        return _check(
            name,
            "fail",
            "configured Agentera root is not a valid suite bundle",
            source=source,
            path=candidate,
            gap="bundle_packaging",
            details=missing,
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
    helper = install_root / "scripts" / "validate_spec.py"
    skill = install_root / "skills" / "realisera" / "SKILL.md"
    command = [sys.executable, str(helper), "--skill", str(skill)]
    if not helper.is_file():
        return _smoke_check(
            "helper.validate_spec",
            "helper",
            "fail",
            "validate_spec.py helper is missing",
            command=command,
            path=helper,
            details=["bundle_packaging"],
        )
    if not skill.is_file():
        return _smoke_check(
            "helper.validate_spec",
            "helper",
            "fail",
            "realisera SKILL.md fixture for helper smoke is missing",
            command=command,
            path=skill,
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
            "helper.validate_spec",
            "helper",
            "fail",
            f"validate_spec.py smoke timed out after {SMOKE_TIMEOUT_SECONDS}s",
            command=command,
            path=helper,
        )

    if result.returncode != 0:
        return _smoke_check(
            "helper.validate_spec",
            "helper",
            "fail",
            f"validate_spec.py exited {result.returncode}",
            command=command,
            path=helper,
            details=_tail(result.stdout) + _tail(result.stderr),
        )

    return _smoke_check(
        "helper.validate_spec",
        "helper",
        "pass",
        "validate_spec.py reached a packaged skill successfully",
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

    if result.returncode != 0:
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
    plugin = home / ".config" / "opencode" / "plugins" / "agentera.js"
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

    return _runtime_result("opencode", env, checks)


def _copilot_rc_paths(home: Path) -> tuple[Path, ...]:
    return (
        home / ".bashrc",
        home / ".zshrc",
        home / ".config" / "fish" / "config.fish",
    )


def _extract_copilot_marker_root(text: str) -> str | None:
    lines = text.splitlines()
    for index, line in enumerate(lines[:-1]):
        if line.rstrip() != COPILOT_MARKER:
            continue
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
            check["status"] = "warn"
            check["gap"] = "user_environment"
            check["message"] = (
                "Copilot rc file is configured, but this shell has not loaded AGENTERA_HOME"
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Diagnose Agentera setup without writing files.")
    parser.add_argument("--install-root", type=Path, default=None)
    parser.add_argument("--home", type=Path, default=None, help=argparse.SUPPRESS)
    parser.add_argument("--runtime", choices=RUNTIMES, action="append", help="limit diagnosis to one runtime")
    parser.add_argument("--smoke", action="store_true", help="run bounded offline smoke checks")
    parser.add_argument(
        "--allow-live-model",
        action="store_true",
        help="record explicit permission for future live model smoke probes; no live calls are made by this doctor",
    )
    parser.add_argument("--json", action="store_true", help="emit the stable machine-readable summary")
    args = parser.parse_args(argv)

    runtimes = tuple(args.runtime) if args.runtime else RUNTIMES
    report = build_report(
        install_root=args.install_root,
        home=args.home,
        runtimes=runtimes,
        run_smoke=args.smoke,
        live_model_allowed=args.allow_live_model,
    )
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(render_human(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
