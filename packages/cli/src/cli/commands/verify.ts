import { main as evalSkillsMain } from "../../eval/evalSkills.js";
import { main as semanticEvalMain } from "../../eval/semanticEval.js";
import { runGlossaryEvaluationProcess } from "../../eval/glossaryEvaluationProcess.js";
import { validateGlossaryEvaluationSuccessReport, type GlossaryEvaluationSuccessReport } from "../../eval/glossaryEvaluationSuccessReport.js";
import { evaluateHybridRoute } from "../../eval/hybridRouteEvaluation.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { routeEvaluationExitCode } from "./route.js";
import { emitInvalidInput } from "../errors.js";

type Io = { out?: (t: string) => void; err?: (t: string) => void };

export const VERIFY_FAMILIES = ["eval"] as const;
export const RETIRED_VERIFY_FAMILIES = ["smoke"] as const;
export const VERIFY_TARGETS: Record<string, string[]> = {
  eval: ["skills", "semantic", "routing", "glossary"],
};
export const VERIFY_FORMATS = ["text", "json"] as const;
export const VERIFY_DIAGNOSTIC_LINE_LIMIT = 20;

// Locally-typed payload shape for the verify command output (typed construction;
// the canonical JsonObject remains the single JSON-shape source of truth).
interface VerifyPayload {
  command: string;
  status: string;
  family: string;
  target: string;
  format: string;
  engine: { command: string[]; exit_code: number };
  diagnostics: { stdout: string[]; stderr: string[]; line_limit: number };
  safety: JsonObject;
  glossary_evaluation?: GlossaryEvaluationPublicResult;
}

type GlossaryEvaluationPublicResult = GlossaryEvaluationSuccessReport;

export interface VerifyArgs {
  family?: string | null;
  target?: string | null;
  format?: string;
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
  if (family === "eval") return "agentera verify eval skills";
  return "agentera verify eval skills";
}

/** Faithful port of scripts/agentera `_validate_verify_request`. Throws ValueError-style messages. */
export function validateVerifyRequest(args: VerifyArgs): [string, string, string] {
  const family = String(args.family ?? "");
  const target = String(args.target ?? "");
  const outputFormat = String(args.format ?? "text");
  if (!(VERIFY_FORMATS as readonly string[]).includes(outputFormat)) {
    throw new Error(`unsupported verify format '${outputFormat}'; valid formats: ${VERIFY_FORMATS.join(", ")}. ` + "Syntax: agentera verify <family> <target> --format text|json [target options]. " + `Example: ${verifyExample("eval")}`);
  }
  if ((RETIRED_VERIFY_FAMILIES as readonly string[]).includes(family)) {
    throw new Error(
      `verify smoke is retired on the npm self-contained CLI; use \`agentera check verify eval skills\` ` + "for bounded eval gates, or run smoke maintainer harnesses on the stable Python line with " + "`uvx --from git+https://github.com/jgabor/agentera@main agentera check verify smoke installed-skills`.",
    );
  }
  if (!(VERIFY_FAMILIES as readonly string[]).includes(family)) {
    throw new Error(`unsupported verify family '${family}'; valid families: ${VERIFY_FAMILIES.join(", ")}. ` + `Syntax: ${verifySyntax()}. Examples: ${verifyExample()}`);
  }
  const validTargets = VERIFY_TARGETS[family];
  if (!validTargets.includes(target)) {
    throw new Error(`unsupported verify target '${target}' for family '${family}'; valid targets: ${validTargets.join(", ")}. ` + `Syntax: agentera verify ${family} <target> [--format text|json] [target options]. ` + `Example: ${verifyExample(family)}`);
  }
  if (family === "eval" && target === "skills" && args.run && args.dryRun) {
    throw new Error(
      "unsupported eval skills request combines --run and --dry-run; choose one mode. " +
        "Safe default: omit --run to list the bounded dry-run plan without invoking a runtime. " +
        "Syntax: agentera verify eval skills [--run] [--skill NAME] [--timeout SECONDS] [--parallel N] [--runtime auto|opencode|cursor] [--format text|json]. " +
        "Example: agentera verify eval skills --dry-run",
    );
  }
  if (family === "eval" && target === "skills") {
    const runtime = String(args.runtime ?? "auto");
    if (!["auto", "opencode", "cursor"].includes(runtime)) {
      throw new Error(`unsupported eval skills runtime '${runtime}'; valid runtimes: auto, opencode, cursor. ` + "Syntax: agentera verify eval skills [--run] [--runtime auto|opencode|cursor] [--format text|json]. " + "Example: agentera verify eval skills");
    }
    if ((args.parallel ?? 1) < 1 || (args.timeout ?? 120) < 1) {
      throw new Error("eval skills bounds must be positive integers. " + "Syntax: agentera verify eval skills [--parallel N] [--timeout SECONDS] [--format text|json]. " + "Example: agentera verify eval skills --parallel 1 --timeout 120");
    }
  }
  if (family === "eval" && target === "semantic" && (args.fixtures ?? []).length === 0) {
    throw new Error(
      "semantic verify requires explicit fixture path(s); broad fixture discovery is not a safe default. " +
        "Valid targets for eval: skills, semantic, routing, glossary. " +
        "Syntax: agentera verify eval semantic <fixture> [<fixture>...] [--format text|json]. " +
        "Example: agentera verify eval semantic fixtures/semantic/bare-agentera-message.md",
    );
  }
  if (family === "eval" && target === "glossary" && (args.fixtures ?? []).length > 0) {
    throw new Error("glossary verify uses the contract-owned frozen holdout and accepts no fixture path. " + "It always runs current product behavior. Syntax: agentera check verify eval glossary --format text|json.");
  }
  return [family, target, outputFormat];
}

interface EngineResult {
  command: string[];
  returncode: number;
  stdout: string;
  stderr: string;
}

/**
 * Resolve the engine command + safety metadata for a verify target. The frozen
 * glossary evaluator runs in its isolated process so unrelated CLI starts do
 * not load its mining graph. Only the eval family is supported; the smoke
 * family (maintainer/CI harnesses) was retired in the self-contained package.
 */
function runVerifyEngine(family: string, target: string, args: VerifyArgs): { result: EngineResult; safety: JsonObject } {
  if (family === "eval" && target === "skills") {
    const runtime = String(args.runtime ?? "auto");
    const parallel = String(args.parallel ?? 1);
    const timeout = String(args.timeout ?? 120);
    const engineArgs: string[] = [];
    if (args.skill) engineArgs.push("--skill", args.skill);
    let safety: JsonObject;
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
      const dryRunRuntime = runtime !== "auto" ? runtime : "opencode";
      engineArgs.push("--parallel", parallel, "--timeout", timeout, "--runtime", dryRunRuntime, "--dry-run");
      safety = {
        mode: "dry-run",
        summary: "default lists skill prompts without invoking OpenCode, Cursor, or long-running evals",
        live: false,
        long_running_default: false,
      };
    }
    const result = runInProcess(["eval", "skills", ...engineArgs], (out, err) => evalSkillsMain(engineArgs, { out: (l) => out(l + "\n"), err: (l) => err(l + "\n") }));
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
    const result = runInProcess(["eval", "semantic", ...fixtures], (out) => semanticEvalMain(fixtures, (l) => out(l)));
    return { result, safety };
  }
  if (family === "eval" && target === "glossary") {
    const safety = {
      mode: "offline-frozen-holdout",
      summary: "runs frozen synthetic inputs through current glossary discovery, classification, and V2 decision seams without a semantic host or user-local effects",
      live: false,
      long_running_default: false,
    };
    const evaluation = runGlossaryEvaluationProcess();
    const result = {
      command: ["node", "agentera", "verify", "eval", "glossary"],
      returncode: evaluation.returncode,
      stdout: evaluation.stdout,
      stderr: evaluation.stderr,
    };
    return { result, safety };
  }
  if (family === "eval" && target === "routing") {
    const safety = {
      mode: "offline-frozen-corpus",
      summary: "runs the contract-owned frozen synthetic corpus only; it never sends requests or invokes a semantic host",
      live: false,
      long_running_default: false,
    };
    const result = runInProcess(["eval", "routing"], (out) => {
      const report = evaluateHybridRoute();
      out(JSON.stringify(report, null, 2) + "\n");
      return routeEvaluationExitCode(report);
    });
    return { result, safety };
  }
  throw new Error(`unhandled verify target ${family}/${target}`);
}

function runInProcess(command: string[], invoke: (out: (l: string) => void, err: (l: string) => void) => number): EngineResult {
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

function publicVerifyResult(family: string, target: string, result: EngineResult): { result: EngineResult; glossaryEvaluation?: GlossaryEvaluationPublicResult } {
  if (family !== "eval" || target !== "glossary" || result.returncode !== 0) return { result };
  const glossaryEvaluation = validateGlossaryEvaluationSuccessReport(result);
  if (glossaryEvaluation !== null) return { result, glossaryEvaluation };
  const separator = result.stderr === "" || result.stderr.endsWith("\n") ? "" : "\n";
  return {
    result: {
      ...result,
      returncode: 1,
      stderr: `${result.stderr}${separator}invalid glossary evaluation success report\n`,
    },
  };
}

function verifyStatus(result: EngineResult): string {
  return result.returncode === 0 ? "pass" : "fail";
}

export function buildVerifyPayload(family: string, target: string, outputFormat: string, result: EngineResult, safety: JsonObject): VerifyPayload {
  const publicResult = publicVerifyResult(family, target, result);
  return {
    command: "verify",
    status: verifyStatus(publicResult.result),
    family,
    target,
    format: outputFormat,
    engine: { command: publicResult.result.command, exit_code: publicResult.result.returncode },
    diagnostics: {
      stdout: boundedLines(publicResult.result.stdout),
      stderr: boundedLines(publicResult.result.stderr),
      line_limit: VERIFY_DIAGNOSTIC_LINE_LIMIT,
    },
    safety,
    ...(publicResult.glossaryEvaluation === undefined ? {} : { glossary_evaluation: publicResult.glossaryEvaluation }),
  };
}

function emitVerifyText(payload: VerifyPayload, out: (t: string) => void): void {
  const engine = payload.engine;
  const safety = payload.safety;
  out(`verify ${payload.family} ${payload.target}: ${payload.status} (engine_exit=${engine.exit_code})\n`);
  out(`engine=${engine.command.join(" ")}\n`);
  out(`safety=${safety.mode}; ${safety.summary}\n`);
  const stdout = payload.diagnostics.stdout;
  const stderr = payload.diagnostics.stderr;
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
  let family: string;
  let target: string;
  let outputFormat: string;
  try {
    [family, target, outputFormat] = validateVerifyRequest(args);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: "json",
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
  const { result, safety } = runVerifyEngine(family, target, args);
  const payload = buildVerifyPayload(family, target, outputFormat, result, safety);
  if (outputFormat === "json") {
    out(JSON.stringify(payload, null, 2) + "\n");
  } else {
    emitVerifyText(payload, out);
  }
  return payload.engine.exit_code;
}
