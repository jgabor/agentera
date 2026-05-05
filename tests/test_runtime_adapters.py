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
import tomllib
from pathlib import Path
from types import ModuleType
from typing import Any


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
    marketplace = _load_json(root / ".claude-plugin/marketplace.json")
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


def _validate_opencode_package(root: Path = REPO_ROOT) -> list[str]:
    errors: list[str] = []
    package = _load_json(root / ".opencode/package.json")
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
    registry = _load_json(root / "registry.json")
    versions = {
        skill.get("version")
        for skill in registry.get("skills", [])
        if isinstance(skill, dict)
    }
    if len(versions) != 1:
        errors.append("opencode registry comparison needs one suite version")
    else:
        suite_version = versions.pop()
        if f'AGENTERA_VERSION = "{suite_version}"' not in plugin_text:
            errors.append("opencode AGENTERA_VERSION must match registry suite version")

    return errors


def _validate_package_versions(root: Path = REPO_ROOT) -> list[str]:
    errors: list[str] = []
    registry = _load_json(root / "registry.json")
    registry_versions = {
        skill.get("version")
        for skill in registry.get("skills", [])
        if isinstance(skill, dict)
    }
    if len(registry_versions) != 1:
        return ["registry skill versions must share one suite version"]
    suite_version = registry_versions.pop()

    surfaces = {
        "pyproject.toml": tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
        .get("project", {})
        .get("version"),
        "plugin.json": _load_json(root / "plugin.json").get("version"),
        ".github/plugin/plugin.json": _load_json(root / ".github/plugin/plugin.json").get("version"),
        ".codex-plugin/plugin.json": _load_json(root / ".codex-plugin/plugin.json").get("version"),
        ".claude-plugin/marketplace.json metadata": _load_json(root / ".claude-plugin/marketplace.json")
        .get("metadata", {})
        .get("version"),
        ".opencode/plugins/agentera.js": _read_opencode_agentera_version(
            (root / ".opencode/plugins/agentera.js").read_text(encoding="utf-8")
        ),
    }

    marketplace = _load_json(root / ".claude-plugin/marketplace.json")
    for plugin in marketplace.get("plugins", []):
        if isinstance(plugin, dict):
            surfaces[f".claude-plugin/marketplace.json plugin {plugin.get('name')}"] = plugin.get("version")

    for label, version in surfaces.items():
        if version != suite_version:
            errors.append(f"{label} version must match registry suite version {suite_version}")

    return errors


def _validate_registry(root: Path = REPO_ROOT) -> list[str]:
    errors: list[str] = []
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
            if skill.get("name") != "agentera":
                errors.append("registry skill name must be agentera")
            if not isinstance(skill.get("version"), str):
                errors.append("registry skill must have a version string")
            capabilities = skill.get("capabilities")
            if not isinstance(capabilities, list) or len(capabilities) != 12:
                errors.append("registry skill must list 12 capabilities")
            elif sorted(capabilities) != sorted(capabilities):
                errors.append("registry capabilities must be unique")
    return errors


def _validate_opencode_install_root(plugin_text: str) -> list[str]:
    if 'path.join(process.env.HOME, ".agents", "agentera")' not in plugin_text:
        return ["opencode validation must resolve documented manual install root"]
    return []


def _validate_docs_version_targets(root: Path) -> list[str]:
    docs = (root / ".agentera/docs.yaml").read_text(encoding="utf-8")
    if ".opencode/plugins/agentera.js" not in docs:
        return ["DOCS version_files must include OpenCode version marker"]
    return []


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
        for event in validator.COPILOT_EVENTS:
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
        for runtime in sorted(validator.RUNTIME_PACKAGE_SURFACES):
            root = tmp_path / runtime
            self._write_bundle_fixture(root, validator, runtime)
            assert validator.validate_suite_bundle_surface(root, {runtime}) == []

    def test_suite_bundle_surface_fails_with_owning_runtime_name(self, tmp_path):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        for runtime in sorted(validator.RUNTIME_PACKAGE_SURFACES):
            root = tmp_path / runtime
            self._write_bundle_fixture(root, validator, runtime, omit_shared_path="scripts")
            errors = validator.validate_suite_bundle_surface(root, {runtime})
            assert f"{runtime}: shared tool path scripts missing from package metadata" in errors

    @staticmethod
    def _write_bundle_fixture(
        root: Path,
        validator: ModuleType,
        runtime: str,
        *,
        omit_shared_path: str | None = None,
    ) -> None:
        root.mkdir(parents=True)
        for path, kind in validator.SUITE_BUNDLE_REQUIRED_PATHS.items():
            target = root / path
            if kind == "dir":
                target.mkdir(parents=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("fixture\n", encoding="utf-8")

        manifest = root / validator.RUNTIME_PACKAGE_SURFACES[runtime]
        manifest.parent.mkdir(parents=True, exist_ok=True)
        shared_paths = [
            path for path in validator.SUITE_BUNDLE_REQUIRED_PATHS if path != omit_shared_path
        ]
        package = {
            "agentera": {
                "packageShape": "suite-bundle",
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

    def test_opencode_package_uses_documented_manual_install_root(self):
        plugin_text = (REPO_ROOT / ".opencode/plugins/agentera.js").read_text(encoding="utf-8")
        assert _validate_opencode_install_root(plugin_text) == []

    def test_opencode_package_fails_on_manual_install_root_drift(self):
        plugin_text = (REPO_ROOT / ".opencode/plugins/agentera.js").read_text(encoding="utf-8")
        stale = plugin_text.replace('path.join(process.env.HOME, ".agents", "agentera")', "legacyMissingPath")
        assert "opencode validation must resolve documented manual install root" in _validate_opencode_install_root(stale)

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
