import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { resolveSourceRoot } from "../core/sourceRoot.js";
import type { JsonObject } from "../core/jsonValue.js";

/**
 * Tier 2 eval runner for agentera skill smoke testing. Faithful TS port of
 * scripts/eval_skills.py. Crash/error detection only; output correctness is not
 * evaluated. `which`/`run` are injectable for deterministic testing.
 */

export const TRIGGER_PROMPTS: Record<string, string> = {
  document: "Audit the documentation for this project.",
  status: "Start a new session and give me a status briefing on this project.",
  audit: "Run a codebase health audit.",
  research: "Analyze https://example.com and map patterns to this project.",
  optimize: "Optimize test suite execution time.",
  orchestrate: "Execute the next cycle of the current plan.",
  plan: "Plan the next feature for this project.",
  profile: "Generate a decision profile from session history.",
  build: "Run one autonomous development cycle.",
  discuss: "Deliberate on whether to add a new dependency.",
  vision: "Create a vision document for this project.",
  design: "Create a visual identity system for this project.",
};

export const DEFAULT_TIMEOUT = 120;
export const DEFAULT_PARALLEL = 1;

export class ExitError extends Error {
  code: number;
  constructor(code: number, message = "") {
    super(message);
    this.name = "ExitError";
    this.code = code;
  }
}

export type WhichFn = (name: string) => string | null;
const realWhich: WhichFn = (name) => {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [name], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
};

export function detectRuntime(
  explicit: string | null,
  opts: { which?: WhichFn; err?: (line: string) => void } = {},
): string {
  const which = opts.which ?? realWhich;
  const err = opts.err ?? ((line: string) => process.stderr.write(line + "\n"));
  if (explicit && explicit !== "auto") {
    if (explicit === "cursor-agent") {
      if (which("cursor-agent") === null && which("agent") === null) {
        err(
          "ERROR: 'cursor-agent' not found on PATH. Install Cursor Agent CLI " +
            "and ensure the binary is accessible.",
        );
        throw new ExitError(1);
      }
    }
    return explicit;
  }

  const hasClaude = which("claude") !== null;
  const hasOpencode = which("opencode") !== null;
  const hasCursorAgent = which("cursor-agent") !== null || which("agent") !== null;

  if (hasClaude) return "claude";
  if (hasOpencode) return "opencode";
  if (hasCursorAgent) return "cursor-agent";

  err(
    "ERROR: Neither 'claude', 'opencode', nor 'cursor-agent' found on PATH. " +
      "Install a supported runtime host and ensure the binary is accessible.",
  );
  throw new ExitError(1);
}

export function parseFrontmatterName(text: string): string | null {
  if (!text.startsWith("---")) {
    return null;
  }
  const end = text.indexOf("---", 3);
  if (end === -1) {
    return null;
  }
  const block = text.slice(3, end);
  const m = /^name:\s*(.+)/m.exec(block);
  return m ? m[1].trim() : null;
}

export function discoverSkills(repoRoot: string = resolveSourceRoot()): Array<{ name: string; prompt: string }> {
  const skillsDir = path.join(repoRoot, "skills");
  const entries: Array<{ name: string; prompt: string }> = [];
  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
    return entries;
  }
  const dirs = fs
    .readdirSync(skillsDir)
    .filter((d) => fs.existsSync(path.join(skillsDir, d, "SKILL.md")))
    .sort();
  for (const dir of dirs) {
    const skillMd = path.join(skillsDir, dir, "SKILL.md");
    const text = fs.readFileSync(skillMd, "utf8");
    const name = parseFrontmatterName(text) ?? dir;
    const prompt = TRIGGER_PROMPTS[name] ?? `Invoke the ${name} skill.`;
    entries.push({ name, prompt });
  }
  return entries;
}

export type RunFn = (
  cmd: string[],
  opts: { input?: string | null; timeout: number; cwd: string },
) => { status: number | null; stdout: string; stderr: string; timedOut?: boolean };

const realRun: RunFn = (cmd, opts) => {
  const result = spawnSync(cmd[0], cmd.slice(1), {
    input: opts.input ?? undefined,
    encoding: "utf8",
    timeout: opts.timeout * 1000,
    cwd: opts.cwd,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.signal === "SIGTERM" && result.error !== undefined,
  };
};

export function invokeSkill(
  name: string,
  prompt: string,
  timeout: number,
  runtime = "claude",
  opts: { which?: WhichFn; run?: RunFn; repoRoot?: string } = {},
): JsonObject {
  const which = opts.which ?? realWhich;
  const run = opts.run ?? realRun;
  const repoRoot = opts.repoRoot ?? resolveSourceRoot();

  let cmd: string[];
  let stdinPrompt: string | null;
  if (runtime === "opencode") {
    cmd = ["opencode", "run", "--prompt"];
    stdinPrompt = prompt;
  } else if (runtime === "cursor-agent") {
    const binary = which("cursor-agent") ? "cursor-agent" : "agent";
    cmd = [binary, "-p", "--output-format", "json", "--force", prompt];
    stdinPrompt = null;
  } else {
    cmd = ["claude", "-p", "--output-format", "json"];
    stdinPrompt = prompt;
  }

  const start = Date.now();
  let error: string | null = null;
  let status = "pass";

  const result = run(cmd, { input: stdinPrompt, timeout, cwd: repoRoot });
  const duration = (Date.now() - start) / 1000;

  if (result.timedOut) {
    error = `Timed out after ${timeout}s`;
    status = "fail";
  } else if (result.status !== 0) {
    const stderrSnippet = (result.stderr ?? "").trim().slice(0, 300);
    const stdoutSnippet = (result.stdout ?? "").trim().slice(0, 300);
    const detail = stderrSnippet || stdoutSnippet || "(no output)";
    error = `Exit code ${result.status}: ${detail}`;
    status = "fail";
  } else {
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    const errorIndicators = [
      /\bTraceback \(most recent call last\)\b/i,
      /\bError:\s/i,
      /\bfatal error\b/i,
      /"is_error"\s*:\s*true/i,
    ];
    for (const pattern of errorIndicators) {
      const m = pattern.exec(combined);
      if (m) {
        const snippet = combined.slice(Math.max(0, m.index - 20), m.index + m[0].length + 80).trim();
        error = `Error indicator in output: ${snippet.slice(0, 300)}`;
        status = "fail";
        break;
      }
    }
  }

  return {
    skill: name,
    status,
    duration_s: Math.round(duration * 100) / 100,
    error,
  };
}

export function runSkills(
  skills: Array<{ name: string; prompt: string }>,
  timeout: number,
  _parallel: number,
  runtime = "claude",
  opts: { which?: WhichFn; run?: RunFn; repoRoot?: string } = {},
): JsonObject[] {
  // Parallelism in the Python runner is a maintainer perf detail; the smoke
  // semantics (one result per skill, original order) are preserved sequentially.
  return skills.map((entry) => invokeSkill(entry.name, entry.prompt, timeout, runtime, opts));
}

export function buildReport(results: JsonObject[]): JsonObject {
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.length - passed;
  return {
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    skills_tested: results.length,
    passed,
    failed,
    results,
  };
}

export function buildDryRun(
  skills: Array<{ name: string; prompt: string }>,
  runtime = "claude",
  runtimeSource = "auto-detected",
): JsonObject {
  return {
    mode: "dry-run",
    runtime: `${runtime} (${runtimeSource})`,
    skills: skills.map((s) => ({ name: s.name, prompt: s.prompt })),
  };
}

export interface EvalArgs {
  skill: string | null;
  dry_run: boolean;
  parallel: number;
  timeout: number;
  runtime: string;
}

export interface EvalMainOptions {
  discoverSkills?: () => Array<{ name: string; prompt: string }>;
  detectRuntime?: (explicit: string | null, o: { which?: WhichFn; err?: (line: string) => void }) => string;
  which?: WhichFn;
  run?: RunFn;
  repoRoot?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export function main(argv: string[] = [], opts: EvalMainOptions = {}): number {
  const out = opts.out ?? ((line: string) => process.stdout.write(line + "\n"));
  const err = opts.err ?? ((line: string) => process.stderr.write(line + "\n"));
  const discover = opts.discoverSkills ?? (() => discoverSkills(opts.repoRoot));
  const detect = opts.detectRuntime ?? detectRuntime;
  const args = parseArgs(argv);

  const allSkills = discover();
  if (allSkills.length === 0) {
    err("ERROR: No SKILL.md files found under skills/");
    return 1;
  }

  let skillsToRun = allSkills;
  if (args.skill) {
    const matched = allSkills.filter((s) => s.name === args.skill);
    if (matched.length === 0) {
      const known = allSkills.map((s) => s.name).join(", ");
      err(`ERROR: Unknown skill '${args.skill}'. Known skills: ${known}`);
      return 1;
    }
    skillsToRun = matched;
  }

  const explicit = args.runtime !== "auto" ? args.runtime : null;
  let runtime: string;
  try {
    runtime = detect(explicit, { which: opts.which, err });
  } catch (exc) {
    if (exc instanceof ExitError) {
      return exc.code;
    }
    throw exc;
  }
  const runtimeSource = explicit ? "--runtime flag" : "auto-detected";

  if (args.dry_run) {
    out(JSON.stringify(buildDryRun(skillsToRun, runtime, runtimeSource), null, 2));
    return 0;
  }

  const results = runSkills(skillsToRun, args.timeout, args.parallel, runtime, {
    which: opts.which,
    run: opts.run,
    repoRoot: opts.repoRoot,
  });
  const report = buildReport(results);
  out(JSON.stringify(report, null, 2));
  return report.failed === 0 ? 0 : 1;
}

export function parseArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = {
    skill: null,
    dry_run: false,
    parallel: DEFAULT_PARALLEL,
    timeout: DEFAULT_TIMEOUT,
    runtime: "auto",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skill") args.skill = argv[++i];
    else if (arg === "--dry-run") args.dry_run = true;
    else if (arg === "--parallel") args.parallel = parseInt(argv[++i], 10);
    else if (arg === "--timeout") args.timeout = parseInt(argv[++i], 10);
    else if (arg === "--runtime") args.runtime = argv[++i];
  }
  return args;
}
