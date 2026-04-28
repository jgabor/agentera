"""Tests for public runtime adapter metadata.

Proportionality: one pass and one fail per runtime/package or hook unit.
Extra assertions inside a unit are branch-justified by public compatibility
surfaces: skill inventory, paths, invocation policy, and runtime limitations.
"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path
from types import ModuleType
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
PROFILERA_LIMITATION = {
    "profilera": "limited",
}


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
        expected_support = PROFILERA_LIMITATION.get(name, "portable")
        if skill.get("runtimeSupport") != expected_support:
            errors.append(f"codex.{name}: runtimeSupport must be {expected_support}")
        expected_implicit = name != "profilera"
        if policy.get("allow_implicit_invocation") is not expected_implicit:
            errors.append(f"codex.{name}: implicit invocation policy is wrong")
        if skill.get("invocationHint") and f"${name}" not in skill["invocationHint"]:
            errors.append(f"codex.{name}: invocation hint must name ${name}")
        if name == "profilera":
            capabilities = skill.get("requiredCapabilities")
            if not capabilities:
                errors.append("codex.profilera: requiredCapabilities must name corpus capability")
            elif capabilities[0].get("name") != "codex_session_corpus":
                errors.append("codex.profilera: corpus capability must be named codex_session_corpus")
            elif capabilities[0].get("status") not in ("ok", "degraded"):
                errors.append("codex.profilera: corpus capability status must be ok or degraded")
            for text in skill.get("limitations", []) + [skill.get("invocationHint", "")]:
                if "collector exists" in text or "not implemented" in text:
                    errors.append("codex.profilera: stale missing-collector limitation")

    if isinstance(codex, dict) and isinstance(codex.get("uiMetadata"), str):
        errors.extend(_validate_codex_ui_metadata(REPO_ROOT / codex["uiMetadata"]))

    return errors


def _validate_codex_ui_metadata(path: Path) -> list[str]:
    errors: list[str] = []
    text = path.read_text(encoding="utf-8")
    expected = _skill_names()
    for name in expected:
        if f"  - name: {name}\n" not in text:
            errors.append(f"codex.ui.{name}: missing skill entry")
        skill_root = f"    path: ./skills/{name}\n"
        skill_metadata = f"    metadata: ./skills/{name}/agents/openai.yaml\n"
        if skill_root not in text:
            errors.append(f"codex.ui.{name}: path must resolve from plugin install root")
        if skill_metadata not in text:
            errors.append(f"codex.ui.{name}: metadata must resolve from plugin install root")
        if not (REPO_ROOT / f"skills/{name}/SKILL.md").is_file():
            errors.append(f"codex.ui.{name}: skill path missing SKILL.md")
        if not (REPO_ROOT / f"skills/{name}/agents/openai.yaml").is_file():
            errors.append(f"codex.ui.{name}: per-skill UI metadata missing")

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
            errors.append(f"claude.{name}: missing per-skill plugin.json")
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

    # Real `@opencode-ai/plugin` Hooks interface members. Session lifecycle
    # arrives through the generic `event` hook; `session.created` and
    # `session.idle` are event.type payload values, not hook object keys.
    for hook in ('event:', '"shell.env"', '"tool.execute.before"', '"tool.execute.after"'):
        if hook not in plugin_text:
            errors.append(f"opencode plugin missing {hook} hook")
    for phantom in ('"session.created":', '"session.idle":'):
        if phantom in plugin_text:
            errors.append(f"opencode plugin must not register phantom hook {phantom}")

    for name in expected:
        command_path = root / ".opencode/commands" / f"{name}.md"
        if not command_path.is_file():
            errors.append(f"opencode.{name}: missing command file")
            continue
        command = command_path.read_text(encoding="utf-8")
        if "agentera_managed: true" not in command:
            errors.append(f"opencode.{name}: command must keep managed marker")
        if f"Load and execute the {name} skill" not in command:
            errors.append(f"opencode.{name}: command must invoke matching skill")

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
        if isinstance(skill, dict) and skill.get("name") != "profilera"
    }
    if len(versions) != 1:
        errors.append("opencode registry comparison needs one suite version")
    else:
        suite_version = versions.pop()
        if f'AGENTERA_VERSION = "{suite_version}"' not in plugin_text:
            errors.append("opencode AGENTERA_VERSION must match registry suite version")

    return errors


def _validate_opencode_install_root(plugin_text: str) -> list[str]:
    if 'path.join(process.env.HOME, ".agents", "agentera")' not in plugin_text:
        return ["opencode validation must resolve documented manual install root"]
    return []


def _validate_docs_version_targets(root: Path) -> list[str]:
    docs = (root / ".agentera/DOCS.md").read_text(encoding="utf-8")
    if "- .opencode/plugins/agentera.js" not in docs:
        return ["DOCS version_files must include OpenCode version marker"]
    return []


def _validate_readme_copilot_install_guidance(text: str) -> list[str]:
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
        errors.append("README Copilot install must document `copilot plugin marketplace add jgabor/agentera`")
    if granular not in text:
        errors.append("README Copilot install must document granular `<skill>@agentera` install")
    if umbrella not in text:
        errors.append("README Copilot install must document umbrella `jgabor/agentera` install")
    if verified not in text:
        errors.append("README Copilot install must state the marketplace path is verified working")
    if stale_unverified.search(text):
        errors.append("README Copilot install must not claim the marketplace source is unverified")
    if "copilot plugin install agentera@<marketplace>" in text:
        errors.append("README Copilot placeholder must not masquerade as a canonical source")
    if direct not in text or "deprecated" not in text:
        errors.append("README Copilot install must mark OWNER/REPO as deprecated fallback")
    if primary_direct.search(text):
        errors.append("README Copilot fallback guidance must stay secondary to verified marketplace installs")
    if marketplace_add in text and direct in text and text.index(marketplace_add) > text.index(direct):
        errors.append("README Copilot install must mention marketplace before OWNER/REPO")
    if "github/copilot-cli#2390" not in text:
        errors.append("README Copilot install must cite umbrella discovery bug `github/copilot-cli#2390`")
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

    def test_copilot_readme_install_guidance_passes(self):
        readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
        assert _validate_readme_copilot_install_guidance(readme) == []

    def test_copilot_readme_install_guidance_fails_on_unverified_availability_claim(self):
        readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
        stale = f"{readme}\nNo canonical Agentera Copilot marketplace source is currently verified.\n"
        errors = _validate_readme_copilot_install_guidance(stale)
        assert "README Copilot install must not claim the marketplace source is unverified" in errors

    def test_copilot_readme_install_guidance_fails_on_placeholder_as_source(self):
        readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
        stale = f"{readme}\ncopilot plugin install agentera@<marketplace>\n"
        errors = _validate_readme_copilot_install_guidance(stale)
        assert "README Copilot placeholder must not masquerade as a canonical source" in errors

    def test_copilot_readme_install_guidance_fails_on_primary_fallback(self):
        readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
        stale = f"{readme}\nUse copilot plugin install OWNER/REPO as the primary Copilot install path.\n"
        errors = _validate_readme_copilot_install_guidance(stale)
        assert "README Copilot fallback guidance must stay secondary to verified marketplace installs" in errors


class TestCodexPackaging:
    """Complex: aggregate path, inventory, $skill hints, and implicit policy branches."""

    def test_codex_package_passes(self):
        plugin = _load_json(REPO_ROOT / ".codex-plugin/plugin.json")
        assert _validate_codex_package(plugin) == []

    def test_codex_package_fails_on_profilera_implicit_policy(self):
        plugin = _load_json(REPO_ROOT / ".codex-plugin/plugin.json")
        profilera = next(skill for skill in plugin["skillMetadata"] if skill["name"] == "profilera")
        profilera["policy"]["allow_implicit_invocation"] = True
        assert "codex.profilera: implicit invocation policy is wrong" in _validate_codex_package(plugin)


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
                    "bash": "python3 hooks/validate_artifact.py",
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
                        "bash": "python3 hooks/validate_artifact.py",
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
                    "bash": "python3 hooks/session_stop.py",
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
                    "bash": "python3 hooks/session_stop.py",
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
        assert validator.validate_codex_profilera_metadata(REPO_ROOT, plugin) == []

    def test_codex_lifecycle_fails_on_configured_event(self):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        plugin = _load_json(REPO_ROOT / ".codex-plugin/plugin.json")
        plugin["lifecycleHooks"]["events"] = {"SubagentStop": []}
        assert "codex: unsupported lifecycle event configured: SubagentStop" in validator.validate_codex(plugin)

    def test_codex_lifecycle_fails_on_profilera_policy_drift(self):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        plugin = _load_json(REPO_ROOT / ".codex-plugin/plugin.json")
        profilera = next(skill for skill in plugin["skillMetadata"] if skill["name"] == "profilera")
        profilera["runtimeSupport"] = "portable"
        assert (
            "codex.profilera: runtimeSupport must stay limited across metadata surfaces"
            in validator.validate_codex_profilera_metadata(REPO_ROOT, plugin)
        )

    def test_codex_lifecycle_fails_on_profilera_invocation_hint_drift(self):
        validator = _load_module("validate_lifecycle_adapters", REPO_ROOT / "scripts/validate_lifecycle_adapters.py")
        plugin = _load_json(REPO_ROOT / ".codex-plugin/plugin.json")
        profilera = next(skill for skill in plugin["skillMetadata"] if skill["name"] == "profilera")
        profilera["invocationHint"] = "$profilera"
        assert (
            "codex.profilera: invocation hint must expose limited Section 22 source-family rules"
            in validator.validate_codex_profilera_metadata(REPO_ROOT, plugin)
        )


class TestLegacyRuntimeCompatibility:
    """Complex: legacy compatibility spans marketplace metadata and command shims."""

    def test_claude_code_package_passes(self):
        assert _validate_claude_package() == []

    def test_claude_code_package_fails_on_mismatched_plugin_name(self, tmp_path):
        root = tmp_path / "repo"
        skill_dir = root / "skills" / "hej"
        (skill_dir / ".claude-plugin").mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("# hej\n", encoding="utf-8")
        (root / ".claude-plugin").mkdir()
        (root / ".claude-plugin/marketplace.json").write_text(
            json.dumps({"plugins": [{"name": "hej"}]}), encoding="utf-8"
        )
        (skill_dir / ".claude-plugin/plugin.json").write_text(
            json.dumps({"name": "wrong", "version": "1.0.0", "description": "x", "author": {}}),
            encoding="utf-8",
        )
        assert "claude.hej: plugin name must match skill directory" in _validate_claude_package(root)

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
            if isinstance(skill, dict) and skill.get("name") != "profilera"
        }
        assert suite_versions == {current_version}

    def test_opencode_package_fails_on_missing_command_file(self, tmp_path):
        root = tmp_path / "repo"
        (root / "skills/hej").mkdir(parents=True)
        (root / "skills/hej/SKILL.md").write_text("# hej\n", encoding="utf-8")
        (root / ".opencode/plugins").mkdir(parents=True)
        (root / ".opencode/commands").mkdir()
        (root / "registry.json").write_text(
            json.dumps({"skills": [{"name": "hej", "version": "1.18.0"}]}), encoding="utf-8"
        )
        (root / ".opencode/package.json").write_text(json.dumps({"type": "module"}), encoding="utf-8")
        (root / ".opencode/plugins/agentera.js").write_text(
            'export const AGENTERA_VERSION = "1.18.0";\n  "hej": `\nevent:\n"shell.env"\n"tool.execute.before"\n"tool.execute.after"\n',
            encoding="utf-8",
        )
        assert "opencode.hej: missing command file" in _validate_opencode_package(root)

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
        (root / "skills/hej").mkdir(parents=True)
        (root / "skills/hej/SKILL.md").write_text("# hej\n", encoding="utf-8")
        (commands_dir / "hej.md").write_text(
            "---\nagentera_managed: true\n---\nLoad and execute the hej skill\n",
            encoding="utf-8",
        )
        (root / "registry.json").write_text(
            json.dumps({"skills": [{"name": "hej", "version": "1.18.0"}]}), encoding="utf-8"
        )
        (root / ".opencode/package.json").write_text(json.dumps({"type": "module"}), encoding="utf-8")
        # Regression fixture re-registers the phantom keys; validator must catch it.
        (root / ".opencode/plugins/agentera.js").write_text(
            'export const AGENTERA_VERSION = "1.18.0";\n  "hej": `\n'
            '"session.created": async () => {}\n"session.idle": async () => {}\nevent:\n"shell.env"\n"tool.execute.before"\n"tool.execute.after"\n',
            encoding="utf-8",
        )
        errors = _validate_opencode_package(root)
        assert any('"session.created":' in err and "phantom" in err for err in errors)
        assert any('"session.idle":' in err and "phantom" in err for err in errors)
