import { main as evalSkillsMain } from "../../eval/evalSkills.js";
import { main as semanticEvalMain } from "../../eval/semanticEval.js";

type Io = { out?: (t: string) => void; err?: (t: string) => void };
type Dict = Record<string, any>;

export const VERIFY_FAMILIES = ["smoke", "eval"] as const;
export const VERIFY_TARGETS: Record<string, string[]> = {
  smoke: ["installed-skills", "live-hosts", "setup-helpers", "opencode-bootstrap"],
  eval: ["skills", "semantic"],
};
export const VERIFY_FORMATS = ["text", "json"] as const;
export const VERIFY_DIAGNOSTIC_LINE_LIMIT = 20;

export interface VerifyArgs {
  family?: string | null;
  target?: string | null;
  format?: string;
  // smoke
  installedRoot?: string | null;
  realNpx?: boolean;
  live?: boolean;
  yes?: boolean;
  // eval
  run?: boolean;
  dryRun?: boolean;
  skill?: string | null;
  timeout?: number;
  parallel?: number;
  runtime?: string;
  fixtures?: string[];
}

function verifySyntax(): string {
  return "agentera verify <family> <target> [--format text|json] [target options]";
}

function verifyExample(family?: string | null): string {
  if (family === "smoke") return "agentera verify smoke installed-skills --format json";
  if (family === "eval") return "agentera verify eval skills --format json";
  return "agentera verify smoke installed-skills; agentera verify eval skills --format json";
}

/** Faithful port of scripts/agentera `_validate_verify_request`. Throws ValueError-style messages. */
export function validateVerifyRequest(args: VerifyArgs): [string, string, string] {
  const family = String(args.family ?? "");
  const target = String(args.target ?? "");
  const outputFormat = String(args.format ?? "text");
  if (!(VERIFY_FORMATS as readonly string[]).includes(outputFormat)) {
    throw new Error(
      `unsupported verify format '${outputFormat}'; valid formats: ${VERIFY_FORMATS.join(", ")}. ` +
        "Syntax: agentera verify <family> <target> --format text|json [target options]. " +
        `Example: ${verifyExample("smoke")}`,
    );
  }
  if (!(VERIFY_FAMILIES as readonly string[]).includes(family)) {
    throw new Error(
      `unsupported verify family '${family}'; valid families: ${VERIFY_FAMILIES.join(", ")}. ` +
        `Syntax: ${verifySyntax()}. Examples: ${verifyExample()}`,
    );
  }
  const validTargets = VERIFY_TARGETS[family];
  if (!validTargets.includes(target)) {
    throw new Error(
      `unsupported verify target '${target}' for family '${family}'; valid targets: ${validTargets.join(", ")}. ` +
        `Syntax: agentera verify ${family} <target> [--format text|json] [target options]. ` +
        `Example: ${verifyExample(family)}`,
    );
  }
  if (family === "smoke" && target === "live-hosts" && args.live && !args.yes) {
    throw new Error(
      "unsafe live-host verify request requires explicit non-interactive consent. " +
        "Safe default: omit --live to run offline fixture and setup-helper checks only. " +
        "Valid opt-in flags: --live --yes. " +
        "Syntax: agentera verify smoke live-hosts [--live --yes] [--format text|json]. " +
        "Example: agentera verify smoke live-hosts --live --yes --format json",
    );
  }
  if (family === "eval" && target === "skills" && args.run && args.dryRun) {
    throw new Error(
      "unsupported eval skills request combines --run and --dry-run; choose one mode. " +
        "Safe default: omit --run to list the bounded dry-run plan without invoking a runtime. " +
        "Syntax: agentera verify eval skills [--run] [--skill NAME] [--timeout SECONDS] [--parallel N] [--runtime auto|claude|opencode] [--format text|json]. " +
        "Example: agentera verify eval skills --dry-run --format json",
    );
  }
  if (family === "eval" && target === "skills") {
    const runtime = String(args.runtime ?? "auto");
    if (!["auto", "claude", "opencode"].includes(runtime)) {
      throw new Error(
        `unsupported eval skills runtime '${runtime}'; valid runtimes: auto, claude, opencode. ` +
          "Syntax: agentera verify eval skills [--run] [--runtime auto|claude|opencode] [--format text|json]. " +
          "Example: agentera verify eval skills --format json",
      );
    }
    if ((args.parallel ?? 1) < 1 || (args.timeout ?? 120) < 1) {
      throw new Error(
        "eval skills bounds must be positive integers. " +
          "Syntax: agentera verify eval skills [--parallel N] [--timeout SECONDS] [--format text|json]. " +
          "Example: agentera verify eval skills --parallel 1 --timeout 120 --format json",
      );
    }
  }
  if (family === "eval" && target === "semantic" && (args.fixtures ?? []).length === 0) {
    throw new Error(
      "semantic verify requires explicit fixture path(s); broad fixture discovery is not a safe default. " +
        "Valid targets for eval: skills, semantic. " +
        "Syntax: agentera verify eval semantic <fixture> [<fixture>...] [--format text|json]. " +
        "Example: agentera verify eval semantic fixtures/semantic/hej-bare-message.md --format json",
    );
  }
  return [family, target, outputFormat];
}

interface EngineResult {
  command: string[];
  returncode: number;
  stdout: string;
  stderr: string;
}

const SMOKE_UNAVAILABLE =
  "smoke verification is not available in the self-contained agentera package; " +
  "the smoke runners are maintainer tools that run from a source checkout";

/**
 * Resolve the engine command + safety metadata for a verify target. eval engines
 * run in-process (ported TS). smoke engines are maintainer tools absent from the
 * self-contained package, reported as unavailable (engine exit 127), mirroring
 * the Python CLI's "engine not found" behavior.
 */
function runVerifyEngine(family: string, target: string, args: VerifyArgs): { result: EngineResult; safety: Dict } {
  if (family === "eval" && target === "skills") {
    const runtime = String(args.runtime ?? "auto");
    const parallel = String(args.parallel ?? 1);
    const timeout = String(args.timeout ?? 120);
    const engineArgs: string[] = [];
    if (args.skill) engineArgs.push("--skill", args.skill);
    let safety: Dict;
    if (args.run) {
      engineArgs.push("--parallel", parallel, "--timeout", timeout, "--runtime", runtime);
      safety = {
        mode: "explicit-runtime",
        summary: "runtime-backed eval explicitly enabled with --run and bounded timeout/parallel controls",
        live: true,
        long_running_default: false,
      };
    } else {
      // Pin a concrete runtime for safe discovery unless explicitly chosen.
      const dryRunRuntime = runtime !== "auto" ? runtime : "claude";
      engineArgs.push("--parallel", parallel, "--timeout", timeout, "--runtime", dryRunRuntime, "--dry-run");
      safety = {
        mode: "dry-run",
        summary: "default lists skill prompts without invoking Claude Code, OpenCode, or long-running evals",
        live: false,
        long_running_default: false,
      };
    }
    const result = runInProcess(["eval", "skills", ...engineArgs], (out, err) =>
      evalSkillsMain(engineArgs, { out: (l) => out(l + "\n"), err: (l) => err(l + "\n") }),
    );
    return { result, safety };
  }
  if (family === "eval" && target === "semantic") {
    const fixtures = args.fixtures ?? [];
    const safety = {
      mode: "offline-fixtures",
      summary: "requires explicit fixture path(s) and never invokes model runtimes",
      live: false,
      long_running_default: false,
    };
    const result = runInProcess(["eval", "semantic", ...fixtures], (out) =>
      semanticEvalMain(fixtures, (l) => out(l)),
    );
    return { result, safety };
  }
  // smoke family: maintainer runners are not part of the self-contained package.
  const safety = smokeSafety(target, args);
  return {
    result: { command: ["smoke", target], returncode: 127, stdout: "", stderr: SMOKE_UNAVAILABLE },
    safety,
  };
}

function smokeSafety(target: string, args: VerifyArgs): Dict {
  if (target === "installed-skills") {
    let mode = "offline";
    if (args.installedRoot != null) mode = "explicit-installed-root";
    else if (args.realNpx) mode = "explicit-real-npx";
    return {
      mode,
      summary: "default path is offline and credential-free; real npx requires --real-npx",
      live: false,
      mutates_installed_app: false,
    };
  }
  if (target === "live-hosts") {
    if (args.live) {
      return {
        mode: "explicit-live",
        summary: "live host sections explicitly enabled with --live --yes and direct harness timeouts",
        live: true,
        mutates_installed_app: false,
      };
    }
    return {
      mode: "offline",
      summary: "default runs offline fixture, missing-store, setup-helper, and upgrade-repair smoke checks only",
      live: false,
      mutates_installed_app: false,
    };
  }
  if (target === "setup-helpers") {
    return {
      mode: "local-smoke",
      summary: "uses temporary homes/config paths; no installed-app or profile mutation",
      live: false,
      mutates_installed_app: false,
    };
  }
  return {
    mode: "local-smoke",
    summary: "uses temporary OpenCode config paths; no package refresh or profile mutation",
    live: false,
    mutates_installed_app: false,
  };
}

function runInProcess(
  command: string[],
  invoke: (out: (l: string) => void, err: (l: string) => void) => number,
): EngineResult {
  let stdout = "";
  let stderr = "";
  // Verbatim appenders: each engine call site adapts its own newline convention.
  const out = (l: string) => {
    stdout += l;
  };
  const err = (l: string) => {
    stderr += l;
  };
  let rc: number;
  try {
    rc = invoke(out, err);
  } catch (exc) {
    stderr += `${(exc as Error).message}\n`;
    rc = 1;
  }
  return { command: ["node", "agentera", "verify", ...command], returncode: rc, stdout, stderr };
}

function boundedLines(text: string, limit = VERIFY_DIAGNOSTIC_LINE_LIMIT): string[] {
  const lines = text.split("\n");
  // Python str.splitlines() drops a single trailing newline's empty element.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), `... truncated ${lines.length - limit} line(s)`];
}

function verifyStatus(result: EngineResult): string {
  return result.returncode === 0 ? "pass" : "fail";
}

export function buildVerifyPayload(
  family: string,
  target: string,
  outputFormat: string,
  result: EngineResult,
  safety: Dict,
): Dict {
  return {
    command: "verify",
    status: verifyStatus(result),
    family,
    target,
    format: outputFormat,
    engine: { command: result.command, exit_code: result.returncode },
    diagnostics: {
      stdout: boundedLines(result.stdout),
      stderr: boundedLines(result.stderr),
      line_limit: VERIFY_DIAGNOSTIC_LINE_LIMIT,
    },
    safety,
  };
}

function emitVerifyText(payload: Dict, out: (t: string) => void): void {
  const engine = payload.engine;
  const safety = payload.safety;
  out(`verify ${payload.family} ${payload.target}: ${payload.status} (engine_exit=${engine.exit_code})\n`);
  out(`engine=${engine.command.join(" ")}\n`);
  out(`safety=${safety.mode}; ${safety.summary}\n`);
  const stdout = payload.diagnostics.stdout as string[];
  const stderr = payload.diagnostics.stderr as string[];
  if (stdout.length > 0) {
    out("stdout:\n");
    for (const line of stdout) out(`  ${line}\n`);
  }
  if (stderr.length > 0) {
    out("stderr:\n");
    for (const line of stderr) out(`  ${line}\n`);
  }
}

export function cmdVerify(args: VerifyArgs, io: Io = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  let family: string;
  let target: string;
  let outputFormat: string;
  try {
    [family, target, outputFormat] = validateVerifyRequest(args);
  } catch (exc) {
    err(`Error: ${(exc as Error).message}\n`);
    return 2;
  }
  const { result, safety } = runVerifyEngine(family, target, args);
  const payload = buildVerifyPayload(family, target, outputFormat, result, safety);
  if (outputFormat === "json") {
    out(JSON.stringify(payload, null, 2) + "\n");
  } else {
    emitVerifyText(payload, out);
  }
  return result.returncode;
}
