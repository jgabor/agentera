import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pathExists, resolvePath } from "../core/paths.js";
import { SETUP_EVIDENCE, classifyResolvedRoot } from "../state/installRoot.js";

/**
 * Diagnose Copilot app-context setup without editing shell startup files.
 * Faithful TS port of scripts/setup_copilot.py. Diagnostic-only: never writes
 * rc files. env/home/output are injectable for deterministic testing.
 */

type Env = Record<string, string | undefined>;

export const CANONICAL_ENTRIES = SETUP_EVIDENCE;
export const MANAGED_KEY = "AGENTERA_HOME";
export const MARKER_COMMENT = `# agentera: ${MANAGED_KEY} (managed)`;
const ENV_FALLBACKS = ["AGENTERA_HOME", "CLAUDE_PLUGIN_ROOT"] as const;

const SHELL_TABLE: Record<string, ["bashrc" | "zshrc" | "fish", string]> = {
  bash: ["bashrc", "export"],
  zsh: ["zshrc", "export"],
  fish: ["fish", "fish"],
};

export class InstallRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallRootError";
  }
}

export class UnsupportedShellError extends Error {
  shellName: string;
  constructor(shellName: string) {
    super(shellName);
    this.name = "UnsupportedShellError";
    this.shellName = shellName;
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

export interface ShellTarget {
  name: string;
  rcPath: string;
  syntax: string;
}

function rcPathFor(kind: "bashrc" | "zshrc" | "fish", home: string): string {
  if (kind === "bashrc") return path.join(home, ".bashrc");
  if (kind === "zshrc") return path.join(home, ".zshrc");
  return path.join(home, ".config", "fish", "config.fish");
}

export function detectShell(env: Env, home: string): ShellTarget {
  const shellPath = env.SHELL ?? "";
  const basename = shellPath ? path.basename(shellPath) : "";
  if (basename in SHELL_TABLE) {
    const [rcKind, syntax] = SHELL_TABLE[basename];
    return { name: basename, rcPath: rcPathFor(rcKind, home), syntax };
  }
  throw new UnsupportedShellError(basename || "(unset $SHELL)");
}

export function resolveRcTarget(explicitRc: string | null, env: Env, home: string): ShellTarget {
  if (explicitRc !== null && explicitRc !== undefined) {
    const rcPath = resolvePath(explicitRc);
    const parts = rcPath.split(/[\\/]/);
    const syntax = rcPath.endsWith(".fish") || parts.includes("fish") ? "fish" : "export";
    return { name: "custom", rcPath, syntax };
  }
  return detectShell(env, home);
}

function quoteForShell(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export interface RcState {
  markerPresent: boolean;
  markerIdx: number;
  exportAfterMarker: string;
  bareExportPresent: boolean;
}

export function classifyRc(text: string): RcState {
  if (!text) {
    return { markerPresent: false, markerIdx: -1, exportAfterMarker: "", bareExportPresent: false };
  }
  const lines = text.split(/\r\n|\r|\n/);
  // Python splitlines() drops a trailing empty produced by a final newline.
  if (lines.length > 0 && lines[lines.length - 1] === "" && /[\r\n]$/.test(text)) {
    lines.pop();
  }
  let markerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/\s+$/, "") === MARKER_COMMENT) {
      markerIdx = i;
      break;
    }
  }
  if (markerIdx === -1) {
    return { markerPresent: false, markerIdx: -1, exportAfterMarker: "", bareExportPresent: false };
  }
  let exportAfter = "";
  if (markerIdx + 1 < lines.length) {
    exportAfter = lines[markerIdx + 1].replace(/\s+$/, "");
  }
  const managed = new Set([markerIdx, markerIdx + 1]);
  const bare = lines.some((line, idx) => !managed.has(idx) && line.includes(MANAGED_KEY));
  return { markerPresent: true, markerIdx, exportAfterMarker: exportAfter, bareExportPresent: bare };
}

export interface Outcome {
  action: string;
  newText: string;
  message: string;
  diff: string;
  notice: string;
}

export function planChange(currentText: string | null, installRoot: string): Outcome {
  const unchanged = currentText ?? "";
  const guidance =
    "Copilot app context is diagnostic-only: Agentera will not edit shell " +
    "startup files. For a single command, run " +
    `${MANAGED_KEY}=${quoteForShell(installRoot)} copilot ...`;

  if (currentText === null || currentText === "") {
    return {
      action: "noop",
      newText: unchanged,
      message: guidance,
      diff: "",
      notice: "No shell startup file was found or needed; no persistent shell startup change was made.",
    };
  }

  const state = classifyRc(currentText);
  let notice = "No Agentera shell startup line was detected; no persistent shell startup change was made.";
  if (state.markerPresent) {
    notice =
      "Legacy Agentera shell startup line detected. Agentera will not edit it; " +
      "cleanup is a user-owned manual boundary.";
  }
  return { action: "noop", newText: unchanged, message: guidance, diff: "", notice };
}

function readTextOrNull(p: string): string | null {
  if (!pathExists(p)) {
    return null;
  }
  return fs.readFileSync(p, "utf8");
}

export interface MainOptions {
  env?: Env;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

interface ParsedArgs {
  installRoot: string | null;
  rcFile: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { installRoot: null, rcFile: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--install-root") {
      parsed.installRoot = argv[++i];
    } else if (arg === "--rc-file") {
      parsed.rcFile = argv[++i];
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    }
  }
  return parsed;
}

function printUnsupportedGuidance(shellName: string, err: (line: string) => void): void {
  err(`unsupported shell: ${shellName}`);
  err("Agentera will not edit shell startup files. Pass app context per invocation instead:");
  err(`  ${MANAGED_KEY}=<agentera-directory> copilot ...`);
  err("If you choose to clean up an old rc line, that edit is manual and user-owned.");
}

export function main(argv: string[] = [], opts: MainOptions = {}): number {
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((line: string) => process.stdout.write(line + "\n"));
  const err = opts.err ?? ((line: string) => process.stderr.write(line + "\n"));
  const home = env.HOME ?? os.homedir();
  const args = parseArgs(argv);

  let installRoot: string;
  try {
    installRoot = resolveInstallRoot(args.installRoot, env);
  } catch (exc) {
    if (exc instanceof InstallRootError) {
      err(exc.message);
      return 2;
    }
    throw exc;
  }

  let target: ShellTarget;
  try {
    target = resolveRcTarget(args.rcFile, env, home);
  } catch (exc) {
    if (exc instanceof UnsupportedShellError) {
      printUnsupportedGuidance(exc.shellName, err);
      return 0;
    }
    throw exc;
  }

  out(`target: ${target.rcPath} (shell=${target.name}, syntax=${target.syntax})`);

  let currentText: string | null;
  try {
    currentText = readTextOrNull(target.rcPath);
  } catch (exc) {
    err(`error reading ${target.rcPath}: ${(exc as Error).message}`);
    return 2;
  }

  const outcome = planChange(currentText, installRoot);
  out(outcome.message);
  if (outcome.notice) {
    out(outcome.notice);
  }
  return 0;
}
