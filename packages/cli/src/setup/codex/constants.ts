import { SETUP_EVIDENCE } from "../../state/installRoot.js";

export const CANONICAL_ENTRIES = SETUP_EVIDENCE;
export const MANAGED_KEY = "AGENTERA_HOME";
export const SECTION_NAME = "shell_environment_policy";
export const DEFAULT_AGENT_LIMITS: Record<string, number> = { max_depth: 1 };
export const CAPABILITY_AGENT_NAMES = [
  "hej",
  "visionera",
  "resonera",
  "inspirera",
  "planera",
  "realisera",
  "optimera",
  "inspektera",
  "dokumentera",
  "profilera",
  "visualisera",
  "orkestrera",
] as const;

export const CODEX_HOOK_COMMAND = "npx -y agentera@next hook validate-artifact";
export const CODEX_PLUGIN_ID = "agentera@agentera";
export const CODEX_PLUGIN_HOOKS_PATH = "hooks/codex-plugin-hooks.json";
export const CODEX_PLUGIN_HOOK_SOURCE = `${CODEX_PLUGIN_ID}:${CODEX_PLUGIN_HOOKS_PATH}`;
export const CODEX_PLUGIN_HOOK_COMMAND = "npx -y agentera@next hook validate-artifact";
export const CODEX_HOOK_MATCHER = "^apply_patch$";
export const CODEX_HOOK_TIMEOUT = 10;
export const CODEX_HOOK_STATUS_MESSAGE = "validating artifact";
export const SET_SUBTABLE_NAME = `${SECTION_NAME}.set`;
