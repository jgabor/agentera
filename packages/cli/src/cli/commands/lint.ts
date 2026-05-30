import fs from "node:fs";

import {
  checkAbstraction,
  checkFiller,
  checkFullFileVerbosity,
  checkVerbosity,
} from "../../validate/selfAudit.js";
import { artifactPath, discoverSchemasDir, loadSchemas, SchemaInfo } from "../appContext.js";
import { pathStem, validateAgentString } from "../argvalidate.js";
import { emitStructured } from "../structured.js";

/** Port of scripts/agentera `cmd_lint` and its `_lint_*` helpers. */

const LINT_CHECKS: Array<[string, string]> = [
  ["verbosity", "Shorten the entry or split it into smaller concrete entries."],
  ["abstraction", "Add a concrete anchor such as a path, line number, metric, command, identifier, or quote."],
  ["filler", "Remove the named filler phrase category before writing the artifact."],
];

const LINT_CANONICAL_LABELS: Record<string, string> = {
  changelog: "CHANGELOG.md",
  decisions: "DECISIONS.md",
  design: "DESIGN.md",
  docs: "DOCS.md",
  health: "HEALTH.md",
  plan: "PLAN.md",
  progress: "PROGRESS.md",
  todo: "TODO.md",
  vision: "VISION.md",
  experiments: "EXPERIMENTS.md",
};

const VALIDATE_ARTIFACT_LABELS = [
  "CHANGELOG.md",
  "DECISIONS.md",
  "DESIGN.md",
  "DOCS.md",
  "HEALTH.md",
  "PLAN.md",
  "PROGRESS.md",
  "TODO.md",
  "VISION.md",
];

export interface LintArgs {
  artifact: string;
  file?: string | null;
  text?: string | null;
  strict?: boolean;
  format?: string;
}

function lintSchemaName(artifact: string, schemas: Record<string, SchemaInfo>): string | null {
  if (artifact in schemas) return artifact;
  const lowered = artifact.toLowerCase();
  if (lowered in schemas) return lowered;
  for (const [name, info] of Object.entries(schemas)) {
    const record = info.record;
    if (record && record.displayName === artifact) return name;
  }
  const stem = pathStem(artifact).toLowerCase();
  if (stem in schemas) return stem;
  return null;
}

function lintCanonicalLabel(schemaName: string, info: SchemaInfo, artifact: string): string {
  if (schemaName in LINT_CANONICAL_LABELS) return LINT_CANONICAL_LABELS[schemaName];
  const record = info.record;
  if (record && record.displayName) return record.displayName;
  if (VALIDATE_ARTIFACT_LABELS.includes(artifact)) return artifact;
  const upper = artifact.trim().toUpperCase();
  if (VALIDATE_ARTIFACT_LABELS.includes(upper)) return upper;
  return artifact;
}

function resolveLintArtifactFile(artifact: string): [string, string] {
  const schemas = loadSchemas(discoverSchemasDir());
  const schemaName = lintSchemaName(artifact, schemas);
  if (schemaName === null) {
    const validLabels = VALIDATE_ARTIFACT_LABELS.join(", ");
    throw new Error(
      `unsupported artifact ${pyRepr(artifact)}; provide --file or --text, ` +
        "or use a schema name from `agentera query --list-artifacts` " +
        `or a canonical label (${validLabels})`,
    );
  }
  const info = schemas[schemaName];
  const p = artifactPath(info, schemaName);
  const canonical = lintCanonicalLabel(schemaName, info, artifact);
  return [p, canonical];
}

function pyRepr(value: string): string {
  return value.includes("'") && !value.includes('"') ? `"${value}"` : `'${value}'`;
}

/** [text, source, fullArtifact, budgetArtifact]. */
function lintInputText(args: LintArgs): [string, string, boolean, string | null] {
  if (args.text !== undefined && args.text !== null) {
    return [String(args.text), "text", false, null];
  }
  if (args.file !== undefined && args.file !== null) {
    const p = String(args.file);
    try {
      return [fs.readFileSync(p, "utf8"), p, true, null];
    } catch (exc) {
      throw new Error(`could not read lint file ${p}: ${(exc as Error).message}`);
    }
  }
  const artifact = String(args.artifact);
  const [p, canonical] = resolveLintArtifactFile(artifact);
  if (isFileSafe(p)) {
    try {
      return [fs.readFileSync(p, "utf8"), p, true, canonical];
    } catch (exc) {
      throw new Error(`could not read lint file ${p}: ${(exc as Error).message}`);
    }
  }
  throw new Error(
    `lint requires --text, --file, or piped stdin; artifact file ${p} does not exist`,
  );
}

function isFileSafe(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function lintChecks(text: string, artifact: string, fullArtifact: boolean): Array<Record<string, string>> {
  const verbosityCheck = fullArtifact ? checkFullFileVerbosity(text, artifact) : checkVerbosity(text, artifact);
  const raw: Record<string, [boolean, string]> = {
    verbosity: verbosityCheck,
    abstraction: checkAbstraction(text),
    filler: checkFiller(text),
  };
  const actions = Object.fromEntries(LINT_CHECKS);
  const checks: Array<Record<string, string>> = [];
  for (const [name] of LINT_CHECKS) {
    const [passed, detail] = raw[name];
    checks.push({
      name,
      status: passed ? "pass" : "fail",
      detail,
      action: passed ? "" : actions[name],
    });
  }
  return checks;
}

export function lintPayload(args: LintArgs): Record<string, any> {
  const [text, source, fullArtifact, budgetArtifact] = lintInputText(args);
  const artifact = budgetArtifact || String(args.artifact);
  validateAgentString(artifact, "artifact");
  const checks = lintChecks(text, artifact, fullArtifact);
  const failures = checks.filter((c) => c.status === "fail");
  return {
    command: "lint",
    status: failures.length > 0 ? "fail" : "pass",
    artifact,
    source,
    strict: Boolean(args.strict),
    checks,
    summary: {
      failed: failures.length,
      passed: checks.length - failures.length,
      advisory: !args.strict,
    },
  };
}

function emitLintText(payload: Record<string, any>, out: (text: string) => void): void {
  const failures = (payload.checks as Array<Record<string, string>>).filter((c) => c.status === "fail");
  out(`lint ${payload.status}: ${payload.artifact} (${payload.source})\n`);
  if (failures.length === 0) {
    out("all self-audit checks passed\n");
    return;
  }
  out(`${failures.length} issue(s); advisory by default, use --strict to fail on issues\n`);
  for (const check of failures) {
    out(`- ${check.name}: ${check.detail}\n`);
    out(`  action: ${check.action}\n`);
  }
}

export function cmdLint(
  args: LintArgs,
  io: { out?: (t: string) => void; err?: (t: string) => void } = {},
): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const payload = lintPayload(args);
  if ((args.format ?? "text") === "json") {
    emitStructured(payload, "json", out);
  } else {
    emitLintText(payload, out);
  }
  return payload.status === "fail" ? 1 : 0;
}
