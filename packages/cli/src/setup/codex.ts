import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { isFile, pathExists, resolvePath } from "../core/paths.js";
import { parseToml } from "../core/toml.js";
import { SETUP_EVIDENCE, classifyResolvedRoot } from "../state/installRoot.js";

/**
 * Idempotently inject AGENTERA_HOME into Codex's shell-tool environment.
 * Faithful TS port of scripts/setup_codex.py (slice 1: install-root resolution,
 * TOML classification/emission/render, Codex hook trust-hash). The line-based
 * config mutation + plan/apply + CLI land in subsequent slices.
 *
 * NOTE: CODEX_HOOK_COMMAND uses the current uv-run form; the node-form rewiring
 * happens in the Phase 9 cutover.
 */

type Dict = Record<string, any>;
type Env = Record<string, string | undefined>;

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
const ENV_FALLBACKS = ["AGENTERA_HOME", "CLAUDE_PLUGIN_ROOT"] as const;

export const CODEX_HOOK_COMMAND = 'uv run "${AGENTERA_HOME}/hooks/validate_artifact.py"';
export const CODEX_PLUGIN_ID = "agentera@agentera";
export const CODEX_PLUGIN_HOOKS_PATH = "hooks/codex-plugin-hooks.json";
export const CODEX_PLUGIN_HOOK_SOURCE = `${CODEX_PLUGIN_ID}:${CODEX_PLUGIN_HOOKS_PATH}`;
export const CODEX_PLUGIN_HOOK_COMMAND = 'uv run "${PLUGIN_ROOT}/hooks/validate_artifact.py"';
export const CODEX_HOOK_MATCHER = "^apply_patch$";
export const CODEX_HOOK_TIMEOUT = 10;
export const CODEX_HOOK_STATUS_MESSAGE = "validating artifact";

export function defaultConfigPath(home: string = os.homedir()): string {
  return path.join(home, ".codex", "config.toml");
}

export class InstallRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallRootError";
  }
}

export function verifyInstallRoot(root: string): string[] {
  const classification = classifyResolvedRoot(root, { source: "explicit" });
  if (classification.kind === "managed_fresh") {
    return [];
  }
  return SETUP_EVIDENCE.filter((entry) => !pathExists(path.join(root, entry)));
}

export function autoDetectInstallRoot(start: string | null = null, env: Env = process.env): string | null {
  for (const variable of ENV_FALLBACKS) {
    const candidate = env[variable];
    if (candidate) {
      const p = resolvePath(candidate);
      if (verifyInstallRoot(p).length === 0) {
        return p;
      }
    }
  }
  let current = resolvePath(start === null ? process.cwd() : start);
  for (;;) {
    if (verifyInstallRoot(current).length === 0) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveInstallRoot(explicit: string | null, env: Env = process.env): string {
  if (explicit !== null && explicit !== undefined) {
    const root = resolvePath(explicit);
    if (classifyResolvedRoot(root, { source: "explicit" }).kind !== "managed_fresh") {
      const missing = verifyInstallRoot(root);
      throw new InstallRootError(
        `--install-root ${root} is not a valid Agentera directory: ` +
          `missing canonical entries: ${missing.join(", ")}`,
      );
    }
    return root;
  }
  const detected = autoDetectInstallRoot(null, env);
  if (detected === null) {
    throw new InstallRootError(
      "could not auto-detect the Agentera directory. " +
        "Pass --install-root PATH where PATH contains " +
        `${CANONICAL_ENTRIES.join(", ")}.`,
    );
  }
  return detected;
}

// ── TOML state classification ──────────────────────────────────────

export interface TomlState {
  sectionPresent: boolean;
  setPresent: boolean;
  setTable: Record<string, string>;
}

/** Python repr() for a scalar, used to display non-string sibling set values. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") {
    return value.includes("'") && !value.includes('"') ? `"${value}"` : `'${value}'`;
  }
  return String(value);
}

export function classifyToml(text: string): TomlState {
  if (!text.trim()) {
    return { sectionPresent: false, setPresent: false, setTable: {} };
  }
  const parsed = parseToml(text) as Dict;
  const section = parsed[SECTION_NAME];
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { sectionPresent: false, setPresent: false, setTable: {} };
  }
  const setValue = (section as Dict).set;
  if (!setValue || typeof setValue !== "object" || Array.isArray(setValue)) {
    return { sectionPresent: true, setPresent: false, setTable: {} };
  }
  const coerced: Record<string, string> = {};
  for (const [key, value] of Object.entries(setValue)) {
    coerced[String(key)] = typeof value === "string" ? value : pyRepr(value);
  }
  return { sectionPresent: true, setPresent: true, setTable: coerced };
}

// ── TOML emission ──────────────────────────────────────────────────

const BASIC_STRING_ESCAPE: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

export function tomlBasicString(value: string): string {
  const escapedChars: string[] = [];
  for (const char of value) {
    if (char in BASIC_STRING_ESCAPE) {
      escapedChars.push(BASIC_STRING_ESCAPE[char]);
    } else if (char.charCodeAt(0) < 0x20) {
      escapedChars.push("\\u" + char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"));
    } else {
      escapedChars.push(char);
    }
  }
  return '"' + escapedChars.join("") + '"';
}

export function emitSetInlineTable(pairs: Record<string, string>): string {
  const entries = Object.entries(pairs);
  const rendered = entries.map(([key, value]) => `${key} = ${tomlBasicString(value)}`).join(", ");
  return entries.length > 0 ? `{ ${rendered} }` : "{ }";
}

export function renderAgentsConfigSection(): string {
  return "[agents]\n" + Object.entries(DEFAULT_AGENT_LIMITS).map(([k, v]) => `${k} = ${v}`).join("\n") + "\n";
}

export function renderFreshConfig(installRoot: string): string {
  const setValue = emitSetInlineTable({ [MANAGED_KEY]: installRoot });
  return (
    `[${SECTION_NAME}]\nset = ${setValue}\n\n` +
    `${renderAgentsConfigSection()}\n` +
    `[features.multi_agent_v2]\n` +
    `max_concurrent_threads_per_session = 6\n`
  );
}

// ── Codex hook trust hashing ───────────────────────────────────────

/** Compact canonical JSON: sort_keys=True, separators=(",",":"), ensure_ascii. */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return jsonStringAscii(value);
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value as Dict).sort();
    return "{" + keys.map((k) => `${jsonStringAscii(k)}:${canonicalJson((value as Dict)[k])}`).join(",") + "}";
  }
  return "null";
}

function jsonStringAscii(str: string): string {
  let out = '"';
  for (const ch of str) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (cp === 0x08) out += "\\b";
    else if (cp === 0x09) out += "\\t";
    else if (cp === 0x0a) out += "\\n";
    else if (cp === 0x0c) out += "\\f";
    else if (cp === 0x0d) out += "\\r";
    else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
    else if (cp < 0x80) out += ch;
    else if (cp > 0xffff) {
      const v = cp - 0x10000;
      out += "\\u" + (0xd800 + (v >> 10)).toString(16).padStart(4, "0");
      out += "\\u" + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, "0");
    } else {
      out += "\\u" + cp.toString(16).padStart(4, "0");
    }
  }
  return out + '"';
}

export function codexHookTrustedHash(
  eventLabel: string,
  matcher: string | null,
  command: string = CODEX_HOOK_COMMAND,
  timeout: number = CODEX_HOOK_TIMEOUT,
  statusMessage: string | null = CODEX_HOOK_STATUS_MESSAGE,
): string {
  const handler: Dict = { type: "command", command, timeout, async: false };
  if (statusMessage !== null) handler.statusMessage = statusMessage;
  const identity: Dict = { event_name: eventLabel, hooks: [handler] };
  if (matcher !== null) identity.matcher = matcher;
  const payload = canonicalJson(identity);
  return "sha256:" + crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

export function codexValidatorCommand(installRoot: string): string {
  const candidates = [
    path.join(installRoot, "app", "hooks", "validate_artifact.py"),
    path.join(installRoot, "hooks", "validate_artifact.py"),
  ];
  const validator = candidates.find((c) => isFile(c)) ?? candidates[0];
  return `uv run "${validator}"`;
}

export function renderCodexHooksConfig(command: string): string {
  const hooks: Dict = {};
  for (const event of ["PreToolUse", "PostToolUse"]) {
    hooks[event] = [
      {
        matcher: CODEX_HOOK_MATCHER,
        hooks: [
          { type: "command", command, timeout: CODEX_HOOK_TIMEOUT, statusMessage: CODEX_HOOK_STATUS_MESSAGE },
        ],
      },
    ];
  }
  const payload = {
    description: "agentera v2 Codex hooks: schema-backed apply_patch artifact validation",
    hooks,
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

export function codexHookStateEntries(hooksPath: string, command: string = CODEX_HOOK_COMMAND): Record<string, string> {
  const resolved = resolvePath(hooksPath);
  return {
    [`${resolved}:pre_tool_use:0:0`]: codexHookTrustedHash("pre_tool_use", CODEX_HOOK_MATCHER, command),
    [`${resolved}:post_tool_use:0:0`]: codexHookTrustedHash("post_tool_use", CODEX_HOOK_MATCHER, command),
  };
}

export function codexPluginHookStateEntries(command: string = CODEX_PLUGIN_HOOK_COMMAND): Record<string, string> {
  return {
    [`${CODEX_PLUGIN_HOOK_SOURCE}:pre_tool_use:0:0`]: codexHookTrustedHash("pre_tool_use", CODEX_HOOK_MATCHER, command),
    [`${CODEX_PLUGIN_HOOK_SOURCE}:post_tool_use:0:0`]: codexHookTrustedHash("post_tool_use", CODEX_HOOK_MATCHER, command),
  };
}

export function codexPluginHooksEnabled(text: string | null): boolean {
  if (!text || !text.trim()) return false;
  const parsed = parseToml(text) as Dict;
  const plugins = parsed.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return false;
  const agentera = (plugins as Dict)[CODEX_PLUGIN_ID];
  return Boolean(agentera && typeof agentera === "object" && agentera.enabled === true);
}
