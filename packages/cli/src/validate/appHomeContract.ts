import fs from "node:fs";
import path from "node:path";

/**
 * Validate user-facing app-home terminology for release readiness. Faithful TS
 * port of the text-surface scanning in scripts/validate_app_home_contract.py.
 *
 * The CLI-surface scanning (running agentera help/output commands) is wired in
 * Phase 7 via the `cliInvoker` option once the TS CLI commands exist.
 */

export const TEXT_SURFACES = [
  "README.md",
  "UPGRADE.md",
  "references/cli/vocabulary.md",
  "plugin.json",
  ".github/plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".opencode/plugins/agentera.js",
  "skills/agentera/SKILL.md",
  "skills/agentera/capabilities/hej/instructions.md",
  "skills/agentera/references/contract.md",
] as const;

export const CLI_HELP_COMMANDS: string[][] = [
  ["--help"],
  ["hej", "--help"],
  ["doctor", "--help"],
  ["upgrade", "--help"],
];

export const CLI_OUTPUT_COMMANDS: string[][] = [
  ["hej"],
  ["hej", "--format", "json"],
  ["doctor", "--json"],
  ["upgrade", "--only", "bundle", "--dry-run"],
  ["upgrade", "--only", "bundle", "--dry-run", "--json"],
  ["upgrade", "--only", "runtime", "--runtime", "claude", "--dry-run"],
];

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bbundle[- ]root\b/i, "bundle-root wording"],
  [/\blive bundle\b/i, "live-bundle wording"],
  [/\bdurable bundle\b.*\bAGENTERA_HOME\b/i, "durable bundle named as AGENTERA_HOME"],
  [/\bAGENTERA_HOME\b.*\bdurable bundle\b/i, "AGENTERA_HOME named as durable bundle"],
  [/\bAGENTERA_HOME\b.*\binstall root\b/i, "AGENTERA_HOME named as install root"],
  [/\binstall root\b.*\bAGENTERA_HOME\b/i, "install root named as AGENTERA_HOME"],
  [/\bdefault durable root\b/i, "default durable root wording"],
];

const RECOVERY_FORBIDDEN: Array<[RegExp, string]> = [
  [/\bAgentera-managed\b/i, "jargon in recovery wording"],
  [/\bunmanaged (?:user-owned )?directory\b/i, "jargon in recovery wording"],
  [/\bdeprecated default\b/i, "jargon in recovery wording"],
  [/\bplatform app-home recovery\b/i, "jargon in recovery wording"],
  [/\bdry-run preview\b/i, "jargon in recovery wording"],
  [/\bbundle install\b/i, "jargon in recovery wording"],
  [/\bmanaged app refresh\b/i, "jargon in recovery wording"],
  [/\binstalled Agentera app is stale\b/i, "jargon in recovery wording"],
  [/\bdurable Agentera bundle\b/i, "jargon in recovery wording"],
  [/\bapp home exists but is not\b/i, "jargon in recovery wording"],
  [/\buse --force only after reviewing\b/i, "jargon in recovery wording"],
  [/\bUse platform home\b/i, "jargon in recovery wording"],
  [/\bForce deprecated home\b/i, "jargon in recovery wording"],
];

const INSTALL_ROOT_LABEL_RE = /\binstall root:/i;

export function isPlainLanguageRuleLine(line: string): boolean {
  const lowered = line.toLowerCase();
  return [
    "never ask the user",
    "bad labels",
    "avoid these prompt labels",
    "jargon in recovery wording",
  ].some((marker) => lowered.includes(marker));
}

/** Mirror Python str.splitlines(): split on line boundaries, no trailing empty. */
function splitLines(text: string): string[] {
  const parts = text.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "" && /[\r\n]$/.test(text)) {
    parts.pop();
  }
  return parts;
}

export function checkText(surface: string, text: string): string[] {
  const errors: string[] = [];
  splitLines(text).forEach((line, idx) => {
    const number = idx + 1;
    for (const [pattern, reason] of FORBIDDEN) {
      if (pattern.test(line)) {
        errors.push(`${surface}:${number}: ${reason}: ${line.trim()}`);
      }
    }
    if (!isPlainLanguageRuleLine(line)) {
      for (const [pattern, reason] of RECOVERY_FORBIDDEN) {
        if (pattern.test(line)) {
          errors.push(`${surface}:${number}: ${reason}: ${line.trim()}`);
        }
      }
    }
    if (surface.startsWith("agentera ")) {
      if (INSTALL_ROOT_LABEL_RE.test(line)) {
        errors.push(`${surface}:${number}: CLI output names app home as install root: ${line.trim()}`);
      }
      if (line.includes("installRoot")) {
        errors.push(
          `${surface}:${number}: public JSON exposes installRoot instead of appHome: ${line.trim()}`,
        );
      }
    }
  });
  return errors;
}

function readSurface(root: string, relative: string): [string, string] | null {
  const p = path.join(root, relative);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    return null;
  }
  return [relative, fs.readFileSync(p, "utf8")];
}

export type CliInvoker = (
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
) => { stdout: string; stderr: string; status: number | null };

/**
 * Run the help/output CLI surfaces through the provided invoker, returning
 * (label, combined-output) tuples mirroring the Python helper.
 */
export function cliSurfaces(root: string, invoke: CliInvoker, tmpProject: string): Array<[string, string]> {
  const surfaces: Array<[string, string]> = [];
  const helpEnv = { ...process.env, AGENTERA_HOME: root };
  for (const args of CLI_HELP_COMMANDS) {
    const result = invoke(args, { cwd: root, env: helpEnv });
    const label = "agentera " + args.join(" ");
    surfaces.push([label, result.stdout + result.stderr]);
    if (result.status !== 0) {
      surfaces.push([label, `help command exited ${result.status}`]);
    }
  }
  const outEnv = { ...process.env, AGENTERA_HOME: root, AGENTERA_BOOTSTRAP_SOURCE_ROOT: root };
  for (const args of CLI_OUTPUT_COMMANDS) {
    const result = invoke(args, { cwd: tmpProject, env: outEnv });
    surfaces.push(["agentera " + args.join(" "), result.stdout + result.stderr]);
  }
  return surfaces;
}

export interface ValidateOptions {
  /** Optional CLI invoker; when provided, help/output surfaces are scanned too. */
  cliInvoker?: CliInvoker;
  /** Temp project dir used as cwd for output commands (required with cliInvoker). */
  tmpProject?: string;
}

export function validate(root: string, opts: ValidateOptions = {}): string[] {
  const errors: string[] = [];
  for (const relative of TEXT_SURFACES) {
    const surface = readSurface(root, relative);
    if (surface === null) {
      continue;
    }
    errors.push(...checkText(surface[0], surface[1]));
  }
  if (opts.cliInvoker && opts.tmpProject) {
    for (const [surface, text] of cliSurfaces(root, opts.cliInvoker, opts.tmpProject)) {
      errors.push(...checkText(surface, text));
    }
  }
  return errors;
}
