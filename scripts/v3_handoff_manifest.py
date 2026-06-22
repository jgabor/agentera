#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""v2→v3 handoff manifest writer and current-state checks.

Contract authority: references/cli/v3-handoff-manifest.schema.yaml
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from importlib.machinery import SourceFileLoader
from pathlib import Path
from typing import Any, Mapping

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_FILENAME = "v3-handoff.json"
SCHEMA_VERSION = "agentera.v3_handoff_manifest.v1"
USER_DATA_DIRS = ("benchmarks", "intermediate", "sessions", "history", "corpus")
PROFILE_FILE_MEMBERS = ("PROFILE.md", "USAGE.md")


def _load_upgrade_module() -> Any:
    loader = SourceFileLoader(
        "agentera_upgrade_for_handoff",
        str(ROOT / "scripts" / "agentera_upgrade.py"),
    )
    return loader.load_module()


def _load_setup_doctor_module() -> Any:
    loader = SourceFileLoader(
        "agentera_setup_doctor_for_handoff",
        str(ROOT / "scripts" / "setup_doctor.py"),
    )
    return loader.load_module()


def manifest_path(app_home: Path) -> Path:
    return app_home.expanduser().resolve() / MANIFEST_FILENAME


def _path_exists(path: Path) -> bool:
    return path.exists()


def build_user_data_inventory(app_home: Path) -> list[dict[str, Any]]:
    root = app_home.expanduser().resolve()
    inventory: list[dict[str, Any]] = []
    for name in USER_DATA_DIRS:
        rel = Path(name)
        inventory.append(
            {
                "id": name,
                "relative_path": name,
                "kind": "directory",
                "exists": _path_exists(root / rel),
            }
        )
    inventory.append(
        {
            "id": "profile_files",
            "kind": "profile_files",
            "members": [
                {
                    "relative_path": member,
                    "kind": "file",
                    "exists": _path_exists(root / member),
                }
                for member in PROFILE_FILE_MEMBERS
            ],
        }
    )
    return inventory


def active_runtime_adapters(
    install_root: Path,
    home: Path,
    env: Mapping[str, str] | None,
) -> list[str]:
    setup_doctor = _load_setup_doctor_module()
    report = setup_doctor.build_report(
        install_root=install_root,
        home=home,
        env=dict(env or {}),
    )
    adapters: list[str] = []
    for runtime_id, runtime_report in report.get("runtimes", {}).items():
        if runtime_report.get("status") == "pass":
            adapters.append(str(runtime_id))
    return sorted(adapters)


def build_manifest(
    *,
    app_home: Path,
    source_root: Path,
    home: Path,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    upgrade = _load_upgrade_module()
    resolved_home = app_home.expanduser().resolve()
    active_bundle = upgrade._active_bundle_root(resolved_home)
    installed_version = upgrade.load_suite_version(active_bundle) or upgrade.load_suite_version(source_root)
    if not installed_version:
        installed_version = "unknown"
    return {
        "schema_version": SCHEMA_VERSION,
        "written_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "installed_v2_version": installed_version,
        "app_home_path": str(resolved_home),
        "user_data_inventory": build_user_data_inventory(resolved_home),
        "runtime_adapters": active_runtime_adapters(resolved_home, home, env),
    }


def write_manifest(
    *,
    app_home: Path,
    source_root: Path,
    home: Path,
    env: Mapping[str, str] | None = None,
) -> Path:
    resolved_home = app_home.expanduser().resolve()
    target = manifest_path(resolved_home)
    payload = build_manifest(
        app_home=resolved_home,
        source_root=source_root,
        home=home,
        env=env,
    )
    target.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return target


def read_manifest(app_home: Path) -> dict[str, Any] | None:
    target = manifest_path(app_home)
    if not target.is_file():
        return None
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def current_state_context(
    app_home: Path,
    source_root: Path,
) -> dict[str, Any] | None:
    upgrade = _load_upgrade_module()
    resolved_home = app_home.expanduser().resolve()
    active_bundle = upgrade._active_bundle_root(resolved_home)
    marker = upgrade._bundle_marker_path(active_bundle)
    if not marker.is_file():
        return None
    installed_version = upgrade.load_suite_version(active_bundle) or upgrade.load_suite_version(source_root)
    if not installed_version:
        installed_version = "unknown"
    return {
        "app_home": str(resolved_home),
        "installed_version": installed_version,
        "bundle_marker_mtime_ms": marker.stat().st_mtime * 1000,
    }


def is_manifest_stale(manifest: Mapping[str, Any], ctx: Mapping[str, Any]) -> bool:
    if str(manifest.get("schema_version") or "") != SCHEMA_VERSION:
        return True
    if str(manifest.get("app_home_path") or "") != str(ctx["app_home"]):
        return True
    if str(manifest.get("installed_v2_version") or "") != str(ctx["installed_version"]):
        return True
    written_at = str(manifest.get("written_at") or "")
    try:
        written_ms = datetime.fromisoformat(written_at.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return True
    marker_ms = float(ctx["bundle_marker_mtime_ms"])
    if written_ms // 1000 < marker_ms // 1000:
        return True
    return False


def ensure_fresh_manifest(
    *,
    app_home: Path,
    source_root: Path,
    home: Path,
    env: Mapping[str, str] | None = None,
    warn: Any | None = print,
) -> Path | None:
    ctx = current_state_context(app_home, source_root)
    if ctx is None:
        return None
    existing = read_manifest(app_home)
    stale = existing is None or is_manifest_stale(existing, ctx)
    if stale and warn is not None:
        if existing is None:
            warn(f"Agentera: {MANIFEST_FILENAME} is missing; refreshing the v3 handoff manifest.")
        else:
            warn(f"Agentera: {MANIFEST_FILENAME} is stale; refreshing the v3 handoff manifest.")
    if stale:
        return write_manifest(app_home=app_home, source_root=source_root, home=home, env=env)
    return manifest_path(app_home)
