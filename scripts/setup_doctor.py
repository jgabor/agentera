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
import sys
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
    counts = {status: 0 for status in STATUSES}
    for runtime in runtimes.values():
        counts[runtime["status"]] += 1
    return counts


def build_report(
    *,
    install_root: Path | None = None,
    home: Path | None = None,
    env: Mapping[str, str] | None = None,
    runtimes: tuple[str, ...] = RUNTIMES,
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
    ok = root_report["status"] != "fail" and summary["fail"] == 0
    return {
        "schemaVersion": SCHEMA_VERSION,
        "ok": ok,
        "installRoot": root_report,
        "runtimes": runtime_reports,
        "summary": summary,
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
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Diagnose Agentera setup without writing files.")
    parser.add_argument("--install-root", type=Path, default=None)
    parser.add_argument("--home", type=Path, default=None, help=argparse.SUPPRESS)
    parser.add_argument("--runtime", choices=RUNTIMES, action="append", help="limit diagnosis to one runtime")
    parser.add_argument("--json", action="store_true", help="emit the stable machine-readable summary")
    args = parser.parse_args(argv)

    runtimes = tuple(args.runtime) if args.runtime else RUNTIMES
    report = build_report(install_root=args.install_root, home=args.home, runtimes=runtimes)
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(render_human(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
