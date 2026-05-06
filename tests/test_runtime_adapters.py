"""Tests for public runtime adapter metadata.

Proportionality: one pass and one fail per runtime/package or hook unit.
Extra assertions inside a unit are branch-justified by public compatibility
surfaces: skill inventory, paths, invocation policy, and runtime limitations.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import tomllib
from pathlib import Path
from types import ModuleType
from typing import Any

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    assert isinstance(data, dict)
    return data


def _load_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_package_registry_module() -> ModuleType:
    return _load_module("package_registry", REPO_ROOT / "scripts/package_registry.py")


def _package_manifest(root: Path = REPO_ROOT, fixture: dict[str, Any] | None = None) -> Any:
    registry_module = _load_package_registry_module()
    if fixture is not None:
        return registry_module.PackageRegistry(tuple(fixture["records"]), root=root)
    registry_path = REPO_ROOT / "references/adapters/package-registry.yaml"
    if root == REPO_ROOT:
        return registry_module.load_registry(registry_path, root=root)
    fixture = yaml.safe_load(registry_path.read_text(encoding="utf-8"))
    return registry_module.PackageRegistry(tuple(fixture["records"]), root=root)


def _skill_names(root: Path = REPO_ROOT) -> list[str]:
    return sorted(path.name for path in (root / "skills").iterdir() if (path / "SKILL.md").is_file())


def _resolve_inside(root: Path, path: str) -> Path | None:
    resolved = (root / path).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        return None
    return resolved


def _validate_copilot_package(plugin: dict[str, Any], plugin_root: Path = REPO_ROOT) -> list[str]:
    errors: list[str] = []
    skills = plugin.get("skills")
    if isinstance(skills, str):
        skill_paths = [skills]
    elif isinstance(skills, list) and all(isinstance(path, str) for path in skills):
        skill_paths = skills
    else:
        return ["copilot.skills must be a string or string array path"]

    found: list[str] = []
    for path in skill_paths:
        skill_root = _resolve_inside(plugin_root, path)
        if skill_root is None:
            errors.append("copilot.skills paths must stay inside plugin root")
            continue
        found.extend(child.name for child in skill_root.iterdir() if (child / "SKILL.md").is_file())

    if sorted(found) != _skill_names():
        errors.append("copilot.skills path must expose skills/*/SKILL.md")

    hooks = plugin.get("hooks")
    if not isinstance(hooks, str | list):
        errors.append("copilot.hooks must be a string or string array path")
    else:
        hook_paths = [hooks] if isinstance(hooks, str) else hooks
        for path in hook_paths:
            if not isinstance(path, str) or _resolve_inside(plugin_root, path) is None:
                errors.append("copilot.hooks paths must stay inside plugin root")

    if "lifecycleHooks" in plugin:
        errors.append("copilot: use supported hooks component field, not lifecycleHooks")

    return errors


def _validate_codex_package(plugin: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if plugin.get("skills") != "./skills/":
        errors.append("codex.skills must point to ./skills/")

    interface = plugin.get("interface")
    if not isinstance(interface, dict):
        errors.append("codex.interface metadata must be an object")
    else:
        for key in ("displayName", "shortDescription", "longDescription", "developerName", "category"):
            if not isinstance(interface.get(key), str) or not interface[key]:
                errors.append(f"codex.interface.{key} must be present")

    codex = plugin.get("codex")
    if not isinstance(codex, dict):
        errors.append("codex metadata must be an object")
    else:
        ui_metadata = codex.get("uiMetadata")
        if not isinstance(ui_metadata, str):
            errors.append("codex.uiMetadata must be a root-relative path")
        elif not (REPO_ROOT / ui_metadata / "").resolve().is_file():
            errors.append("codex.uiMetadata must resolve from the plugin install root")

    metadata = plugin.get("skillMetadata")
    if not isinstance(metadata, list):
        return errors + ["codex.skillMetadata must be a list"]

    expected = _skill_names()
    actual = sorted(skill.get("name") for skill in metadata if isinstance(skill, dict))
    if actual != expected:
        errors.append("codex.skillMetadata must match skills/*/SKILL.md")

    for skill in metadata:
        if not isinstance(skill, dict):
            errors.append("codex skill entry must be an object")
            continue
        name = skill.get("name")
        path = skill.get("path")
        policy = skill.get("policy")
        if not isinstance(name, str) or not isinstance(path, str) or not isinstance(policy, dict):
            errors.append("codex skill entry must include name, path, and policy")
            continue
        if not (REPO_ROOT / path / "SKILL.md").resolve().is_file():
            errors.append(f"codex.{name}: path must resolve to SKILL.md")
        if skill.get("runtimeSupport") != "portable":
            errors.append(f"codex.{name}: runtimeSupport must be portable")
        if not policy.get("allow_implicit_invocation"):
            errors.append(f"codex.{name}: implicit invocation policy must allow implicit")
        if skill.get("invocationHint") and f"${name}" not in skill["invocationHint"]:
            errors.append(f"codex.{name}: invocation hint must name ${name}")

    if isinstance(codex, dict) and isinstance(codex.get("uiMetadata"), str):
        errors.extend(_validate_codex_ui_metadata(REPO_ROOT / codex["uiMetadata"]))

    return errors


def _validate_codex_marketplace(root: Path = REPO_ROOT) -> list[str]:
    errors: list[str] = []
    marketplace = _load_json(root / ".agents/plugins/marketplace.json")
    plugins = marketplace.get("plugins")
    if not isinstance(plugins, list):
        return ["codex marketplace plugins must be a list"]

    if [plugin.get("name") for plugin in plugins if isinstance(plugin, dict)] != ["agentera"]:
        errors.append("codex marketplace must expose the aggregate agentera plugin")

    for plugin in plugins:
        if not isinstance(plugin, dict):
            errors.append("codex marketplace plugin entries must be objects")
            continue
        source = plugin.get("source")
        if not isinstance(source, dict) or source.get("source") != "local":
            errors.append("codex marketplace agentera source must be local")
            continue
        path = source.get("path")
        if not isinstance(path, str):
            errors.append("codex marketplace agentera source path must be a string")
            continue
        plugin_root = _resolve_inside(root, path)
        if plugin_root is None:
            errors.append("codex marketplace agentera path must stay inside repo root")
            continue
        manifest = plugin_root / ".codex-plugin/plugin.json"
        if not manifest.is_file():
            errors.append("codex marketplace agentera path must resolve to a plugin root")
        else:
            manifest_json = _load_json(manifest)
            if manifest_json.get("name") != plugin.get("name"):
                errors.append("codex marketplace agentera name must match plugin manifest")
        if (plugin_root / "SKILL.md").is_file():
            errors.append("codex marketplace must not point directly at a skill directory")

    return errors


def _validate_codex_ui_metadata(path: Path) -> list[str]:
    errors: list[str] = []
    text = path.read_text(encoding="utf-8")

    if "path: ./skills/agentera" not in text:
        errors.append("codex.ui: metadata must point at bundled skills/agentera")
    for stale_path in ("path: ./skills/hej", "metadata: ./skills/hej", "skills/<name>/agents"):
        if stale_path in text:
            errors.append(f"codex.ui: stale v1 skill path {stale_path!r}")
    if "allow_implicit_invocation: false" not in text:
        errors.append("codex.ui.profilera: implicit invocation must be disabled")
    if "codex_session_corpus" not in text:
        errors.append("codex.ui.profilera: missing actionable corpus capability")
    if not any(f"status: {value}" in text for value in ("ok", "degraded")):
        errors.append("codex.ui.profilera: corpus capability status must be ok or degraded")
    if "collector exists" in text or "not implemented" in text:
        errors.append("codex.ui.profilera: stale missing-collector limitation")

    return errors


def _validate_claude_package(root: Path = REPO_ROOT) -> list[str]:
    errors: list[str] = []
    package_manifest = _package_manifest(root)
    manifest_path = package_manifest.runtime_manifest_paths()["claude"]
    marketplace = _load_json(root / manifest_path)
    plugins = marketplace.get("plugins")
    if not isinstance(plugins, list):
        return ["claude marketplace plugins must be a list"]

    expected = _skill_names(root)
    actual = sorted(plugin.get("name") for plugin in plugins if isinstance(plugin, dict))
    if actual != expected:
        errors.append("claude marketplace plugins must match skills/*/SKILL.md")

    for name in expected:
        plugin_path = root / "skills" / name / ".claude-plugin/plugin.json"
        if not plugin_path.is_file():
            errors.append(f"claude.{name}: missing bundled plugin.json")
            continue
        plugin = _load_json(plugin_path)
        if plugin.get("name") != name:
            errors.append(f"claude.{name}: plugin name must match skill directory")
        for key in ("version", "description", "author"):
            if key not in plugin:
                errors.append(f"claude.{name}: missing {key}")

    return errors


def _validate_opencode_package(root: Path = REPO_ROOT, package_manifest: Any | None = None) -> list[str]:
    errors: list[str] = []
    if package_manifest is None:
        package_manifest = _package_manifest(root)
    manifest_path = package_manifest.runtime_manifest_paths()["opencode"]
    package = _load_json(root / manifest_path)
    if package.get("type") != "module":
        errors.append("opencode package must stay ESM")

    plugin_text = (root / ".opencode/plugins/agentera.js").read_text(encoding="utf-8")
    errors.extend(_validate_opencode_version(root, plugin_text))
    expected = _skill_names(root)
    command_names = sorted(re.findall(r'^  "([a-z]+)": `', plugin_text, flags=re.MULTILINE))
    if command_names != expected:
        errors.append("opencode command templates must match skills/*/SKILL.md")

    for hook in ('event:', '"shell.env"', '"tool.execute.before"', '"tool.execute.after"'):
        if hook not in plugin_text:
            errors.append(f"opencode plugin missing {hook} hook")
    for phantom in ('"session.created":', '"session.idle":'):
        if phantom in plugin_text:
            errors.append(f"opencode plugin must not register phantom hook {phantom}")

    for name in expected:
        template_match = re.search(
            rf'^  "{re.escape(name)}": `(.+?)`',
            plugin_text,
            flags=re.MULTILINE | re.DOTALL,
        )
        if not template_match:
            errors.append(f"opencode.{name}: missing command template")
            continue
        template = template_match.group(1)
        if "agentera_managed: true" not in template:
            errors.append(f"opencode.{name}: command template must keep managed marker")

    return errors


_AGENTERA_VERSION_RE = re.compile(r'AGENTERA_VERSION\s*=\s*"([^"]+)"')


def _read_opencode_agentera_version(plugin_text: str) -> str:
    """Extract the current AGENTERA_VERSION literal from agentera.js source.

    Centralizes version discovery so drift fixtures stay in sync with the live
    suite version automatically. Matches `export const AGENTERA_VERSION = "X"`.
    """
    match = _AGENTERA_VERSION_RE.search(plugin_text)
    if match is None:
        raise AssertionError("opencode plugin source missing AGENTERA_VERSION literal")
    return match.group(1)


def _validate_opencode_version(root: Path, plugin_text: str) -> list[str]:
    errors: list[str] = []
    package_manifest = _package_manifest(root)
    try:
        suite_version = package_manifest.suite_version()
    except Exception:
        errors.append("opencode registry comparison needs one suite version")
        return errors
    marker_surfaces = [
        surface
        for surface in package_manifest.consumer_view("validator")["version_surfaces"]["surfaces"]
        if surface["selector"] == "AGENTERA_VERSION"
    ]
    if not marker_surfaces:
        errors.append("opencode registry comparison needs one suite version")
    elif f'AGENTERA_VERSION = "{suite_version}"' not in plugin_text:
        errors.append("opencode AGENTERA_VERSION must match registry suite version")

    return errors


def _validate_package_versions(root: Path = REPO_ROOT, package_manifest: Any | None = None) -> list[str]:
    errors: list[str] = []
    if package_manifest is None:
        package_manifest = _package_manifest(root)
    try:
        suite_version = package_manifest.suite_version()
    except Exception:
        return ["registry skill versions must share one suite version"]

    for label, version in _version_surface_values(root, package_manifest).items():
        if version != suite_version:
            errors.append(f"{label} version must match registry suite version {suite_version}")

    return errors


def _version_surface_values(root: Path, package_manifest: Any) -> dict[str, Any]:
    surfaces: dict[str, Any] = {}
    for surface in package_manifest.consumer_view("validator")["version_surfaces"]["surfaces"]:
        path = surface["path"]
        selector = surface["selector"]
        if selector == "skills[0].version":
            continue
        if selector == "project.version":
            version = tomllib.loads((root / path).read_text(encoding="utf-8")).get("project", {}).get("version")
            label = path
        elif selector == "AGENTERA_VERSION":
            version = _read_opencode_agentera_version((root / path).read_text(encoding="utf-8"))
            label = path
        else:
            data = _load_json(root / path)
            if selector == "version":
                version = data.get("version")
                label = path
            elif selector == "metadata.version":
                version = data.get("metadata", {}).get("version")
                label = f"{path} metadata"
            elif selector == "plugins[*].version":
                for plugin in data.get("plugins", []):
                    if isinstance(plugin, dict):
                        surfaces[f"{path} plugin {plugin.get('name')}"] = plugin.get("version")
                continue
            else:
                raise AssertionError(f"unsupported PackageManifest version selector {selector!r}")
        surfaces[label] = version
    return surfaces


def _validate_registry(root: Path = REPO_ROOT) -> list[str]:
    errors: list[str] = []
    package_manifest = _package_manifest(root)
    identity = package_manifest.get("agentera")["identity"]
    registry = _load_json(root / "registry.json")
    skills = registry.get("skills")
    if not isinstance(skills, list):
        return ["registry skills must be a list"]
    if len(skills) != 1:
        errors.append("registry must have exactly one skill entry")
    else:
        skill = skills[0]
        if not isinstance(skill, dict):
            errors.append("registry skill entry must be an object")
        else:
            if skill.get("name") != identity["name"]:
                errors.append(f"registry skill name must be {identity['name']}")
            if not isinstance(skill.get("version"), str):
                errors.append("registry skill must have a version string")
            capabilities = skill.get("capabilities")
            if not isinstance(capabilities, list) or len(capabilities) != identity["expected_capabilities"]:
                errors.append(f"registry skill must list {identity['expected_capabilities']} capabilities")
            elif sorted(capabilities) != sorted(capabilities):
                errors.append("registry capabilities must be unique")
    return errors


def _validate_opencode_install_root(plugin_text: str, root: Path = REPO_ROOT) -> list[str]:
    errors: list[str] = []
    model = yaml.safe_load((root / ".agentera/install_root_interface_model.yaml").read_text(encoding="utf-8"))
    source_labels = {entry["source"]: entry["label"] for entry in model["source_precedence"]}

    if "process.env.AGENTERA_HOME" not in plugin_text or source_labels["environment"] not in plugin_text:
        errors.append("opencode install-root resolver must honor AGENTERA_HOME from the shared contract")
    if 'path.join(process.env.HOME, ".agents", "agentera")' not in plugin_text:
        errors.append("opencode validation must resolve documented default durable root")
    if source_labels["default"] not in plugin_text or "scripts/install_root.py" not in plugin_text:
        errors.append("opencode install-root resolver must point maintainers at the shared install-root Module")
    if 'path.join(process.env.HOME, ".agents", "skills", "agentera")' in plugin_text:
        if "temporary OpenCode-only" not in plugin_text or "compatibility exception" not in plugin_text:
            errors.append("opencode legacy skills-root fallback must be documented as an adapter-local exception")
    return errors


def _validate_opencode_reference(text: str) -> list[str]:
    errors: list[str] = []
    install_command = "npx skills add jgabor/agentera -g -a opencode --skill agentera -y"
    if install_command not in text:
        errors.append("OpenCode reference must document single /agentera install command")
    if "temporary `skills/hej/` entry point is a v1 upgrade bridge" not in text:
        errors.append("OpenCode reference must mark /hej as upgrade bridge only")
    if "scripts/install_root.py" not in text:
        errors.append("OpenCode reference must point install-root semantics at the shared Module")
    if "references/adapters/runtime-adapter-registry.yaml" not in text or "scripts/runtime_adapter_registry.py" not in text:
        errors.append("OpenCode reference must point runtime facts at the RuntimeAdapter registry")
    if "package metadata consolidation work" in text and "outside" not in text:
        errors.append("OpenCode install-root reference must keep package metadata registry work outside")
    for stale in (
        "OpenCode discovers all 12 skills",
        "skills/realisera",
        "skills/inspektera",
        "for skill in ~/git/agentera/skills/*/",
        "for skill in /path/to/agentera/skills/*/",
    ):
        if stale in text:
            errors.append("OpenCode reference must not document v1 multi-skill manual install")
    return errors


def _validate_install_root_documentation(root: Path = REPO_ROOT) -> list[str]:
    errors: list[str] = []
    surfaces = {
        "README.md": root / "README.md",
        "UPGRADE.md": root / "UPGRADE.md",
        "skills/agentera/SKILL.md": root / "skills/agentera/SKILL.md",
        "skills/agentera/capabilities/hej/prose.md": root / "skills/agentera/capabilities/hej/prose.md",
        ".agentera/docs.yaml": root / ".agentera/docs.yaml",
        "TODO.md": root / "TODO.md",
        "runtime-feature-parity.md": root / "references/adapters/runtime-feature-parity.md",
    }
    for label, path in surfaces.items():
        text = path.read_text(encoding="utf-8")
        if "scripts/install_root.py" not in text:
            errors.append(f"{label} must point install-root semantics at scripts/install_root.py")

    docs_text = "\n".join(path.read_text(encoding="utf-8") for path in surfaces.values())
    for term in ("AGENTERA_HOME", "default durable root", "managed", "stale", "unmanaged"):
        if term not in docs_text:
            errors.append(f"install-root docs must preserve shared contract term {term!r}")
    if "references/adapters/runtime-adapter-registry.yaml" not in docs_text:
        errors.append("install-root docs must point runtime facts at the RuntimeAdapter registry")
    if "package metadata registry work stays outside" not in docs_text:
        errors.append("install-root docs must keep package metadata registry work outside the install-root Module")
    return errors


def _load_runtime_adapter_interface_model(root: Path = REPO_ROOT) -> dict[str, Any]:
    model = yaml.safe_load(
        (root / "references/adapters/runtime-adapter-interface-model.yaml").read_text(encoding="utf-8")
    )
    assert isinstance(model, dict)
    return model


def _load_package_manifest_interface_model(root: Path = REPO_ROOT) -> dict[str, Any]:
    model = yaml.safe_load(
        (root / "references/adapters/package-manifest-interface-model.yaml").read_text(encoding="utf-8")
    )
    assert isinstance(model, dict)
    return model


def _validate_runtime_adapter_interface_model(root: Path = REPO_ROOT) -> list[str]:
    errors: list[str] = []
    model = _load_runtime_adapter_interface_model(root)
    record = model.get("record")
    if not isinstance(record, dict):
        return ["RuntimeAdapter model must define a record object"]

    required_groups = record.get("required_groups")
    groups = record.get("groups")
    expected_groups = {
        "identity",
        "host_detection",
        "lifecycle_events",
        "artifact_validation",
        "config_targets",
        "diagnostics",
        "documentation_claims",
    }
    if set(required_groups or []) != expected_groups:
        errors.append("RuntimeAdapter record must require only the approved typed groups")
    if not isinstance(groups, dict):
        errors.append("RuntimeAdapter record groups must be typed objects")
    else:
        for group in expected_groups:
            spec = groups.get(group)
            if not isinstance(spec, dict):
                errors.append(f"RuntimeAdapter group {group} must be defined")
                continue
            if spec.get("type") != "object":
                errors.append(f"RuntimeAdapter group {group} must be typed as object")
            if not isinstance(spec.get("owns"), list) or not spec["owns"]:
                errors.append(f"RuntimeAdapter group {group} must list owned facts")
            if not isinstance(spec.get("required_fields"), dict) or not spec["required_fields"]:
                errors.append(f"RuntimeAdapter group {group} must list required typed fields")

    ownership = model.get("ownership")
    if not isinstance(ownership, dict):
        return errors + ["RuntimeAdapter model must define ownership boundaries"]
    package = ownership.get("package_metadata_out_of_scope")
    if not isinstance(package, dict) or package.get("owner") != "package_manifest_registry":
        errors.append("RuntimeAdapter package metadata facts must stay with package_manifest_registry")
    else:
        for fact in ("version_authority", "package_manifest_schemas", "shared_package_paths", "release_metadata"):
            if fact not in package.get("facts", []):
                errors.append(f"RuntimeAdapter must exclude package metadata fact {fact}")

    install_root = ownership.get("install_root_out_of_scope")
    if not isinstance(install_root, dict) or install_root.get("owner") != "scripts/install_root.py":
        errors.append("RuntimeAdapter install-root facts must stay delegated to scripts/install_root.py")
    else:
        for fact in (
            "AGENTERA_HOME precedence",
            "default durable root",
            "managed classification",
            "stale classification",
            "unmanaged classification",
            "root diagnostics",
        ):
            if fact not in install_root.get("facts", []):
                errors.append(f"RuntimeAdapter must delegate install-root fact {fact}")

    permissions = model.get("consumer_permissions")
    if not isinstance(permissions, dict):
        errors.append("RuntimeAdapter model must define consumer permissions")
    else:
        for consumer in ("lifecycle_validation", "doctor", "upgrade", "docs", "tests"):
            spec = permissions.get(consumer)
            if not isinstance(spec, dict):
                errors.append(f"RuntimeAdapter consumer {consumer} must be explicit")
                continue
            allowed = spec.get("allowed_groups")
            if not isinstance(allowed, list) or not allowed:
                errors.append(f"RuntimeAdapter consumer {consumer} must list allowed groups")
            elif not set(allowed).issubset(expected_groups):
                errors.append(f"RuntimeAdapter consumer {consumer} may only read approved groups")
            if spec.get("forbidden_ownership") != ["package_metadata_out_of_scope", "install_root_out_of_scope"]:
                errors.append(f"RuntimeAdapter consumer {consumer} must forbid external ownership domains")

    return errors


def _validate_package_manifest_interface_model(root: Path = REPO_ROOT) -> list[str]:
    errors: list[str] = []
    model = _load_package_manifest_interface_model(root)
    record = model.get("record")
    if not isinstance(record, dict):
        return ["PackageManifest model must define a record object"]

    expected_groups = {
        "identity",
        "version_authority",
        "version_surfaces",
        "runtime_package_manifests",
        "bundle_surfaces",
        "package_commands",
        "docs_targets",
        "release_policy",
    }
    if set(record.get("required_groups") or []) != expected_groups:
        errors.append("PackageManifest record must require only the approved typed groups")
    groups = record.get("groups")
    if not isinstance(groups, dict):
        errors.append("PackageManifest record groups must be typed objects")
    else:
        for group in expected_groups:
            spec = groups.get(group)
            if not isinstance(spec, dict):
                errors.append(f"PackageManifest group {group} must be defined")
                continue
            if spec.get("type") != "object":
                errors.append(f"PackageManifest group {group} must be typed as object")
            if not isinstance(spec.get("owns"), list) or not spec["owns"]:
                errors.append(f"PackageManifest group {group} must list owned facts")
            if not isinstance(spec.get("required_fields"), dict) or not spec["required_fields"]:
                errors.append(f"PackageManifest group {group} must list required typed fields")

    ownership = model.get("ownership")
    if not isinstance(ownership, dict):
        errors.append("PackageManifest model must define ownership boundaries")
    else:
        registry = ownership.get("registry_json_version_authority")
        if not isinstance(registry, dict):
            errors.append("PackageManifest must define registry.json version authority")
        else:
            if registry.get("owner") != "registry.json" or registry.get("persisted_authority") is not True:
                errors.append("registry.json must remain the persisted suite-version authority")
            if registry.get("access_interface") != "PackageManifest":
                errors.append("PackageManifest must be the suite-version access Interface")
            if registry.get("future_authority_change_requires") != "explicit ADR":
                errors.append("registry.json authority changes must require an explicit ADR")

        install_root = ownership.get("install_root_delegated")
        if not isinstance(install_root, dict) or install_root.get("owner") != "scripts/install_root.py":
            errors.append("PackageManifest install-root facts must stay delegated to scripts/install_root.py")
        else:
            for fact in ("AGENTERA_HOME precedence", "default durable root", "managed classification"):
                if fact not in install_root.get("forbidden_in_package_manifest", []):
                    errors.append(f"PackageManifest must forbid install-root fact {fact}")

        runtime = ownership.get("runtime_adapter_delegated")
        if not isinstance(runtime, dict) or runtime.get("owner") != "scripts/runtime_adapter_registry.py":
            errors.append(
                "PackageManifest RuntimeAdapter facts must stay delegated to scripts/runtime_adapter_registry.py"
            )
        else:
            for fact in ("lifecycle events", "artifact validation hooks", "runtime diagnostics"):
                if fact not in runtime.get("forbidden_in_package_manifest", []):
                    errors.append(f"PackageManifest must forbid RuntimeAdapter fact {fact}")

    manifest = model.get("sample_manifest")
    if not isinstance(manifest, dict):
        return errors + ["PackageManifest model must include a sample manifest fixture"]
    if set(manifest) != expected_groups:
        errors.append("PackageManifest sample manifest must instantiate every typed group")

    version_authority = manifest.get("version_authority", {})
    if version_authority.get("persisted_authority") != "registry.json":
        errors.append("PackageManifest fixture must keep registry.json as version authority")
    if version_authority.get("access_interface") != "PackageManifest":
        errors.append("PackageManifest fixture must expose PackageManifest as access Interface")

    runtime_manifests = manifest.get("runtime_package_manifests", {}).get("manifests")
    if not isinstance(runtime_manifests, list):
        errors.append("PackageManifest fixture must list runtime package manifests")
    else:
        opencode_package = [entry for entry in runtime_manifests if entry.get("path") == ".opencode/package.json"]
        if not opencode_package or opencode_package[0].get("version_bearing") is not False:
            errors.append("OpenCode package.json must be a non-version-bearing runtime package manifest")

    errors.extend(_validate_package_manifest_command_safety(model))
    return errors


def _validate_package_manifest_command_safety(model: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    safety = model.get("command_safety")
    manifest = model.get("sample_manifest") if isinstance(model.get("sample_manifest"), dict) else {}
    package_commands = manifest.get("package_commands", {}) if isinstance(manifest, dict) else {}
    commands = package_commands.get("commands")
    if not isinstance(safety, dict) or not isinstance(commands, list):
        return ["PackageManifest command safety must define command specs"]

    approved_executables = set(safety.get("approved_executables") or [])
    approved_actions = set(safety.get("approved_actions") or [])
    approved_runtimes = set(safety.get("approved_runtimes") or [])
    approved_agents = set(safety.get("approved_runtime_agents") or [])
    cleanup_actions = set(safety.get("cleanup_actions") or [])
    runtime_install_actions = set(safety.get("runtime_install_actions") or [])

    if safety.get("argv_only") is not True:
        errors.append("PackageManifest package-manager commands must be argv-list only")
    gates = safety.get("gates")
    if not isinstance(gates, dict) or gates.get("update_packages_required_to_plan") is not True:
        errors.append("PackageManifest package commands must preserve --update-packages planning gate")
    if not isinstance(gates, dict) or gates.get("yes_required_to_execute") is not True:
        errors.append("PackageManifest package commands must preserve --yes execution gate")
    if not isinstance(gates, dict) or gates.get("preserve_existing_write_gates") is not True:
        errors.append("PackageManifest package commands must preserve existing write gates")

    for command in commands:
        if not isinstance(command, dict):
            errors.append("PackageManifest command specs must be objects")
            continue
        runtime = command.get("runtime")
        action = command.get("action")
        argv = command.get("argv")
        phase = command.get("phase")
        if runtime not in approved_runtimes:
            errors.append(f"PackageManifest command runtime {runtime!r} is not approved")
        if action not in approved_actions:
            errors.append(f"PackageManifest command action {action!r} is not approved")
        if not isinstance(argv, list) or not argv or not all(isinstance(part, str) for part in argv):
            errors.append(f"PackageManifest command {action!r} must use list argv")
            continue
        if argv[0] not in approved_executables:
            errors.append(f"PackageManifest command {action!r} uses unapproved executable {argv[0]!r}")
        if len(argv) < 3 or argv[1] != "skills" or argv[2] not in {"remove", "add"}:
            errors.append(f"PackageManifest command {action!r} must use approved skills action")
        if action in cleanup_actions and (runtime != "all" or phase != "cleanup" or argv[2] != "remove"):
            errors.append("PackageManifest cleanup commands must stay separate from runtime installs")
        if action in runtime_install_actions:
            if runtime == "all" or phase != "runtime-install" or argv[2] != "add":
                errors.append("PackageManifest runtime install commands must stay out of cleanup")
            if "-a" not in argv:
                errors.append("PackageManifest runtime install commands must declare runtime agent")
            else:
                agent = argv[argv.index("-a") + 1]
                if agent not in approved_agents:
                    errors.append(f"PackageManifest runtime install agent {agent!r} is not approved")
    return errors


def _validate_docs_version_targets(root: Path) -> list[str]:
    package_manifest = _package_manifest(root)
    version_files = package_manifest.consumer_view("validator")["version_surfaces"]["surfaces"]
    marker_paths = [surface["path"] for surface in version_files if surface["selector"] == "AGENTERA_VERSION"]
    docs = (root / ".agentera/docs.yaml").read_text(encoding="utf-8")
    for marker_path in marker_paths:
        if marker_path not in docs:
            return ["DOCS version_files must include OpenCode version marker"]
    return []


def _validate_package_surface_characterization(root: Path = REPO_ROOT) -> list[str]:
    errors: list[str] = []
    package_manifest = _package_manifest(root)
    validator_view = package_manifest.consumer_view("validator")
    opencode_manifest = next(
        manifest
        for manifest in validator_view["runtime_package_manifests"]["manifests"]
        if manifest["runtime"] == "opencode"
    )
    package = _load_json(root / opencode_manifest["path"])
    if "version" in package or "name" in package:
        errors.append("OpenCode package.json must remain non-version-bearing runtime package metadata")
    if package.get("dependencies", {}).get("@opencode-ai/plugin") != "1.14.33":
        errors.append("OpenCode package.json behavior must record @opencode-ai/plugin runtime dependency")
    if package.get("agentera", {}).get("packageShape") != opencode_manifest["package_shape"]:
        errors.append("OpenCode package.json must record suite-bundle runtime package metadata")

    docs = yaml.safe_load((root / ".agentera/docs.yaml").read_text(encoding="utf-8"))
    version_files = set(docs["conventions"]["version_files"])
    excluded_paths = set(validator_view["version_surfaces"]["excluded_runtime_manifests"])
    excluded_paths.update(manifest["path"] for manifest in package_manifest.non_version_bearing_runtime_manifests())
    for excluded_path in excluded_paths:
        if excluded_path in version_files:
            errors.append("DOCS version_files must exclude non-version-bearing OpenCode package.json")
    for surface in validator_view["version_surfaces"]["surfaces"]:
        if surface["path"] not in version_files:
            errors.append(f"DOCS version_files must include version-bearing surface {surface['path']}")
    return errors


def _validate_package_drift_inventory(root: Path = REPO_ROOT) -> list[str]:
    text = (root / "references/adapters/package-surface-characterization.md").read_text(encoding="utf-8")
    errors: list[str] = []
    for classification in (
        "version-bearing surface",
        "runtime package manifest",
        "bundle metadata surface",
        "package-manager command surface",
    ):
        if classification not in text:
            errors.append(f"package characterization must distinguish {classification}")
    for decision in ("`preserve`", "`standardize`", "`defer`"):
        if decision not in text:
            errors.append(f"package drift inventory must include decision {decision}")
    for drift_point in (
        "pyproject.toml` force-includes and `scripts/agentera_upgrade.py` bundle lists duplicate",
        "Runtime manifest `agentera.sharedPaths` includes `UPGRADE.md`",
        "`.agentera/docs.yaml` `version_files` includes version-bearing surfaces and excludes `.opencode/package.json`",
        "Upgrade package commands are represented as argv lists for Claude Code and OpenCode only",
        "Live package-manager behavior is not characterized by this task",
    ):
        if drift_point not in text:
            errors.append(f"package drift inventory missing: {drift_point}")
    return errors


def _validate_copilot_install_reference(text: str) -> list[str]:
    errors: list[str] = []
    marketplace_add = "copilot plugin marketplace add jgabor/agentera"
    granular = "copilot plugin install <skill>@agentera"
    umbrella = "copilot plugin install jgabor/agentera"
    direct = "copilot plugin install OWNER/REPO"
    verified = "marketplace install path is verified working"
    primary_direct = re.compile(
        rf"(?:primary|canonical|preferred|recommended|supported)\b[^.\n]*{re.escape(direct)}"
        rf"|{re.escape(direct)}[^.\n]*\b(?:primary|canonical|preferred|recommended|supported)",
        re.IGNORECASE,
    )
    stale_unverified = re.compile(
        r"no canonical Agentera (?:Copilot )?marketplace source is currently verified",
        re.IGNORECASE,
    )
    if marketplace_add not in text:
        errors.append("Copilot install reference must document `copilot plugin marketplace add jgabor/agentera`")
    if granular not in text:
        errors.append("Copilot install reference must document granular `<skill>@agentera` install")
    if umbrella not in text:
        errors.append("Copilot install reference must document umbrella `jgabor/agentera` install")
    if verified not in text:
        errors.append("Copilot install reference must state the marketplace path is verified working")
    if stale_unverified.search(text):
        errors.append("Copilot install reference must not claim the marketplace source is unverified")
    if "copilot plugin install agentera@<marketplace>" in text:
        errors.append("Copilot install placeholder must not masquerade as a canonical source")
    if direct not in text or "deprecated" not in text:
        errors.append("Copilot install reference must mark OWNER/REPO as deprecated fallback")
    if primary_direct.search(text):
        errors.append("Copilot fallback guidance must stay secondary to verified marketplace installs")
    if marketplace_add in text and direct in text and text.index(marketplace_add) > text.index(direct):
        errors.append("Copilot install reference must mention marketplace before OWNER/REPO")
    if "github/copilot-cli#2390" not in text:
        errors.append("Copilot install reference must cite umbrella discovery bug `github/copilot-cli#2390`")
    return errors


class TestCopilotPackaging:
    """Complex: inventory, paths, support level, and profilera limitation branches."""

    def test_copilot_package_passes(self):
        plugin = _load_json(REPO_ROOT / "plugin.json")
        assert _validate_copilot_package(plugin) == []

    def test_copilot_package_fails_on_missing_skill(self):
        plugin = _load_json(REPO_ROOT / "plugin.json")
        plugin["skills"] = []
        assert "copilot.skills path must expose skills/*/SKILL.md" in _validate_copilot_package(plugin)

    def test_copilot_package_fails_on_escaping_skill_path(self):
        plugin = _load_json(REPO_ROOT / "plugin.json")
        plugin["skills"] = "../skills"
        assert "copilot.skills paths must stay inside plugin root" in _validate_copilot_package(plugin)

    def test_copilot_install_reference_passes(self):
        reference = (REPO_ROOT / "references/adapters/runtime-feature-parity.md").read_text(encoding="utf-8")
        assert _validate_copilot_install_reference(reference) == []

    def test_copilot_install_reference_fails_on_unverified_availability_claim(self):
        reference = (REPO_ROOT / "references/adapters/runtime-feature-parity.md").read_text(encoding="utf-8")
        stale = f"{reference}\nNo canonical Agentera Copilot marketplace source is currently verified.\n"
        errors = _validate_copilot_install_reference(stale)
        assert "Copilot install reference must not claim the marketplace source is unverified" in errors

    def test_copilot_install_reference_fails_on_placeholder_as_source(self):
        reference = (REPO_ROOT / "references/adapters/runtime-feature-parity.md").read_text(encoding="utf-8")
        stale = f"{reference}\ncopilot plugin install agentera@<marketplace>\n"
        errors = _validate_copilot_install_reference(stale)
        assert "Copilot install placeholder must not masquerade as a canonical source" in errors

    def test_copilot_install_reference_fails_on_primary_fallback(self):
        reference = (REPO_ROOT / "references/adapters/runtime-feature-parity.md").read_text(encoding="utf-8")
        stale = f"{reference}\nUse copilot plugin install OWNER/REPO as the primary Copilot install path.\n"
        errors = _validate_copilot_install_reference(stale)
        assert "Copilot fallback guidance must stay secondary to verified marketplace installs" in errors


class TestCodexPackaging:
    """Complex: aggregate path, inventory, $skill hints, and implicit policy branches."""

    def test_codex_package_passes(self):
        plugin = _load_json(REPO_ROOT / ".codex-plugin/plugin.json")
        assert _validate_codex_package(plugin) == []

    def test_codex_marketplace_passes(self):
        assert _validate_codex_marketplace() == []

    def test_codex_package_fails_on_wrong_implicit_policy(self):
        plugin = _load_json(REPO_ROOT / ".codex-plugin/plugin.json")
        bundled = plugin["skillMetadata"][0]
        bundled["policy"]["allow_implicit_invocation"] = False
        assert "codex.agentera: implicit invocation policy must allow implicit" in _validate_codex_package(plugin)

    def test_codex_marketplace_fails_when_pointing_at_skill_directory(self, tmp_path):
        (tmp_path / ".agents/plugins").mkdir(parents=True)
        (tmp_path / "skills/hej").mkdir(parents=True)
        (tmp_path / "skills/hej/SKILL.md").write_text("---\nname: hej\n---\n", encoding="utf-8")
        (tmp_path / ".agents/plugins/marketplace.json").write_text(
            json.dumps({
                "name": "agentera",
                "plugins": [{
                    "name": "hej",
                    "source": {"source": "local", "path": "./skills/hej"},
                    "policy": {"installation": "AVAILABLE", "authentication": "ON_USE"},
                    "category": "Coding",
                }],
            }),
            encoding="utf-8",
        )
        errors = _validate_codex_marketplace(tmp_path)
        assert "codex marketplace must expose the aggregate agentera plugin" in errors
        assert "codex marketplace agentera path must resolve to a plugin root" in errors
        assert "codex marketplace must not point directly at a skill directory" in errors


class TestLifecycleAdapters:
    """Complex: supported configured runtime vs limitation-only runtime schemas."""

    def test_copilot_lifecycle_passes(self):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        plugin = _load_json(REPO_ROOT / "plugin.json")
        assert validator.validate_copilot(plugin, REPO_ROOT) == []
        assert validator.validate_copilot_hooks(REPO_ROOT, plugin) == []

    def test_copilot_lifecycle_fails_on_stale_custom_field(self):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        plugin = _load_json(REPO_ROOT / "plugin.json")
        plugin["lifecycleHooks"] = {"events": {"sessionStart": []}}
        assert "copilot: use supported hooks component field, not lifecycleHooks" in validator.validate_copilot(plugin, REPO_ROOT)

    def test_copilot_lifecycle_fails_without_profilera_metadata_limits(self):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        plugin = _load_json(REPO_ROOT / "plugin.json")
        plugin["description"] = "agentera: portable skills"
        assert "copilot.profilera: description must expose bounded corpus metadata limits" in validator.validate_copilot(
            plugin, REPO_ROOT
        )

    def test_copilot_lifecycle_validates_list_form_hooks(self):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        plugin = _load_json(REPO_ROOT / "plugin.json")
        plugin["hooks"] = [".github/hooks"]
        assert validator.validate_copilot_hooks(REPO_ROOT, plugin) == []

    def test_copilot_lifecycle_requires_prewrite_artifact_gate(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        root = tmp_path / "repo"
        hook_dir = root / ".github/hooks"
        hook_dir.mkdir(parents=True)
        (hook_dir / "postToolUse.json").write_text(
            json.dumps(
                {
                    "name": "postToolUse",
                    "type": "command",
                    "bash": "uv run hooks/validate_artifact.py",
                }
            ),
            encoding="utf-8",
        )
        errors = validator.validate_copilot_hooks(root, {"hooks": ".github/hooks"})
        assert "copilot: missing required preToolUse artifact validation hook" in errors

    def test_copilot_lifecycle_accepts_documented_hook_events(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        root = tmp_path / "repo"
        hook_dir = root / ".github/hooks"
        hook_dir.mkdir(parents=True)
        registry = validator.load_registry()
        for event in validator._runtime_view(registry, "copilot")["lifecycle_events"]["supported_events"]:
            (hook_dir / f"{event}.json").write_text(
                json.dumps(
                    {
                        "name": event,
                        "type": "command",
                        "bash": "uv run hooks/validate_artifact.py",
                    }
                ),
                encoding="utf-8",
            )
        assert validator.validate_copilot_hooks(root, {"hooks": ".github/hooks"}) == []

    def test_copilot_lifecycle_rejects_unsupported_hook_event(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        root = tmp_path / "repo"
        hook_dir = root / ".github/hooks"
        hook_dir.mkdir(parents=True)
        (hook_dir / "stop.json").write_text(
            json.dumps(
                {
                    "name": "stop",
                    "type": "command",
                    "bash": "uv run hooks/session_stop.py",
                }
            ),
            encoding="utf-8",
        )
        errors = validator.validate_copilot_hooks(root, {"hooks": ".github/hooks"})
        assert "copilot: unsupported lifecycle hook file configured: stop.json" in errors
        assert "copilot: unsupported lifecycle event configured: stop" in errors

    def test_copilot_lifecycle_rejects_hook_filename_mismatch(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        root = tmp_path / "repo"
        hook_dir = root / ".github/hooks"
        hook_dir.mkdir(parents=True)
        (hook_dir / "sessionStart.json").write_text(
            json.dumps(
                {
                    "name": "sessionEnd",
                    "type": "command",
                    "bash": "uv run hooks/session_stop.py",
                }
            ),
            encoding="utf-8",
        )
        errors = validator.validate_copilot_hooks(root, {"hooks": ".github/hooks"})
        assert "copilot.sessionStart.json: hook filename must match event name sessionEnd" in errors

    def test_copilot_lifecycle_list_form_hooks_fail_on_invalid_handler(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        root = tmp_path / "repo"
        hook_dir = root / ".github/hooks"
        hook_dir.mkdir(parents=True)
        (hook_dir / "sessionStart.json").write_text(
            json.dumps({"name": "sessionStart", "type": "command", "command": "python hooks/session_start.py"}),
            encoding="utf-8",
        )
        errors = validator.validate_copilot_hooks(root, {"hooks": [".github/hooks"]})
        assert "copilot.sessionStart[0]: use bash/powershell, not Claude-style command" in errors
        assert "copilot.sessionStart[0]: handler must define bash or powershell" in errors

    def test_codex_lifecycle_passes(self):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        plugin = _load_json(REPO_ROOT / ".codex-plugin/plugin.json")
        assert validator.validate_codex(plugin) == []

    def test_codex_lifecycle_fails_on_configured_event(self):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        plugin = _load_json(REPO_ROOT / ".codex-plugin/plugin.json")
        plugin["lifecycleHooks"]["events"] = {"SubagentStop": []}
        assert "codex: unsupported lifecycle event configured: SubagentStop" in validator.validate_codex(plugin)

    def test_codex_lifecycle_fails_on_profilera_policy_drift(self):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        plugin = _load_json(REPO_ROOT / ".codex-plugin/plugin.json")
        plugin["lifecycleHooks"]["status"] = "experimental"
        assert "codex: lifecycleHooks.status must be one of stable, beta" in validator.validate_codex(plugin)

    def test_codex_lifecycle_fails_on_profilera_invocation_hint_drift(self):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        plugin = _load_json(REPO_ROOT / ".codex-plugin/plugin.json")
        plugin["lifecycleHooks"]["limitations"] = []
        assert "codex: limitations must document codex_hooks status and apply_patch interception" in validator.validate_codex(plugin)

    def test_lifecycle_validation_messages_are_characterized_before_registry_migration(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        result = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts/validate_lifecycle_adapters.py")],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == "lifecycle adapter metadata ok"

        copilot_root = tmp_path / "copilot"
        copilot_root.mkdir()
        malformed_copilot = {
            "lifecycleHooks": {"events": {"sessionStart": []}},
            "skills": ["../outside"],
            "hooks": 7,
            "description": "agentera portable skills",
        }
        assert validator.validate_copilot(malformed_copilot, copilot_root) == [
            "copilot: use supported hooks component field, not lifecycleHooks",
            "copilot.skills paths must stay inside plugin root",
            "copilot.hooks must be a string or string array path",
            "copilot.profilera: description must expose bounded corpus metadata limits",
        ]

        hook_dir = copilot_root / ".github/hooks"
        hook_dir.mkdir(parents=True)
        (hook_dir / "stop.json").write_text(
            json.dumps({"name": "stop", "type": "command", "command": "python hooks/session_stop.py"}),
            encoding="utf-8",
        )
        assert validator.validate_copilot_hooks(copilot_root, {"hooks": ".github/hooks"}) == [
            "copilot: unsupported lifecycle hook file configured: stop.json",
            "copilot: unsupported lifecycle event configured: stop",
            "copilot: missing required preToolUse artifact validation hook",
        ]

        malformed_codex = {"lifecycleHooks": {"configured": True, "status": "experimental", "events": []}}
        assert validator.validate_codex(malformed_codex) == [
            "codex: lifecycleHooks.configured must be false",
            "codex: lifecycleHooks.status must be one of stable, beta",
            "codex: lifecycleHooks.events must be an object when present",
            "codex: supportedEvents must list every Codex codex_hooks event (SessionStart, Stop, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest)",
            "codex: unsupportedEvents must list Claude-Code-specific events with no Codex equivalent",
            "codex: limitations must document codex_hooks status and apply_patch interception",
        ]

    def test_lifecycle_validation_reads_supported_events_from_registry(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        registry_data = yaml.safe_load(
            (REPO_ROOT / "references/adapters/runtime-adapter-registry.yaml").read_text(encoding="utf-8")
        )
        for record in registry_data["records"]:
            if record["identity"]["runtime_id"] == "copilot":
                record["lifecycle_events"]["supported_events"].remove("errorOccurred")
        registry = validator.RuntimeAdapterRegistry(tuple(registry_data["records"]))

        root = tmp_path / "repo"
        hook_dir = root / ".github/hooks"
        hook_dir.mkdir(parents=True)
        (hook_dir / "errorOccurred.json").write_text(
            json.dumps({"name": "errorOccurred", "type": "command", "bash": "uv run hooks/session_stop.py"}),
            encoding="utf-8",
        )

        errors = validator.validate_copilot_hooks(root, {"hooks": ".github/hooks"}, registry)

        assert "copilot: unsupported lifecycle hook file configured: errorOccurred.json" in errors
        assert "copilot: unsupported lifecycle event configured: errorOccurred" in errors

    def test_lifecycle_validation_reports_registry_contract_error_before_fallback(self, tmp_path):
        registry_path = tmp_path / "references/adapters/runtime-adapter-registry.yaml"
        registry_path.parent.mkdir(parents=True)
        registry_path.write_text("schema_version: stale\nruntime_order: []\nrecords: []\n", encoding="utf-8")

        result = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts/validate_lifecycle_adapters.py"), "--root", str(tmp_path)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        assert result.returncode == 1
        assert "lifecycle adapter validation failed:" in result.stdout
        assert "registry contract error: RuntimeAdapter registry validation failed:" in result.stdout
        assert "registry.schema_version must be agentera.runtimeAdapterRegistry.v1" in result.stdout

    def test_hard_gate_docs_pass(self):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        assert validator.validate_hard_gate_docs(REPO_ROOT) == []

    def test_hard_gate_docs_fail_on_copilot_overclaim_drift(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        self._write_hard_gate_docs(
            tmp_path,
            parity=(REPO_ROOT / "references/adapters/runtime-feature-parity.md").read_text(encoding="utf-8").replace(
                "Malformed, sparse, or non-reconstructable `toolArgs` are allowed",
                "every Copilot artifact payload is blocked",
            ),
        )
        errors = validator.validate_hard_gate_docs(tmp_path)
        assert any("references/adapters/runtime-feature-parity.md: Copilot hard-gate docs" in error for error in errors)

    def test_hard_gate_docs_fail_on_opencode_apply_patch_drift(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        self._write_hard_gate_docs(
            tmp_path,
            opencode=(REPO_ROOT / "references/adapters/opencode.md").read_text(encoding="utf-8").replace(
                "Sparse payloads and `apply_patch` `patchText` without reconstructed full content are allowed",
                "Every OpenCode artifact payload is blocked",
            ),
        )
        errors = validator.validate_hard_gate_docs(tmp_path)
        assert any("references/adapters/opencode.md: OpenCode hard-gate docs" in error for error in errors)

    def test_runtime_adapter_drift_inventory_names_each_decision_class(self):
        text = (REPO_ROOT / "references/adapters/runtime-adapter-characterization.md").read_text(encoding="utf-8")
        for decision in ("preserve", "standardize", "defer"):
            assert f"`{decision}`" in text
        for drift_point in (
            "duplicated runtime order",
            "upgrade package phase only manages Claude Code and OpenCode",
            "Codex supports hook events but shipped config wires only apply_patch validation",
            "Claude lifecycle behavior is validated through native hook files, not lifecycle metadata",
        ):
            assert drift_point in text

    def test_runtime_adapter_interface_model_defines_typed_groups_and_permissions(self):
        assert _validate_runtime_adapter_interface_model() == []

        model = _load_runtime_adapter_interface_model()
        assert model["interface"] == "RuntimeAdapter"
        assert set(model["record"]["groups"]) == set(model["record"]["required_groups"])
        assert model["consumer_permissions"]["lifecycle_validation"]["allowed_groups"] == [
            "identity",
            "lifecycle_events",
            "artifact_validation",
            "documentation_claims",
        ]
        assert model["consumer_permissions"]["doctor"]["allowed_groups"] == [
            "identity",
            "host_detection",
            "config_targets",
            "diagnostics",
            "documentation_claims",
        ]
        assert model["consumer_permissions"]["upgrade"]["allowed_groups"] == [
            "identity",
            "host_detection",
            "config_targets",
            "diagnostics",
        ]

    def test_runtime_adapter_interface_model_keeps_external_ownership_out(self):
        model = _load_runtime_adapter_interface_model()
        package = model["ownership"]["package_metadata_out_of_scope"]
        install_root = model["ownership"]["install_root_out_of_scope"]

        assert package["owner"] == "package_manifest_registry"
        assert package["deferred_todo"] == "arch-package-manifest-registry"
        assert package["facts"] == [
            "version_authority",
            "package_manifest_schemas",
            "shared_package_paths",
            "release_metadata",
        ]
        assert install_root["owner"] == "scripts/install_root.py"
        assert install_root["facts"] == [
            "AGENTERA_HOME precedence",
            "default durable root",
            "managed classification",
            "stale classification",
            "unmanaged classification",
            "root diagnostics",
        ]

    @staticmethod
    def _write_hard_gate_docs(
        root: Path,
        *,
        readme: str | None = None,
        parity: str | None = None,
        opencode: str | None = None,
    ) -> None:
        (root / "references/adapters").mkdir(parents=True)
        (root / "README.md").write_text(
            readme if readme is not None else (REPO_ROOT / "README.md").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        (root / "references/adapters/runtime-feature-parity.md").write_text(
            parity
            if parity is not None
            else (REPO_ROOT / "references/adapters/runtime-feature-parity.md").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        (root / "references/adapters/opencode.md").write_text(
            opencode
            if opencode is not None
            else (REPO_ROOT / "references/adapters/opencode.md").read_text(encoding="utf-8"),
            encoding="utf-8",
        )


class TestSuiteBundleSurface:
    """Task 1 cap: one pass and one fail per runtime package shape."""

    def test_suite_bundle_surface_passes_for_each_runtime_shape(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        package_manifest = _package_manifest()
        for runtime in sorted(package_manifest.runtime_manifest_paths()):
            root = tmp_path / runtime
            self._write_bundle_fixture(root, package_manifest, runtime)
            assert validator.validate_suite_bundle_surface(root, {runtime}, package_manifest) == []

    def test_suite_bundle_surface_fails_with_owning_runtime_name(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        package_manifest = _package_manifest()
        for runtime in sorted(package_manifest.runtime_manifest_paths()):
            root = tmp_path / runtime
            self._write_bundle_fixture(root, package_manifest, runtime, omit_shared_path="scripts")
            errors = validator.validate_suite_bundle_surface(root, {runtime}, package_manifest)
            assert f"{runtime}: shared tool path scripts missing from package metadata" in errors

    def test_suite_bundle_surface_observes_manifest_path_fixture_change(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        fixture = yaml.safe_load((REPO_ROOT / "references/adapters/package-registry.yaml").read_text(encoding="utf-8"))
        fixture["records"][0]["runtime_package_manifests"]["manifests"][-1]["path"] = ".opencode/alternate-package.json"
        package_manifest = _package_manifest(fixture=fixture)
        root = tmp_path / "repo"
        self._write_bundle_fixture(root, package_manifest, "opencode")

        assert validator.validate_suite_bundle_surface(root, {"opencode"}, package_manifest) == []
        assert not (root / ".opencode/package.json").exists()

    def test_suite_bundle_surface_rejects_runtime_adapter_and_install_root_facts(self):
        registry_module = _load_package_registry_module()
        fixture = yaml.safe_load((REPO_ROOT / "references/adapters/package-registry.yaml").read_text(encoding="utf-8"))
        fixture["records"][0]["runtime_package_manifests"]["lifecycle_events"] = []
        fixture["records"][0]["runtime_package_manifests"]["install_root_classification"] = "managed"

        errors = registry_module.validate_registry_data(fixture)

        assert "records[0].runtime_package_manifests: forbidden RuntimeAdapter field lifecycle_events" in errors
        assert "records[0].runtime_package_manifests: forbidden install-root field install_root_classification" in errors

    @staticmethod
    def _write_bundle_fixture(
        root: Path,
        package_manifest: Any,
        runtime: str,
        *,
        omit_shared_path: str | None = None,
    ) -> None:
        root.mkdir(parents=True)
        required_paths = package_manifest.shared_path_requirements()
        for path, kind in required_paths.items():
            target = root / path
            if kind == "dir":
                target.mkdir(parents=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("fixture\n", encoding="utf-8")

        manifest = root / package_manifest.runtime_manifest_paths()[runtime]
        manifest.parent.mkdir(parents=True, exist_ok=True)
        shared_paths = [path for path in required_paths if path != omit_shared_path]
        package = {
            "agentera": {
                "packageShape": package_manifest.runtime_package_shapes()[runtime],
                "installRoot": os.path.relpath(root, manifest.parent),
                "sharedPaths": shared_paths,
                "singleSkillInstall": (
                    "Single-skill installs keep core SKILL.md workflow behavior; "
                    "suite tools are bundle-only enhancements."
                ),
            }
        }
        manifest.write_text(json.dumps(package), encoding="utf-8")


class TestPackagedScriptRuntimeHygiene:
    """Task 2 cap: one pass and one fail per script metadata rule."""

    def test_packaged_script_headers_pass(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        script = self._write_script(tmp_path, validator)
        os.chmod(script, 0o755)
        assert validator.validate_packaged_python_scripts(tmp_path) == []

    def test_packaged_script_headers_fail_without_uv_shebang(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        script = self._write_script(tmp_path, validator, shebang="#!/usr/bin/env python3")
        os.chmod(script, 0o755)
        assert (
            "scripts/tool.py: packaged Python script must use uv script shebang"
            in validator.validate_packaged_python_scripts(tmp_path)
        )

    def test_packaged_script_headers_fail_without_inline_metadata(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        script = self._write_script(tmp_path, validator, metadata="")
        os.chmod(script, 0o755)
        assert (
            "scripts/tool.py: packaged Python script must declare inline script metadata"
            in validator.validate_packaged_python_scripts(tmp_path)
        )

    def test_packaged_script_headers_accept_declared_external_dependencies(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        script = self._write_script(
            tmp_path,
            validator,
            metadata=(
                "# /// script\n"
                "# requires-python = \">=3.10\"\n"
                "# dependencies = [\n"
                "#   \"requests\",\n"
                "# ]\n"
                "# ///\n"
            ),
        )
        os.chmod(script, 0o755)
        assert validator.validate_packaged_python_scripts(tmp_path) == []

    def test_packaged_script_headers_fail_without_dependencies_field(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        script = self._write_script(
            tmp_path,
            validator,
            metadata=(
                "# /// script\n"
                "# requires-python = \">=3.10\"\n"
                "# ///\n"
            ),
        )
        assert (
            "scripts/tool.py: packaged Python script must declare dependencies"
            in validator.validate_packaged_python_scripts(tmp_path)
        )

    def test_packaged_script_headers_fail_without_requires_python(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        script = self._write_script(
            tmp_path,
            validator,
            metadata=(
                "# /// script\n"
                "# dependencies = []\n"
                "# ///\n"
            ),
        )
        assert (
            "scripts/tool.py: packaged Python script must declare requires-python"
            in validator.validate_packaged_python_scripts(tmp_path)
        )

    def test_nested_library_modules_are_excluded(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        script_dir = tmp_path / "scripts" / "library"
        script_dir.mkdir(parents=True)
        (script_dir / "library.py").write_text("def helper():\n    return 1\n", encoding="utf-8")
        assert validator.validate_packaged_python_scripts(tmp_path) == []

    @staticmethod
    def _write_script(
        root: Path,
        validator: ModuleType,
        *,
        shebang: str | None = None,
        metadata: str | None = None,
    ) -> Path:
        script_dir = root / "scripts"
        script_dir.mkdir(parents=True, exist_ok=True)
        script = script_dir / "tool.py"
        if shebang is None:
            shebang = validator.UV_SCRIPT_SHEBANG
        if metadata is None:
            metadata = (
                "# /// script\n"
                "# requires-python = \">=3.10\"\n"
                "# dependencies = []\n"
                "# ///\n"
            )
        script.write_text(f"{shebang}\n{metadata}print('ok')\n", encoding="utf-8")
        return script

    def test_uv_runtime_check_guides_install_when_unavailable(self):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        errors = validator.validate_uv_runtime(path="/tmp/agentera-empty-path")
        assert errors == [validator.UV_INSTALL_GUIDANCE]


class TestLegacyRuntimeCompatibility:
    """Complex: legacy compatibility spans marketplace metadata and command shims."""

    def test_registry_structure_passes(self):
        assert _validate_registry() == []

    def test_legacy_hej_bridge_routes_to_upgrade(self):
        text = (REPO_ROOT / "skills/hej/SKILL.md").read_text(encoding="utf-8")
        assert "Legacy Agentera v1 entry-point bridge" in text
        assert "legacy_bridge: true" in text
        assert "Do not run the old HEJ orientation workflow" in text
        assert "agentera upgrade --project \"$PWD\" --dry-run" in text
        assert "agentera upgrade --project \"$PWD\" --yes --update-packages" in text
        assert "/agentera" in text

    def test_registry_structure_fails_on_wrong_skill_count(self, tmp_path):
        root = tmp_path / "repo"
        root.mkdir()
        (root / "registry.json").write_text(
            json.dumps({"skills": []}), encoding="utf-8"
        )
        assert "registry must have exactly one skill entry" in _validate_registry(root)

    def test_claude_code_package_passes(self):
        assert _validate_claude_package() == []

    def test_claude_code_package_fails_on_mismatched_plugin_name(self, tmp_path):
        root = tmp_path / "repo"
        skill_dir = root / "skills" / "agentera"
        (skill_dir / ".claude-plugin").mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("# agentera\n", encoding="utf-8")
        (root / ".claude-plugin").mkdir()
        (root / ".claude-plugin/marketplace.json").write_text(
            json.dumps({"plugins": [{"name": "agentera"}]}), encoding="utf-8"
        )
        (skill_dir / ".claude-plugin/plugin.json").write_text(
            json.dumps({"name": "wrong", "version": "1.0.0", "description": "x", "author": {}}),
            encoding="utf-8",
        )
        assert "claude.agentera: plugin name must match skill directory" in _validate_claude_package(root)

    def test_opencode_package_passes(self):
        assert _validate_opencode_package() == []

    def test_opencode_package_observes_manifest_path_fixture_change(self, tmp_path):
        root = tmp_path / "repo"
        (root / "skills/agentera").mkdir(parents=True)
        (root / "skills/agentera/SKILL.md").write_text("# agentera\n", encoding="utf-8")
        (root / ".opencode/plugins").mkdir(parents=True)
        (root / ".opencode/alternate").mkdir(parents=True)
        (root / "registry.json").write_text(
            json.dumps({"skills": [{"name": "agentera", "version": "1.18.0"}]}), encoding="utf-8"
        )
        (root / ".opencode/alternate/package.json").write_text(json.dumps({"type": "module"}), encoding="utf-8")
        (root / ".opencode/plugins/agentera.js").write_text(
            'export const AGENTERA_VERSION = "1.18.0";\n\nexport const COMMAND_TEMPLATES = {\n  "agentera": `---\nagentera_managed: true\n---\nLoad and execute the agentera bundled skill.\n`,\n};\n\nevent:\n"shell.env"\n"tool.execute.before"\n"tool.execute.after"\n',
            encoding="utf-8",
        )
        fixture = yaml.safe_load((REPO_ROOT / "references/adapters/package-registry.yaml").read_text(encoding="utf-8"))
        fixture["records"][0]["runtime_package_manifests"]["manifests"][-1]["path"] = (
            ".opencode/alternate/package.json"
        )
        package_manifest = _package_manifest(root, fixture)

        assert _validate_opencode_package(root, package_manifest) == []
        assert not (root / ".opencode/package.json").exists()

    def test_opencode_reference_uses_single_agentera_install(self):
        text = (REPO_ROOT / "references/adapters/opencode.md").read_text(encoding="utf-8")
        assert _validate_opencode_reference(text) == []

    def test_opencode_reference_fails_on_v1_manual_install(self):
        text = (REPO_ROOT / "references/adapters/opencode.md").read_text(encoding="utf-8")
        stale = f"{text}\nOpenCode discovers all 12 skills from skills/realisera/SKILL.md.\n"
        assert "OpenCode reference must not document v1 multi-skill manual install" in _validate_opencode_reference(stale)

    def test_opencode_package_uses_documented_manual_install_root(self):
        plugin_text = (REPO_ROOT / ".opencode/plugins/agentera.js").read_text(encoding="utf-8")
        assert _validate_opencode_install_root(plugin_text) == []

    def test_opencode_package_fails_on_manual_install_root_drift(self):
        plugin_text = (REPO_ROOT / ".opencode/plugins/agentera.js").read_text(encoding="utf-8")
        stale = plugin_text.replace('path.join(process.env.HOME, ".agents", "agentera")', "legacyMissingPath")
        assert "opencode validation must resolve documented default durable root" in _validate_opencode_install_root(stale)

    def test_install_root_documentation_points_to_shared_contract(self):
        assert _validate_install_root_documentation() == []

    def test_install_root_documentation_fails_without_registry_pointer(self, tmp_path):
        root = tmp_path / "repo"
        for relative in (
            "skills/agentera/capabilities/hej",
            "references/adapters",
            ".agentera",
        ):
            (root / relative).mkdir(parents=True, exist_ok=True)
        text = (
            "AGENTERA_HOME default durable root managed stale unmanaged "
            "scripts/install_root.py package metadata registry work stays outside\n"
        )
        for relative in (
            "README.md",
            "UPGRADE.md",
            "skills/agentera/SKILL.md",
            "skills/agentera/capabilities/hej/prose.md",
            ".agentera/docs.yaml",
            "TODO.md",
            "references/adapters/runtime-feature-parity.md",
        ):
            (root / relative).write_text(text, encoding="utf-8")

        errors = _validate_install_root_documentation(root)
        assert "install-root docs must point runtime facts at the RuntimeAdapter registry" in errors

    def test_opencode_version_marker_is_documented(self):
        assert _validate_docs_version_targets(REPO_ROOT) == []

    def test_opencode_package_fails_on_version_drift(self):
        plugin_text = (REPO_ROOT / ".opencode/plugins/agentera.js").read_text(encoding="utf-8")
        current_version = _read_opencode_agentera_version(plugin_text)
        stale_version = "0.0.0-stale-fixture"
        assert stale_version != current_version
        stale = plugin_text.replace(
            f'AGENTERA_VERSION = "{current_version}"',
            f'AGENTERA_VERSION = "{stale_version}"',
        )
        assert f'AGENTERA_VERSION = "{stale_version}"' in stale
        assert "opencode AGENTERA_VERSION must match registry suite version" in _validate_opencode_version(
            REPO_ROOT, stale
        )

    def test_opencode_agentera_version_reader_extracts_current_literal(self):
        """The drift test must read the live AGENTERA_VERSION from agentera.js at test
        time so future suite bumps do not require manually syncing a hardcoded literal
        in this fixture (logged as Cycle 167 Surprise; resolved in 1.20.0)."""
        plugin_text = (REPO_ROOT / ".opencode/plugins/agentera.js").read_text(encoding="utf-8")
        current_version = _read_opencode_agentera_version(plugin_text)
        assert re.fullmatch(r"\d+\.\d+\.\d+", current_version)
        registry = _load_json(REPO_ROOT / "registry.json")
        suite_versions = {
            skill.get("version")
            for skill in registry.get("skills", [])
            if isinstance(skill, dict)
        }
        assert suite_versions == {current_version}

    def test_version_bearing_package_surfaces_align(self):
        assert _validate_package_versions() == []

    def test_package_surface_characterization_distinguishes_non_version_opencode_manifest(self):
        assert _validate_package_surface_characterization() == []

    def test_package_drift_inventory_names_decisions_and_surface_classes(self):
        assert _validate_package_drift_inventory() == []

    def test_package_manifest_interface_model_defines_typed_groups_and_ownership(self):
        assert _validate_package_manifest_interface_model() == []

        model = _load_package_manifest_interface_model()
        assert model["interface"] == "PackageManifest"
        assert set(model["record"]["groups"]) == set(model["record"]["required_groups"])
        assert model["ownership"]["registry_json_version_authority"]["owner"] == "registry.json"
        assert model["ownership"]["registry_json_version_authority"]["access_interface"] == "PackageManifest"
        assert model["ownership"]["install_root_delegated"]["owner"] == "scripts/install_root.py"
        assert model["ownership"]["runtime_adapter_delegated"]["owner"] == "scripts/runtime_adapter_registry.py"

    def test_package_manifest_command_model_preserves_argv_safety_and_write_gates(self):
        model = _load_package_manifest_interface_model()
        assert _validate_package_manifest_command_safety(model) == []

        commands = model["sample_manifest"]["package_commands"]["commands"]
        assert commands[0]["action"] == "remove-legacy-skills"
        assert commands[0]["runtime"] == "all"
        assert commands[0]["phase"] == "cleanup"
        assert {command["runtime"] for command in commands[1:]} == {"claude", "opencode"}
        assert {command["phase"] for command in commands[1:]} == {"runtime-install"}
        assert all(isinstance(command["argv"], list) for command in commands)
        assert model["command_safety"]["gates"] == {
            "update_packages_required_to_plan": True,
            "yes_required_to_execute": True,
            "preserve_existing_write_gates": True,
        }

    def test_package_manifest_command_model_rejects_shell_strings(self):
        model = _load_package_manifest_interface_model()
        model["sample_manifest"]["package_commands"]["commands"][1]["argv"] = (
            "npx skills add jgabor/agentera -g -a claude-code --skill agentera -y"
        )

        assert "PackageManifest command 'install-agentera-skill' must use list argv" in (
            _validate_package_manifest_command_safety(model)
        )

    def test_package_manifest_command_model_rejects_cleanup_runtime_mix(self):
        model = _load_package_manifest_interface_model()
        model["sample_manifest"]["package_commands"]["commands"][0]["phase"] = "runtime-install"

        assert "PackageManifest cleanup commands must stay separate from runtime installs" in (
            _validate_package_manifest_command_safety(model)
        )

    def test_version_bearing_package_surfaces_fail_on_drift(self, tmp_path):
        root = tmp_path / "repo"
        (root / ".github/plugin").mkdir(parents=True)
        (root / ".codex-plugin").mkdir()
        (root / ".claude-plugin").mkdir()
        (root / ".opencode/plugins").mkdir(parents=True)
        (root / "registry.json").write_text(
            json.dumps({"skills": [{"name": "agentera", "version": "1.27.0"}]}), encoding="utf-8"
        )
        (root / "pyproject.toml").write_text('[project]\nversion = "1.27.0"\n', encoding="utf-8")
        (root / "plugin.json").write_text(json.dumps({"version": "1.27.0"}), encoding="utf-8")
        (root / ".github/plugin/plugin.json").write_text(json.dumps({"version": "1.27.0"}), encoding="utf-8")
        (root / ".codex-plugin/plugin.json").write_text(json.dumps({"version": "0.0.0"}), encoding="utf-8")
        (root / ".claude-plugin/marketplace.json").write_text(
            json.dumps(
                {
                    "metadata": {"version": "1.27.0"},
                    "plugins": [{"name": "agentera", "version": "1.27.0"}],
                }
            ),
            encoding="utf-8",
        )
        (root / ".opencode/plugins/agentera.js").write_text(
            'export const AGENTERA_VERSION = "1.27.0";\n', encoding="utf-8"
        )

        errors = _validate_package_versions(root)

        assert ".codex-plugin/plugin.json version must match registry suite version 1.27.0" in errors

    def test_version_bearing_package_surfaces_observe_fixture_path_change(self, tmp_path):
        root = tmp_path / "repo"
        (root / ".github/plugin").mkdir(parents=True)
        (root / ".codex-plugin").mkdir()
        (root / ".claude-plugin").mkdir()
        (root / ".opencode/plugins").mkdir(parents=True)
        (root / "registry.json").write_text(
            json.dumps({"skills": [{"name": "agentera", "version": "1.27.0"}]}), encoding="utf-8"
        )
        (root / "pyproject.toml").write_text('[project]\nversion = "1.27.0"\n', encoding="utf-8")
        (root / "plugin.json").write_text(json.dumps({"version": "1.27.0"}), encoding="utf-8")
        (root / ".github/plugin/plugin.json").write_text(json.dumps({"version": "1.27.0"}), encoding="utf-8")
        (root / ".codex-plugin/plugin.json").write_text(json.dumps({"version": "1.27.0"}), encoding="utf-8")
        (root / ".codex-plugin/alternate-plugin.json").write_text(json.dumps({"version": "0.0.0"}), encoding="utf-8")
        (root / ".claude-plugin/marketplace.json").write_text(
            json.dumps(
                {
                    "metadata": {"version": "1.27.0"},
                    "plugins": [{"name": "agentera", "version": "1.27.0"}],
                }
            ),
            encoding="utf-8",
        )
        (root / ".opencode/plugins/agentera.js").write_text(
            'export const AGENTERA_VERSION = "1.27.0";\n', encoding="utf-8"
        )
        fixture = yaml.safe_load((REPO_ROOT / "references/adapters/package-registry.yaml").read_text(encoding="utf-8"))
        fixture["records"][0]["version_surfaces"]["surfaces"][4]["path"] = ".codex-plugin/alternate-plugin.json"
        package_manifest = _package_manifest(root, fixture)

        errors = _validate_package_versions(root, package_manifest)

        assert ".codex-plugin/alternate-plugin.json version must match registry suite version 1.27.0" in errors
        assert ".codex-plugin/plugin.json version must match registry suite version 1.27.0" not in errors

    def test_opencode_package_fails_on_missing_command_file(self, tmp_path):
        root = tmp_path / "repo"
        (root / "skills/agentera").mkdir(parents=True)
        (root / "skills/agentera/SKILL.md").write_text("# agentera\n", encoding="utf-8")
        (root / ".opencode/plugins").mkdir(parents=True)
        (root / ".opencode/commands").mkdir()
        (root / "registry.json").write_text(
            json.dumps({"skills": [{"name": "agentera", "version": "1.18.0"}]}), encoding="utf-8"
        )
        (root / ".opencode/package.json").write_text(json.dumps({"type": "module"}), encoding="utf-8")
        (root / ".opencode/plugins/agentera.js").write_text(
            'export const AGENTERA_VERSION = "1.18.0";\n\nexport const COMMAND_TEMPLATES = {\n  "agentera": `---\ndescription: "test"\n---\nNo managed marker.\n`,\n};\n\nevent:\n"shell.env"\n"tool.execute.before"\n"tool.execute.after"\n',
            encoding="utf-8",
        )
        assert "opencode.agentera: command template must keep managed marker" in _validate_opencode_package(root)

    def test_opencode_package_fails_on_phantom_hook_regression(self, tmp_path):
        """Phantom direct hooks (`session.created`, `session.idle`) must not reappear.

        Verified against `@opencode-ai/plugin` Hooks interface in
        `.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts` lines 142-268;
        neither direct key exists, so registering against them is a silent no-op.
        """
        plugin_text = (REPO_ROOT / ".opencode/plugins/agentera.js").read_text(encoding="utf-8")
        assert '"session.created":' not in plugin_text
        assert '"session.idle":' not in plugin_text
        assert "event:" in plugin_text
        assert '"shell.env"' in plugin_text
        assert '"tool.execute.before"' in plugin_text
        assert '"tool.execute.after"' in plugin_text

        root = tmp_path / "repo"
        commands_dir = root / ".opencode/commands"
        commands_dir.mkdir(parents=True)
        (root / ".opencode/plugins").mkdir(parents=True)
        (root / "skills/agentera").mkdir(parents=True)
        (root / "skills/agentera/SKILL.md").write_text("# agentera\n", encoding="utf-8")
        (root / "registry.json").write_text(
            json.dumps({"skills": [{"name": "agentera", "version": "1.18.0"}]}), encoding="utf-8"
        )
        (root / ".opencode/package.json").write_text(json.dumps({"type": "module"}), encoding="utf-8")
        (root / ".opencode/plugins/agentera.js").write_text(
            'export const AGENTERA_VERSION = "1.18.0";\n\nexport const COMMAND_TEMPLATES = {\n  "agentera": `---\nagentera_managed: true\n---\nLoad and execute the agentera bundled skill.\n`,\n};\n'
            + '"session.created": async () => {}\n"session.idle": async () => {}\nevent:\n"shell.env"\n"tool.execute.before"\n"tool.execute.after"\n',
            encoding="utf-8",
        )
        errors = _validate_opencode_package(root)
        assert any('"session.created":' in err and "phantom" in err for err in errors)
        assert any('"session.idle":' in err and "phantom" in err for err in errors)
