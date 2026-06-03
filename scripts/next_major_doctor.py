#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Head-of-output next-major doctor section (authority: references/cli/update-channels.yaml)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from yaml_mapping import load_yaml_mapping_file

UPDATE_CHANNELS_AUTHORITY = Path("references/cli/update-channels.yaml")
NEXT_MAJOR_SECTION_HEADER = "Next major"
NEXT_MAJOR_LINE_CAP = 6
CHANNEL_NAMES = frozenset({"stable", "development"})

V1_NEXT_MAJOR_FALLBACK: dict[str, str] = {
    "concept": "forward_successor_line",
    "current_version": "1.x",
    "current_channel": "stable",
    "channel": "stable",
    "version": "2.x",
    "npm_only_advisory": "",
    "guide_url": "https://github.com/jgabor/agentera/blob/main/UPGRADE.md#recommended-upgrade-v1--v2-stable-channel",
    "preview_command": "npx -y agentera@latest upgrade --dry-run",
    "irreversible_advisory": (
        "Forward migration upgrades artifact format from Markdown to YAML; "
        "review the preview before applying."
    ),
}


def _authority_path(source_root: Path) -> Path:
    candidate = source_root / UPDATE_CHANNELS_AUTHORITY
    if candidate.exists():
        return candidate
    return Path(__file__).resolve().parents[1] / UPDATE_CHANNELS_AUTHORITY


def load_update_channels_authority(source_root: Path) -> dict[str, Any]:
    return load_yaml_mapping_file(_authority_path(source_root))


def _parse_next_major_block(raw: Any) -> dict[str, str] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        return None
    channel = str(raw.get("channel", "")).strip().lower()
    if channel not in CHANNEL_NAMES:
        return None
    version = str(raw.get("version", "")).strip()
    if not version:
        return None
    guide_url = str(raw.get("guide_url", "")).strip()
    preview_command = str(raw.get("preview_command", "")).strip()
    irreversible_advisory = str(raw.get("irreversible_advisory", "")).strip()
    if not guide_url or not preview_command or not irreversible_advisory:
        return None
    return {
        "concept": str(raw.get("concept", "forward_successor_line")).strip(),
        "channel": channel,
        "version": version,
        "npm_only_advisory": str(raw.get("npm_only_advisory", "")).strip(),
        "guide_url": guide_url,
        "preview_command": preview_command,
        "irreversible_advisory": irreversible_advisory,
    }


def load_channel_next_major(source_root: Path, channel: str) -> dict[str, str] | None:
    authority = load_update_channels_authority(source_root)
    channels = authority.get("channels")
    if not isinstance(channels, dict):
        return None
    entry = channels.get(channel)
    if not isinstance(entry, dict):
        return None
    return _parse_next_major_block(entry.get("next_major"))


def format_next_major_doctor_lines(
    *,
    current_version: str,
    current_channel: str,
    block: dict[str, str],
) -> list[str]:
    next_line = (
        f"Next: {block['version']} ({block['channel']} channel). {block['npm_only_advisory']}"
        if block.get("npm_only_advisory")
        else f"Next: {block['version']} ({block['channel']} channel)"
    )
    return [
        NEXT_MAJOR_SECTION_HEADER,
        f"Current: {current_version} ({current_channel} channel)",
        next_line,
        f"Guide: {block['guide_url']}",
        f"Preview: {block['preview_command']}",
        block["irreversible_advisory"],
    ]


def _running_distribution_major(running_version: str | None) -> int:
    if not running_version:
        return 2
    head = running_version.strip().split(".", 1)[0]
    if head.isdigit():
        return int(head)
    return 2


def resolve_next_major_doctor_lines(
    *,
    source_root: Path,
    channel: str = "stable",
    running_version: str | None = None,
    running_distribution_major: int | None = None,
) -> list[str] | None:
    current_channel = channel if channel in CHANNEL_NAMES else "stable"
    major = running_distribution_major if running_distribution_major is not None else _running_distribution_major(
        running_version
    )

    if major == 1:
        block = {**V1_NEXT_MAJOR_FALLBACK}
        return format_next_major_doctor_lines(
            current_version=block["current_version"],
            current_channel=block["current_channel"],
            block=block,
        )

    authority_block = load_channel_next_major(source_root, current_channel)
    if not authority_block:
        return None

    current_version = running_version or f"{major}.x"
    return format_next_major_doctor_lines(
        current_version=current_version,
        current_channel=current_channel,
        block=authority_block,
    )


def prepend_next_major_doctor_section(text: str, section_lines: list[str] | None) -> str:
    if not section_lines:
        return text
    return "\n".join(section_lines) + "\n\n" + text
