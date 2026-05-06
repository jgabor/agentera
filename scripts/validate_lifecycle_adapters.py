#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
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
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from package_registry import PackageRegistry, load_registry as load_package_registry
from runtime_adapter_registry import RegistryError, RuntimeAdapterRegistry, load_registry

REGISTRY_CONTRACT_ERROR_PREFIX = "registry contract error"
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
PACKAGE_REGISTRY_PATH = ROOT / "references/adapters/package-registry.yaml"
UV_SCRIPT_SHEBANG = "#!/usr/bin/env -S uv run --script"
UV_INSTALL_GUIDANCE = (
    "uv is required to run packaged Agentera Python scripts; install it from "
    "https://docs.astral.sh/uv/getting-started/installation/ and then rerun the check"
)
HARD_GATE_DOC_REQUIREMENTS = {
    "references/adapters/runtime-feature-parity.md": ("opencode", "copilot"),
    "references/adapters/opencode.md": ("opencode",),
}


def _load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def _registry_contract_error(exc: Exception) -> str:
    return f"{REGISTRY_CONTRACT_ERROR_PREFIX}: {exc}"


def _runtime_view(registry: RuntimeAdapterRegistry, runtime: str) -> dict[str, Any]:
    return registry.consumer_view("lifecycle", runtime)


def _package_manifest(root: Path) -> PackageRegistry:
    registry_path = root / "references/adapters/package-registry.yaml"
    if registry_path.is_file():
        return load_package_registry(registry_path, root=root)
    return load_package_registry(PACKAGE_REGISTRY_PATH)


def _runtime_package_surfaces(registry: PackageRegistry) -> dict[str, str]:
    return registry.runtime_manifest_paths()


def _suite_bundle_required_paths(registry: PackageRegistry) -> dict[str, str]:
    return registry.shared_path_requirements()


def _supported_events(registry: RuntimeAdapterRegistry, runtime: str) -> set[str]:
    return set(_runtime_view(registry, runtime)["lifecycle_events"]["supported_events"])


def _unsupported_events(registry: RuntimeAdapterRegistry, runtime: str) -> set[str]:
    return set(_runtime_view(registry, runtime)["lifecycle_events"]["unsupported_events"])


def _validation_events(registry: RuntimeAdapterRegistry, runtime: str) -> list[str]:
    return _runtime_view(registry, runtime)["artifact_validation"]["validation_events"]


def _claim_terms(text: str, candidates: tuple[str, ...]) -> tuple[str, ...]:
    normalized = text.lower()
    return tuple(term for term in candidates if term.lower() in normalized)


def _copilot_profilera_terms(registry: RuntimeAdapterRegistry) -> tuple[str, ...]:
    view = _runtime_view(registry, "copilot")
    text = " ".join(view["lifecycle_events"]["limitations"] + view["documentation_claims"]["parity_claims"])
    return _claim_terms(text, ("profilera", "bounded", "corpus", "metadata", "missing source families"))


def _codex_lifecycle_status_values(registry: RuntimeAdapterRegistry) -> tuple[str, ...]:
    event_status = _runtime_view(registry, "codex")["lifecycle_events"]["event_status"]
    statuses = ["stable"]
    for event in _runtime_view(registry, "codex")["lifecycle_events"]["supported_events"]:
        status = event_status.get(event)
        if isinstance(status, str) and status != "unsupported" and status not in statuses:
            statuses.append(status)
    return tuple(statuses)


def _codex_limitation_terms(registry: RuntimeAdapterRegistry) -> tuple[str, ...]:
    view = _runtime_view(registry, "codex")
    text = " ".join(view["lifecycle_events"]["limitations"] + view["artifact_validation"]["hard_gate_claims"])
    return _claim_terms(text, ("codex_hooks", "apply_patch", "openai/codex#18391"))


def _hard_gate_doc_terms(registry: RuntimeAdapterRegistry, runtime: str, relative_path: str) -> list[str]:
    view = _runtime_view(registry, runtime)
    artifact = view["artifact_validation"]
    if relative_path == "references/adapters/opencode.md":
        primary = view["documentation_claims"]["parity_claims"]
    else:
        primary = artifact["hard_gate_claims"]
    return primary + artifact["payload_reconstruction_limitations"]


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


def _is_packaged_python_script(path: Path) -> bool:
    if not path.is_file():
        return False
    if path.suffix == ".py":
        return True
    if path.suffix:
        return False
    first_line = path.read_text(encoding="utf-8", errors="ignore").splitlines()[0:1]
    return bool(first_line) and (
        "python" in first_line[0] or "uv run --script" in first_line[0]
    )


def _packaged_python_scripts(root: Path) -> list[Path]:
    paths: list[Path] = []
    for directory in ("scripts", "hooks"):
        script_root = root / directory
        if not script_root.is_dir():
            continue
        paths.extend(
            path for path in script_root.iterdir()
            if _is_packaged_python_script(path)
        )
    return sorted(paths)


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


def _metadata_declares_requires_python(metadata: list[str]) -> bool:
    return any(line.strip().startswith("# requires-python = ") for line in metadata)


def _metadata_declares_dependencies(metadata: list[str]) -> bool:
    return any(line.strip().startswith("# dependencies = [") for line in metadata)


def validate_packaged_python_scripts(root: Path) -> list[str]:
    errors: list[str] = []
    for path in _packaged_python_scripts(root):
        relative = path.relative_to(root)
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        first_line = lines[0] if lines else ""
        if first_line != UV_SCRIPT_SHEBANG:
            errors.append(f"{relative}: packaged Python script must use uv script shebang")
        metadata = _extract_inline_script_metadata(text)
        if metadata is None:
            errors.append(f"{relative}: packaged Python script must declare inline script metadata")
            continue
        if not _metadata_declares_requires_python(metadata):
            errors.append(f"{relative}: packaged Python script must declare requires-python")
        if not _metadata_declares_dependencies(metadata):
            errors.append(f"{relative}: packaged Python script must declare dependencies")
    return errors


def validate_uv_runtime(path: str | None = None) -> list[str]:
    if shutil.which("uv", path=path) is None:
        return [UV_INSTALL_GUIDANCE]
    return []


def validate_suite_bundle_surface(
    root: Path,
    runtime_names: set[str] | None = None,
    package_registry: PackageRegistry | None = None,
) -> list[str]:
    """Validate aggregate runtime metadata for the shared bundle root.

    The ``agentera`` block is interpreted from each runtime manifest location:
    ``installRoot`` points back to the installed Agentera package root, and
    ``sharedPaths`` are resolved from that root.
    """
    errors: list[str] = []
    if package_registry is None:
        package_registry = _package_manifest(root)
    runtime_package_surfaces = _runtime_package_surfaces(package_registry)
    required_paths = _suite_bundle_required_paths(package_registry)
    package_shapes = package_registry.runtime_package_shapes()
    active = runtime_names if runtime_names is not None else set(runtime_package_surfaces)

    for runtime in sorted(active):
        relative_manifest = runtime_package_surfaces.get(runtime)
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
        expected_shape = package_shapes.get(runtime)
        if metadata.get("packageShape") != expected_shape:
            errors.append(f"{runtime}: agentera.packageShape must be {expected_shape}")

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
        for path, expected_kind in required_paths.items():
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


def validate_copilot(
    plugin: dict[str, Any],
    plugin_root: Path,
    registry: RuntimeAdapterRegistry | None = None,
) -> list[str]:
    if registry is None:
        registry = load_registry()
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
    profilera_terms = _copilot_profilera_terms(registry)
    if not isinstance(description, str) or any(term not in description for term in profilera_terms):
        errors.append("copilot.profilera: description must expose bounded corpus metadata limits")

    return errors


def validate_copilot_hooks(
    plugin_root: Path,
    plugin: dict[str, Any],
    registry: RuntimeAdapterRegistry | None = None,
) -> list[str]:
    if registry is None:
        registry = load_registry()
    errors: list[str] = []
    copilot_events = _supported_events(registry, "copilot")
    required_prewrite_hook = next(iter(_validation_events(registry, "copilot")), "")
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
            if path.stem not in copilot_events:
                errors.append(f"copilot: unsupported lifecycle hook file configured: {path.name}")
            if not isinstance(event, str):
                errors.append(f"copilot.{path.name}: hook name must be a string")
                continue
            if event not in copilot_events:
                errors.append(f"copilot: unsupported lifecycle event configured: {event}")
                continue
            if path.stem != event:
                errors.append(f"copilot.{path.name}: hook filename must match event name {event}")
            if event != event[:1].lower() + event[1:]:
                errors.append(f"copilot: event must be lower-camel: {event}")
            _validate_command_handler(errors, "copilot", event, 0, hook)
            seen_events.add(event)
            if event == required_prewrite_hook:
                command_text = _handler_command_text(hook)
                if "hooks/validate_artifact.py" not in command_text:
                    errors.append(
                        "copilot.preToolUse: artifact hard gate must run hooks/validate_artifact.py"
                    )

        if required_prewrite_hook not in seen_events:
            errors.append("copilot: missing required preToolUse artifact validation hook")

    return errors


def validate_codex(
    plugin: dict[str, Any],
    registry: RuntimeAdapterRegistry | None = None,
) -> list[str]:
    if registry is None:
        registry = load_registry()
    errors: list[str] = []
    codex_events = _supported_events(registry, "codex")
    unsupported_codex_events = _unsupported_events(registry, "codex")
    lifecycle_status_values = _codex_lifecycle_status_values(registry)
    limitation_terms = _codex_limitation_terms(registry)
    lifecycle = plugin.get("lifecycleHooks")
    if not isinstance(lifecycle, dict):
        return ["codex: missing lifecycleHooks limitation metadata"]

    if lifecycle.get("configured") is not False:
        errors.append("codex: lifecycleHooks.configured must be false")
    if lifecycle.get("status") not in lifecycle_status_values:
        errors.append(
            "codex: lifecycleHooks.status must be one of "
            + ", ".join(lifecycle_status_values)
        )

    events = lifecycle.get("events", {})
    if not isinstance(events, dict):
        errors.append("codex: lifecycleHooks.events must be an object when present")
    else:
        for event in events:
            if event not in codex_events:
                errors.append(f"codex: unsupported lifecycle event configured: {event}")

    supported = lifecycle.get("supportedEvents")
    if not isinstance(supported, list) or set(supported) != codex_events:
        errors.append(
            "codex: supportedEvents must list every Codex codex_hooks event "
            "(" + ", ".join(_runtime_view(registry, "codex")["lifecycle_events"]["supported_events"]) + ")"
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
            if event in codex_events:
                errors.append(
                    f"codex: unsupportedEvents must not list event {event!r} that codex_hooks now supports"
                )
            elif event not in unsupported_codex_events:
                errors.append(f"codex: unsupportedEvents entry {event!r} is not claimed by the registry")

    limitations = lifecycle.get("limitations")
    if not isinstance(limitations, list) or not limitations:
        errors.append("codex: limitations must document codex_hooks status and apply_patch interception")
    else:
        joined = " ".join(item for item in limitations if isinstance(item, str))
        for term in limitation_terms:
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
        if "path: ./skills/agentera" not in text:
            errors.append(
                f"codex.agentera: {path.relative_to(root)} must point at bundled skills/agentera"
            )
        for stale_path in ("path: ./skills/hej", "metadata: ./skills/hej", "skills/<name>/agents"):
            if stale_path in text:
                errors.append(
                    f"codex.agentera: {path.relative_to(root)} carries stale v1 skill path {stale_path!r}"
                )
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


def validate_opencode(
    root: Path,
    registry: RuntimeAdapterRegistry | None = None,
) -> list[str]:
    if registry is None:
        registry = load_registry()
    errors: list[str] = []
    plugin_path = root / ".opencode/plugins/agentera.js"
    if not plugin_path.is_file():
        return ["opencode: missing .opencode/plugins/agentera.js"]

    text = plugin_path.read_text(encoding="utf-8")
    if "event: async" not in text:
        errors.append("opencode: session lifecycle must use the generic event hook")
    for event_type in _unsupported_events(registry, "opencode"):
        if f'event.type !== "{event_type}"' not in text and f'event.type === "{event_type}"' not in text:
            errors.append(f"opencode: event hook must handle or explicitly skip {event_type}")
        if f'"{event_type}":' in text:
            errors.append(f"opencode: must not register phantom direct hook {event_type}")
    for hook in (f'"{event}"' for event in _supported_events(registry, "opencode")):
        if hook not in text:
            errors.append(f"opencode: missing {hook} hook")
    if "validateArtifactCandidate" not in text:
        errors.append("opencode: tool.execute.before must validate artifact candidates")

    return errors


def _normalized_doc_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("`", "")


def validate_hard_gate_docs(
    root: Path,
    registry: RuntimeAdapterRegistry | None = None,
) -> list[str]:
    if registry is None:
        registry = load_registry()
    errors: list[str] = []
    for relative_path, runtimes in HARD_GATE_DOC_REQUIREMENTS.items():
        path = root / relative_path
        if not path.is_file():
            errors.append(f"{relative_path}: missing hard-gate documentation surface")
            continue
        text = _normalized_doc_text(path)
        for runtime in runtimes:
            display_name = _runtime_view(registry, runtime)["identity"]["display_name"].removesuffix(" CLI")
            for term in _hard_gate_doc_terms(registry, runtime, relative_path):
                normalized_term = term.replace("`", "").rstrip(".")
                if normalized_term not in text:
                    errors.append(
                        f"{relative_path}: {display_name} hard-gate docs must keep scoped claim term "
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
    try:
        registry = load_registry(root / "references/adapters/runtime-adapter-registry.yaml")
    except (OSError, RegistryError) as exc:
        errors.append(_registry_contract_error(exc))

    if errors:
        print("lifecycle adapter validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    copilot = _load_json(root / "plugin.json")
    errors.extend(validate_copilot(copilot, root, registry))
    errors.extend(validate_copilot_hooks(root, copilot, registry))
    codex = _load_json(root / ".codex-plugin/plugin.json")
    errors.extend(validate_codex(codex, registry))
    errors.extend(validate_codex_profilera_metadata(root, codex))
    errors.extend(validate_opencode(root, registry))
    package_manifest = _package_manifest(root)
    errors.extend(validate_suite_bundle_surface(root, package_registry=package_manifest))
    errors.extend(validate_packaged_python_scripts(root))
    if args.check_uv_runtime:
        errors.extend(validate_uv_runtime())
    errors.extend(validate_hard_gate_docs(root, registry))

    if errors:
        print("lifecycle adapter validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print("lifecycle adapter metadata ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
