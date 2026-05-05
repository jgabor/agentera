#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Validate runtime lifecycle hook adapter metadata.

The check is intentionally small: Task 5 owns full test coverage. This helper
keeps unsupported lifecycle behavior reportable as soon as adapter metadata
exists.
"""

from __future__ import annotations

import argparse
import json
import shutil
import stat
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]

COPILOT_EVENTS = {
    "sessionStart",
    "sessionEnd",
    "userPromptSubmitted",
    "preToolUse",
    "postToolUse",
    "errorOccurred",
}
CODEX_EVENTS = {
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
}
CODEX_LIFECYCLE_STATUS_VALUES = ("stable", "beta")
CODEX_LIFECYCLE_REQUIRED_LIMITATION_TERMS = ("codex_hooks", "apply_patch", "openai/codex#18391")
COPILOT_PROFILERA_TERMS = ("profilera", "bounded", "corpus", "metadata", "missing source families")
CODEX_PROFILERA_TERMS = (
    "allow_implicit_invocation: false",
    "codex_session_corpus",
    "bounded Codex history, session, or config corpus data",
)
CODEX_AGENTERA_METADATA_TERMS = (
    "$agentera",
    "bounded Codex session corpus data",
    "AGENTERA_HOME",
)
CODEX_PROFILERA_STATUS_VALUES = ("ok", "degraded")
OPENCODE_EVENT_TYPES = {"session.created", "session.idle"}
COPILOT_REQUIRED_PREWRITE_HOOK = "preToolUse"
SUITE_BUNDLE_REQUIRED_PATHS = {
    "skills": "dir",
    "scripts": "dir",
    "hooks": "dir",
    "registry.json": "file",
    "plugin.json": "file",
    "README.md": "file",
}
UV_SCRIPT_SHEBANG = "#!/usr/bin/env -S uv run --script"
UV_INSTALL_GUIDANCE = (
    "uv is required to run packaged Agentera Python scripts; install it from "
    "https://docs.astral.sh/uv/getting-started/installation/ and then rerun the check"
)
RUNTIME_PACKAGE_SURFACES = {
    "claude": ".claude-plugin/marketplace.json",
    "codex": ".codex-plugin/plugin.json",
    "copilot": "plugin.json",
    "opencode": ".opencode/package.json",
}
HARD_GATE_DOC_REQUIREMENTS = {
    "references/adapters/runtime-feature-parity.md": {
        "OpenCode": (
            "Conditional hard gate for reconstructable `write` and `edit` candidates",
            "Sparse payloads and `apply_patch` `patchText` without reconstructed full content are allowed",
        ),
        "Copilot": (
            "Conditional hard gate via `preToolUse`",
            "Malformed, sparse, or non-reconstructable `toolArgs` are allowed",
        ),
    },
    "references/adapters/opencode.md": {
        "OpenCode": (
            "Blocks invalid reconstructable artifact candidates",
            "Sparse payloads and `apply_patch` `patchText` without reconstructed full content are allowed",
        ),
    },
}


def _load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def _validate_command_handler(
    errors: list[str], runtime: str, event: str, index: int, handler: Any
) -> None:
    prefix = f"{runtime}.{event}[{index}]"
    if not isinstance(handler, dict):
        errors.append(f"{prefix}: handler must be an object")
        return

    if handler.get("type") != "command":
        errors.append(f"{prefix}: handler type must be 'command'")

    if "command" in handler:
        errors.append(f"{prefix}: use bash/powershell, not Claude-style command")

    if not handler.get("bash") and not handler.get("powershell"):
        errors.append(f"{prefix}: handler must define bash or powershell")

    timeout = handler.get("timeoutSec")
    if timeout is not None and not isinstance(timeout, int):
        errors.append(f"{prefix}: timeoutSec must be an integer")


def _handler_command_text(handler: Any) -> str:
    if not isinstance(handler, dict):
        return ""
    parts = [handler.get("bash"), handler.get("powershell")]
    return " ".join(part for part in parts if isinstance(part, str))


def _string_paths(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list) and all(isinstance(path, str) for path in value):
        return value
    return []


def _resolve_inside(root: Path, path: str) -> Path | None:
    resolved = (root / path).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        return None
    return resolved


def _resolve_from_manifest(root: Path, manifest: Path, path: str) -> Path | None:
    resolved = (manifest.parent / path).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        return None
    return resolved


def _is_executable(path: Path) -> bool:
    executable_bits = stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
    return bool(path.stat().st_mode & executable_bits)


def _packaged_executable_python_scripts(root: Path) -> list[Path]:
    script_root = root / "scripts"
    if not script_root.is_dir():
        return []
    return sorted(
        path for path in script_root.glob("*.py")
        if path.is_file() and _is_executable(path)
    )


def _extract_inline_script_metadata(text: str) -> list[str] | None:
    lines = text.splitlines()
    try:
        start = lines.index("# /// script")
    except ValueError:
        return None
    for index in range(start + 1, len(lines)):
        if lines[index] == "# ///":
            return lines[start + 1:index]
    return None


def _metadata_declares_empty_dependencies(metadata: list[str]) -> bool:
    dependencies_index = None
    for index, line in enumerate(metadata):
        if line.strip() == "# dependencies = []":
            return True
        if line.strip() == "# dependencies = [":
            dependencies_index = index
            break
    if dependencies_index is None:
        return False
    for line in metadata[dependencies_index + 1:]:
        stripped = line.strip()
        if stripped == "# ]":
            return True
        if stripped and stripped != "#":
            return False
    return False


def validate_packaged_python_scripts(root: Path) -> list[str]:
    errors: list[str] = []
    for path in _packaged_executable_python_scripts(root):
        relative = path.relative_to(root)
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        first_line = lines[0] if lines else ""
        if first_line != UV_SCRIPT_SHEBANG:
            errors.append(f"{relative}: packaged executable Python script must use uv script shebang")
        metadata = _extract_inline_script_metadata(text)
        if metadata is None:
            errors.append(f"{relative}: packaged executable Python script must declare inline script metadata")
            continue
        if not _metadata_declares_empty_dependencies(metadata):
            errors.append(f"{relative}: stdlib-only packaged script must declare dependencies = []")
    return errors


def validate_uv_runtime(path: str | None = None) -> list[str]:
    if shutil.which("uv", path=path) is None:
        return [UV_INSTALL_GUIDANCE]
    return []


def validate_suite_bundle_surface(
    root: Path,
    runtime_names: set[str] | None = None,
) -> list[str]:
    """Validate aggregate runtime metadata for the shared bundle root.

    The ``agentera`` block is interpreted from each runtime manifest location:
    ``installRoot`` points back to the installed Agentera package root, and
    ``sharedPaths`` are resolved from that root.
    """
    errors: list[str] = []
    active = runtime_names if runtime_names is not None else set(RUNTIME_PACKAGE_SURFACES)

    for runtime in sorted(active):
        relative_manifest = RUNTIME_PACKAGE_SURFACES.get(runtime)
        if relative_manifest is None:
            errors.append(f"{runtime}: unknown runtime package surface")
            continue
        manifest = root / relative_manifest
        if not manifest.is_file():
            errors.append(f"{runtime}: missing package metadata {relative_manifest}")
            continue

        try:
            package = _load_json(manifest)
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            errors.append(f"{runtime}: could not read package metadata {relative_manifest}: {exc}")
            continue

        metadata = package.get("agentera")
        if not isinstance(metadata, dict) and runtime == "claude":
            plugins = package.get("plugins")
            if isinstance(plugins, list):
                metadata = next(
                    (
                        plugin.get("agentera")
                        for plugin in plugins
                        if isinstance(plugin, dict)
                        and plugin.get("name") == "agentera"
                        and isinstance(plugin.get("agentera"), dict)
                    ),
                    None,
                )
        if not isinstance(metadata, dict):
            errors.append(f"{runtime}: missing agentera suite bundle metadata")
            continue
        if metadata.get("packageShape") != "suite-bundle":
            errors.append(f"{runtime}: agentera.packageShape must be suite-bundle")

        install_root_value = metadata.get("installRoot")
        if not isinstance(install_root_value, str) or not install_root_value:
            errors.append(f"{runtime}: agentera.installRoot must point at the bundle root")
            continue
        install_root = _resolve_from_manifest(root, manifest, install_root_value)
        if install_root is None:
            errors.append(f"{runtime}: agentera.installRoot must stay inside package root")
            continue
        if install_root != root.resolve():
            errors.append(f"{runtime}: AGENTERA_HOME must resolve to the package root")

        shared_paths = metadata.get("sharedPaths")
        if not isinstance(shared_paths, list) or not all(isinstance(path, str) for path in shared_paths):
            errors.append(f"{runtime}: agentera.sharedPaths must list bundle paths")
            continue
        listed = set(shared_paths)
        for path, expected_kind in SUITE_BUNDLE_REQUIRED_PATHS.items():
            if path not in listed:
                errors.append(f"{runtime}: shared tool path {path} missing from package metadata")
                continue
            resolved = _resolve_inside(install_root, path)
            if resolved is None:
                errors.append(f"{runtime}: shared tool path {path} must stay inside install root")
            elif expected_kind == "dir" and not resolved.is_dir():
                errors.append(f"{runtime}: shared tool path {path} must resolve to a directory")
            elif expected_kind == "file" and not resolved.is_file():
                errors.append(f"{runtime}: shared tool path {path} must resolve to a file")

        single_skill = metadata.get("singleSkillInstall")
        if not isinstance(single_skill, str) or "core" not in single_skill or "suite" not in single_skill:
            errors.append(
                f"{runtime}: agentera.singleSkillInstall must state core skill behavior "
                "does not require suite tools"
            )

    return errors


def validate_copilot(plugin: dict[str, Any], plugin_root: Path) -> list[str]:
    errors: list[str] = []
    if "lifecycleHooks" in plugin:
        errors.append("copilot: use supported hooks component field, not lifecycleHooks")

    skills = plugin.get("skills")
    if not isinstance(skills, str | list):
        errors.append("copilot.skills must be a string or string array path")
    elif isinstance(skills, list) and not all(isinstance(path, str) for path in skills):
        errors.append("copilot.skills entries must be path strings")
    else:
        for path in _string_paths(skills):
            resolved = _resolve_inside(plugin_root, path)
            if resolved is None:
                errors.append("copilot.skills paths must stay inside plugin root")
            elif not resolved.is_dir():
                errors.append("copilot.skills paths must resolve to skill directories")

    hooks = plugin.get("hooks")
    if not isinstance(hooks, str | list):
        errors.append("copilot.hooks must be a string or string array path")
    elif isinstance(hooks, list) and not all(isinstance(path, str) for path in hooks):
        errors.append("copilot.hooks entries must be path strings")
    else:
        for path in _string_paths(hooks):
            resolved = _resolve_inside(plugin_root, path)
            if resolved is None:
                errors.append("copilot.hooks paths must stay inside plugin root")
            elif not resolved.is_dir():
                errors.append("copilot.hooks paths must resolve to a hook directory")

    description = plugin.get("description")
    if not isinstance(description, str) or any(term not in description for term in COPILOT_PROFILERA_TERMS):
        errors.append("copilot.profilera: description must expose bounded corpus metadata limits")

    return errors


def validate_copilot_hooks(plugin_root: Path, plugin: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    hook_paths = _string_paths(plugin.get("hooks"))
    if not hook_paths:
        return errors

    for hooks in hook_paths:
        hook_dir = _resolve_inside(plugin_root, hooks)
        if hook_dir is None:
            errors.append("copilot.hooks paths must stay inside plugin root")
            continue
        if not hook_dir.is_dir():
            errors.append("copilot.hooks must resolve to a hook directory")
            continue

        seen_events: set[str] = set()
        for path in sorted(hook_dir.glob("*.json")):
            hook = _load_json(path)
            event = hook.get("name")
            if path.stem not in COPILOT_EVENTS:
                errors.append(f"copilot: unsupported lifecycle hook file configured: {path.name}")
            if not isinstance(event, str):
                errors.append(f"copilot.{path.name}: hook name must be a string")
                continue
            if event not in COPILOT_EVENTS:
                errors.append(f"copilot: unsupported lifecycle event configured: {event}")
                continue
            if path.stem != event:
                errors.append(f"copilot.{path.name}: hook filename must match event name {event}")
            if event != event[:1].lower() + event[1:]:
                errors.append(f"copilot: event must be lower-camel: {event}")
            _validate_command_handler(errors, "copilot", event, 0, hook)
            seen_events.add(event)
            if event == COPILOT_REQUIRED_PREWRITE_HOOK:
                command_text = _handler_command_text(hook)
                if "hooks/validate_artifact.py" not in command_text:
                    errors.append(
                        "copilot.preToolUse: artifact hard gate must run hooks/validate_artifact.py"
                    )

        if COPILOT_REQUIRED_PREWRITE_HOOK not in seen_events:
            errors.append("copilot: missing required preToolUse artifact validation hook")

    return errors


def validate_codex(plugin: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    lifecycle = plugin.get("lifecycleHooks")
    if not isinstance(lifecycle, dict):
        return ["codex: missing lifecycleHooks limitation metadata"]

    if lifecycle.get("configured") is not False:
        errors.append("codex: lifecycleHooks.configured must be false")
    if lifecycle.get("status") not in CODEX_LIFECYCLE_STATUS_VALUES:
        errors.append(
            "codex: lifecycleHooks.status must be one of "
            + ", ".join(CODEX_LIFECYCLE_STATUS_VALUES)
        )

    events = lifecycle.get("events", {})
    if not isinstance(events, dict):
        errors.append("codex: lifecycleHooks.events must be an object when present")
    else:
        for event in events:
            if event not in CODEX_EVENTS:
                errors.append(f"codex: unsupported lifecycle event configured: {event}")

    supported = lifecycle.get("supportedEvents")
    if not isinstance(supported, list) or set(supported) != CODEX_EVENTS:
        errors.append(
            "codex: supportedEvents must list every Codex codex_hooks event "
            "(SessionStart, Stop, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest)"
        )

    unsupported = lifecycle.get("unsupportedEvents")
    if not isinstance(unsupported, list) or not unsupported:
        errors.append("codex: unsupportedEvents must list Claude-Code-specific events with no Codex equivalent")
    else:
        for entry in unsupported:
            if not isinstance(entry, dict):
                errors.append("codex: unsupportedEvents entries must be objects with event and reason fields")
                continue
            event = entry.get("event")
            if event in CODEX_EVENTS:
                errors.append(
                    f"codex: unsupportedEvents must not list event {event!r} that codex_hooks now supports"
                )

    limitations = lifecycle.get("limitations")
    if not isinstance(limitations, list) or not limitations:
        errors.append("codex: limitations must document codex_hooks status and apply_patch interception")
    else:
        joined = " ".join(item for item in limitations if isinstance(item, str))
        for term in CODEX_LIFECYCLE_REQUIRED_LIMITATION_TERMS:
            if term not in joined:
                errors.append(
                    f"codex: limitations must cite {term!r} so apply_patch interception ground truth stays surfaced"
                )
        stale_markers = ("experimental, require host config opt-in", "experimental-disabled", "no real-time")
        for marker in stale_markers:
            if marker in joined:
                errors.append(f"codex: limitations carry stale wording {marker!r}; remove it")

    return errors


def validate_codex_profilera_metadata(root: Path, plugin: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    agentera = next(
        (
            skill
            for skill in plugin.get("skillMetadata", [])
            if isinstance(skill, dict) and skill.get("name") == "agentera"
        ),
        None,
    )
    if not isinstance(agentera, dict):
        return ["codex.agentera: missing aggregate bundled skill metadata"]

    if agentera.get("runtimeSupport") != "portable":
        errors.append("codex.agentera: runtimeSupport must stay portable")
    if agentera.get("policy", {}).get("allow_implicit_invocation") is not True:
        errors.append("codex.agentera: bundled skill must allow implicit invocation")
    invocation_hint = agentera.get("invocationHint")
    if not isinstance(invocation_hint, str) or "$agentera" not in invocation_hint:
        errors.append("codex.agentera: invocation hint must name $agentera")

    codex = plugin.get("codex")
    codex_text = " ".join(codex.get("limitations", [])) if isinstance(codex, dict) else ""
    for term in CODEX_AGENTERA_METADATA_TERMS:
        if term not in f"{invocation_hint or ''} {codex_text}":
            errors.append(f"codex.agentera: metadata must surface {term!r}")

    metadata_paths = [root / "agents/openai.yaml"]
    for path in metadata_paths:
        if not path.is_file():
            errors.append(f"codex.agentera: missing metadata surface {path.relative_to(root)}")
            continue
        text = path.read_text(encoding="utf-8")
        for term in CODEX_PROFILERA_TERMS:
            if term not in text:
                errors.append(f"codex.agentera: {path.relative_to(root)} missing {term!r}")
        if not any(f"status: {value}" in text for value in CODEX_PROFILERA_STATUS_VALUES):
            errors.append(
                f"codex.agentera: {path.relative_to(root)} missing status declaration "
                "(expected one of " + ", ".join(CODEX_PROFILERA_STATUS_VALUES) + ")"
            )
        if "collector exists" in text or "not implemented" in text:
            errors.append(f"codex.agentera: {path.relative_to(root)} contains stale missing-collector wording")

    return errors


def validate_opencode(root: Path) -> list[str]:
    errors: list[str] = []
    plugin_path = root / ".opencode/plugins/agentera.js"
    if not plugin_path.is_file():
        return ["opencode: missing .opencode/plugins/agentera.js"]

    text = plugin_path.read_text(encoding="utf-8")
    if "event: async" not in text:
        errors.append("opencode: session lifecycle must use the generic event hook")
    for event_type in OPENCODE_EVENT_TYPES:
        if f'event.type !== "{event_type}"' not in text and f'event.type === "{event_type}"' not in text:
            errors.append(f"opencode: event hook must handle or explicitly skip {event_type}")
        if f'"{event_type}":' in text:
            errors.append(f"opencode: must not register phantom direct hook {event_type}")
    for hook in ('"shell.env"', '"tool.execute.before"', '"tool.execute.after"'):
        if hook not in text:
            errors.append(f"opencode: missing {hook} hook")
    if "validateArtifactCandidate" not in text:
        errors.append("opencode: tool.execute.before must validate artifact candidates")

    return errors


def _normalized_doc_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("`", "")


def validate_hard_gate_docs(root: Path) -> list[str]:
    errors: list[str] = []
    for relative_path, runtime_requirements in HARD_GATE_DOC_REQUIREMENTS.items():
        path = root / relative_path
        if not path.is_file():
            errors.append(f"{relative_path}: missing hard-gate documentation surface")
            continue
        text = _normalized_doc_text(path)
        for runtime, terms in runtime_requirements.items():
            for term in terms:
                normalized_term = term.replace("`", "")
                if normalized_term not in text:
                    errors.append(
                        f"{relative_path}: {runtime} hard-gate docs must keep scoped claim term "
                        f"{term!r}"
                    )
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument(
        "--check-uv-runtime",
        action="store_true",
        help="also verify the uv executable is available for packaged script shebangs",
    )
    args = parser.parse_args(argv)

    root = args.root.resolve()
    errors: list[str] = []
    copilot = _load_json(root / "plugin.json")
    errors.extend(validate_copilot(copilot, root))
    errors.extend(validate_copilot_hooks(root, copilot))
    codex = _load_json(root / ".codex-plugin/plugin.json")
    errors.extend(validate_codex(codex))
    errors.extend(validate_codex_profilera_metadata(root, codex))
    errors.extend(validate_opencode(root))
    errors.extend(validate_suite_bundle_surface(root))
    errors.extend(validate_packaged_python_scripts(root))
    if args.check_uv_runtime:
        errors.extend(validate_uv_runtime())
    errors.extend(validate_hard_gate_docs(root))

    if errors:
        print("lifecycle adapter validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print("lifecycle adapter metadata ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
