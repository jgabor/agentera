# Plan: Plugin-Bootstrap opencode Commands

<!-- Level: light | Created: 2026-04-23 | Status: complete | Shipped: 2026-04-23 (cycle 121, commit 307aa33) -->

## What

Embed the 12 skill command templates in the opencode plugin so they bootstrap to `~/.config/opencode/commands/` on first session load. Users installing the agentera plugin (globally or via npm) get `/hej`, `/planera`, etc. automatically available in every project.

## Why

The 12 command markdown files in `.opencode/commands/` work only inside the agentera repo. When the plugin is installed elsewhere, commands don't travel with it. opencode's plugin API has no command registration mechanism — commands must exist as files on disk or entries in `opencode.json`. The only viable path is plugin-side filesystem bootstrapping.

## Constraints

- Don't modify the 12 SKILL.md files (platform-agnostic by design)
- Don't break existing plugin functionality (session preload, artifact validation, idle logging)
- Commands must work identically whether loaded from `.opencode/commands/` (dev) or `~/.config/opencode/commands/` (installed)
- Don't overwrite user-created commands with the same names (collision safety)
- The version marker must enable clean updates when agentera is upgraded

## Acceptance Criteria

▸ GIVEN the agentera plugin is installed via opencode.json plugin array WHEN a new session starts in any project THEN all 12 skill commands appear in the command palette

▸ GIVEN the plugin initializes for the first time WHEN no agentera commands exist in the global commands dir THEN the plugin writes all 12 command markdown files and a version marker

▸ GIVEN the plugin previously installed commands at version X WHEN the plugin is updated to version Y THEN command files are refreshed to match the new templates

▸ GIVEN a user has a custom command named hej.md in the global commands dir WHEN the plugin bootstraps THEN the existing file is NOT overwritten

▸ GIVEN a user types /hej in any project WHEN the agentera plugin is installed globally THEN the hej skill loads via the skill tool
