#!/usr/bin/env python3
"""Validate runtime lifecycle hook adapter metadata.

The check is intentionally small: Task 5 owns full test coverage. This helper
keeps unsupported lifecycle behavior reportable as soon as adapter metadata
exists.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]

COPILOT_EVENTS = {"sessionStart", "postToolUse", "sessionEnd"}
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
CODEX_PROFILERA_STATUS_VALUES = ("ok", "degraded")
CODEX_PROFILERA_INVOCATION_TERMS = ("$profilera", "limited", "Section 22", "source families")


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

        for path in sorted(hook_dir.glob("*.json")):
            hook = _load_json(path)
            event = hook.get("name")
            if not isinstance(event, str):
                errors.append(f"copilot.{path.name}: hook name must be a string")
                continue
            if event not in COPILOT_EVENTS:
                errors.append(f"copilot: unsupported lifecycle event configured: {event}")
                continue
            if event != event[:1].lower() + event[1:]:
                errors.append(f"copilot: event must be lower-camel: {event}")
            _validate_command_handler(errors, "copilot", event, 0, hook)

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
    profilera = next(
        (skill for skill in plugin.get("skillMetadata", []) if isinstance(skill, dict) and skill.get("name") == "profilera"),
        None,
    )
    if not isinstance(profilera, dict):
        return ["codex.profilera: missing aggregate skill metadata"]

    if profilera.get("runtimeSupport") != "limited":
        errors.append("codex.profilera: runtimeSupport must stay limited across metadata surfaces")
    if profilera.get("policy", {}).get("allow_implicit_invocation") is not False:
        errors.append("codex.profilera: implicit invocation must stay disabled across metadata surfaces")
    invocation_hint = profilera.get("invocationHint")
    if not isinstance(invocation_hint, str) or any(term not in invocation_hint for term in CODEX_PROFILERA_INVOCATION_TERMS):
        errors.append("codex.profilera: invocation hint must expose limited Section 22 source-family rules")
    capabilities = profilera.get("requiredCapabilities")
    if not isinstance(capabilities, list) or not capabilities:
        errors.append("codex.profilera: requiredCapabilities must declare the corpus capability")
    elif capabilities[0].get("name") != "codex_session_corpus":
        errors.append("codex.profilera: corpus capability must be named codex_session_corpus")
    elif capabilities[0].get("status") not in CODEX_PROFILERA_STATUS_VALUES:
        errors.append(
            "codex.profilera: corpus capability status must be one of "
            + ", ".join(CODEX_PROFILERA_STATUS_VALUES)
        )

    metadata_paths = [root / "agents/openai.yaml", root / "skills/profilera/agents/openai.yaml"]
    for path in metadata_paths:
        if not path.is_file():
            errors.append(f"codex.profilera: missing metadata surface {path.relative_to(root)}")
            continue
        text = path.read_text(encoding="utf-8")
        for term in CODEX_PROFILERA_TERMS:
            if term not in text:
                errors.append(f"codex.profilera: {path.relative_to(root)} missing {term!r}")
        if not any(f"status: {value}" in text for value in CODEX_PROFILERA_STATUS_VALUES):
            errors.append(
                f"codex.profilera: {path.relative_to(root)} missing status declaration "
                "(expected one of " + ", ".join(CODEX_PROFILERA_STATUS_VALUES) + ")"
            )
        if "collector exists" in text or "not implemented" in text:
            errors.append(f"codex.profilera: {path.relative_to(root)} contains stale missing-collector wording")

    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args(argv)

    root = args.root.resolve()
    errors: list[str] = []
    copilot = _load_json(root / "plugin.json")
    errors.extend(validate_copilot(copilot, root))
    errors.extend(validate_copilot_hooks(root, copilot))
    codex = _load_json(root / ".codex-plugin/plugin.json")
    errors.extend(validate_codex(codex))
    errors.extend(validate_codex_profilera_metadata(root, codex))

    if errors:
        print("lifecycle adapter validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print("lifecycle adapter metadata ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
