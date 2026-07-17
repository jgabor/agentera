import path from "node:path";

import { ArtifactSchemaValidator } from "../../hooks/validateArtifact/index.js";
import { loadArtifactRegistry, resolveArtifactPath } from "../../registries/artifactRegistry.js";
import { loadYamlMapping } from "../../core/yaml.js";
import fs from "node:fs";
import { nextEntryNumber, nextTaskNumber } from "./assign.js";
import { schemaBudget, projectedFields } from "./fields.js";
import {
  operationSpec,
  verbsForArtifact,
  type WritableArtifact,
  type WriteVerb,
} from "./operations.js";
import { reject } from "./errors.js";
import { detectStateMode } from "../stateMode.js";

function liveDoc(p: string): Record<string, unknown> {
  if (!fs.existsSync(p)) return {};
  return loadYamlMapping(fs.readFileSync(p, "utf8"));
}

function defaultVerb(artifact: WritableArtifact): Exclude<WriteVerb, "explain"> {
  return artifact === "experiments" ? "publish" : "append";
}

export function buildExplain(
  artifact: WritableArtifact,
  projectRoot: string,
  requestedVerb?: string | null,
): Record<string, unknown> {
  const verb = (requestedVerb ?? defaultVerb(artifact)) as Exclude<WriteVerb, "explain">;
  const spec = operationSpec(artifact, verb);
  if (!spec) {
    reject({
      class: "invalid_choice",
      message: `verb "${verb}" does not apply to ${artifact}`,
      valid_values: verbsForArtifact(artifact),
    });
  }
  const record = loadArtifactRegistry().get(artifact);
  if (!record)
    reject({ class: "unsupported_target", message: `artifact "${artifact}" is not registered` });
  const entityArtifact = ["progress", "decisions", "health"].includes(artifact) && detectStateMode(projectRoot) === "entities";
  const resolved = entityArtifact
    ? path.join(projectRoot, ".agentera", "entities", artifact, artifact === "progress" ? "progress_cycle" : artifact === "health" ? "health_audit" : verb === "append" ? "decision" : verb === "update" ? "decision_satisfaction" : "decision_revision", "<id>.yaml")
    : artifact === "experiments"
    ? path.join(projectRoot, ".agentera", "optimize", "<objective>", "experiments.yaml")
    : resolveArtifactPath(record, projectRoot, { strictWrite: true });
  const doc = artifact === "experiments" || entityArtifact ? {} : liveDoc(resolved);
  const next =
    artifact === "experiments" || entityArtifact
      ? {}
      : artifact === "plan"
      ? { task_number: nextTaskNumber(doc) }
      : {
          number: nextEntryNumber(
            doc,
            artifact === "progress" ? "cycles" : artifact === "decisions" ? "decisions" : "audits",
          ),
        };
  const validator = new ArtifactSchemaValidator();
  const fields = projectedFields(spec, validator)
    .filter(() => !(entityArtifact && artifact === "health" && verb === "repair"))
    .filter((field) => artifact !== "decisions" || !["update", "amend"].includes(verb) || (entityArtifact ? field.flag !== "--number" : !["--id", "--base-sha256"].includes(field.flag)))
    .map((field) => ({
    flag: field.flag,
    field: field.field,
    required: Boolean(field.required || (artifact === "decisions" && ["update", "amend"].includes(verb) && (entityArtifact ? field.flag === "--id" || (verb === "amend" && field.flag === "--base-sha256") : field.flag === "--number"))),
    type: field.kind,
    ...(field.validValues ? { valid_values: field.validValues } : {}),
    ...(field.repeatable ? { repeatable: true } : {}),
    ...(field.description ? { description: field.description } : {}),
    ...(field.kind === "date" ? { format: "YYYY-MM-DD" } : {}),
    ...(field.kind === "datetime" ? { format: "YYYY-MM-DD HH:MM" } : {}),
    ...(field.flag === "--timestamp" ? { default: "now" } : {}),
    ...(field.flag === "--date" ? { default: "today" } : {}),
  }));
  const result: Record<string, unknown> = {
    schemaVersion: "agentera.stateWriteExplain.v1",
    command: `state ${artifact} explain`,
    requested_verb: verb,
    artifact,
    path: path.relative(projectRoot, resolved) || resolved,
    verbs: verbsForArtifact(artifact),
    next,
    budget: schemaBudget(artifact, validator),
    fields,
  };
  if (spec.compacts) {
    result.compaction = entityArtifact
      ? `not applicable; each canonical ${artifact} entity is authority and no aggregate projection or numbered archive is written`
      : artifact === "experiments"
      ? "uniform_10_40_50 (10 active full-detail and 40 one-line archive entries); runs automatically on publication; durable archival is deferred"
      : "uniform_10_40_50 (bounded active/archive projections: 10 active full-detail and 40 archive entries; verified numbered archives remain authoritative; no destructive deletion; recovery refuses to omit entries when archive evidence is missing); runs automatically on append";
  }
  if (spec.inputRoot) {
    result.input_schema = {
      flag: "--input",
      sources: ["file path", "- (stdin)"],
      parser: "yaml",
      accepts_json: true,
      root: spec.inputRoot,
      cli_owned_fields: entityArtifact && artifact === "health" ? ["id", "artifact"] : spec.cliOwnedFields ?? [],
      defaulted_fields: artifact === "health" ? { date: "today" } : {},
      groups:
        artifact === "health"
          ? ["AUDIT", "DIMENSION", "FINDING", "TRENDS"]
          : artifact === "experiments"
            ? ["EXPERIMENT"]
            : ["HEADER", "PLAN", "SCOPE", "TASK"],
    };
  }
  result.guidance = decisionsGuidance(artifact, verb, entityArtifact && artifact === "decisions", entityArtifact && artifact === "health");
  result.example = entityArtifact && artifact === "health" && verb === "repair"
    ? "agentera check validate state --format json"
    : exampleFor(artifact, verb, entityArtifact && artifact === "decisions");
  return result;
}

function decisionsGuidance(artifact: WritableArtifact, verb: string, entityDecisions = false, entityHealth = false): string[] {
  const base = [
    "do not embed commit hashes; evidence belongs in the commit message (Decision 66)",
    "fold the artifact write into the implementation commit per AGENTS.md",
  ];
  if (artifact === "plan" && verb === "create")
    return [
      "supply sequential task numbers and valid dependencies; previous_plan_archived is assigned by the CLI",
      ...base,
    ];
  if (artifact === "plan")
    return ["task numbers are assigned by the CLI for append", ...base];
  if (entityHealth && verb === "repair")
    return ["canonical health audit entities are immutable; validate malformed or duplicate ownership with agentera check validate state", ...base];
  if (artifact === "health" && verb === "repair")
    return ["repair is a destructive projection edit; select an existing duplicate audit and pass --force", ...base];
  if (artifact === "experiments")
    return ["pass the intended non-negative --number; the CLI validates and assigns it to the entry", ...base];
  if (entityDecisions && verb === "update") return [
    "select one base decision with its bare --id; numeric selectors are unavailable",
    "update replaces only that decision's authority-owned satisfaction entity after transition validation",
    ...base,
  ];
  if (entityDecisions && verb === "amend") return [
    "select one base decision with its bare --id and current --base-sha256",
    "supply at least one amendable content field; satisfaction remains a separate mutation",
    "apply publishes one immutable revision entity; identical retries converge and same-base divergence conflicts",
    ...base,
  ];
  if (artifact === "decisions" && verb === "update")
    return [
      "select an existing decision number with --number; it is caller-supplied and never assigned by the CLI",
      "update writes only satisfaction overlay fields; decision content is amended, not updated",
      ...base,
    ];
  if (artifact === "decisions" && verb === "amend")
    return [
      "select an existing decision number with --number; it is caller-supplied and never assigned by the CLI",
      "supply at least one amendable content field (--question, --context, --alternative-chosen, --alternative-rejected, --choice, --reasoning, --confidence, --feeds-into)",
      "--alternative-rejected is repeatable and appends one rejected alternative each time it is supplied",
      "confidence must be current vocabulary (firm, provisional, exploratory); unsupported inherited labels on untouched records stay legacy",
      "dry-run reports the exact revision, effective record, and projection effect without writing any file",
      "apply publishes a record-local revision document override with recovery; the decisions projection stays byte-stable and reads compose base→revisions→overlay",
      "an identical re-submission is an idempotent replay; retry converges on a stable revision identity without duplicates or mixed state",
    ];
  return [entityDecisions || entityHealth ? "a bare ten-letter ID is assigned by the CLI; do not pass an identity" : "number is assigned by the CLI; do not pass --number", ...base];
}

export function exampleFor(artifact: WritableArtifact, verb: string, entityDecisions = false): string {
  if (artifact === "progress")
    return 'agentera state progress append --type fix --phase build --what "..." --intent "..." --format json';
  if (artifact === "decisions" && verb === "update")
    return entityDecisions
      ? 'agentera state decisions update --id qjtrmnpvka --satisfaction-state provisionally_satisfied --satisfaction-evidence "..."'
      : 'agentera state decisions update --number 1 --satisfaction-state provisionally_satisfied --satisfaction-evidence "..."';
  if (artifact === "decisions" && verb === "amend")
    return entityDecisions
      ? 'agentera state decisions amend --id qjtrmnpvka --base-sha256 HASH --choice "..." --dry-run --format json'
      : 'agentera state decisions amend --number 53 --choice "..." --reasoning "..." --confidence firm --dry-run --format json';
  if (artifact === "decisions")
    return 'agentera state decisions append --question "..." --context "..." --alternative-chosen "..." --choice "..." --reasoning "..." --confidence firm';
  if (artifact === "health" && verb === "repair") return "agentera state health repair --number 14 --keep first --force --format json";
  if (artifact === "health") return "agentera state health append --input audit.yaml --format json";
  if (verb === "create") return "agentera state plan create --input plan.yaml --format json";
  if (verb === "archive") return "agentera state plan archive --dry-run";
  if (verb === "update") return 'agentera state plan update --task 1 --name "..." --format json';
  if (verb === "set-status")
    return "agentera state plan set-status --task 1 --status complete --format json";
  if (verb === "set-plan-status")
    return "agentera state plan set-plan-status --status complete --format json";
  if (verb === "record-evaluation")
    return 'agentera state plan record-evaluation --task 1 --attempt-id audit-1 --verdict pass --provenance "audit report" --format json';
  if (verb === "publish")
    return "agentera state experiments publish --objective OBJECTIVE_ID --number 0 --input experiment.yaml --format json";
  return `agentera state plan ${verb} --name "..."`;
}

export function renderExplainText(explain: Record<string, unknown>): string {
  const lines = [
    `usage: agentera state ${explain.artifact} ${(explain as { requested_verb?: string }).requested_verb ?? "append"} [flags]`,
    "",
    `${explain.artifact} (${explain.path})`,
  ];
  const fields = Array.isArray(explain.fields)
    ? (explain.fields as Array<Record<string, unknown>>)
    : [];
  if (fields.length) {
    const required = fields.filter((field) => field.required);
    const optional = fields.filter((field) => !field.required);
    for (const [heading, entries] of [
      ["Required", required],
      ["Optional", optional],
    ] as const) {
      if (!entries.length) continue;
      lines.push("", `${heading}:`);
      for (const field of entries) {
        const values = Array.isArray(field.valid_values)
          ? ` one of: ${(field.valid_values as string[]).join(", ")}`
          : "";
        lines.push(
          `  ${String(field.flag).padEnd(24)}${values || String(field.description ?? field.field)}`,
        );
      }
    }
  }
  if (explain.input_schema) {
    lines.push("", "Required:", "  --input PATH             YAML/JSON document; use - for stdin");
  }
  if (explain.compaction) lines.push("", `Compaction: ${explain.compaction}`);
  lines.push("", "Guidance:");
  for (const guidance of explain.guidance as string[]) lines.push(`  ${guidance}`);
  lines.push("", "Example:", `  ${explain.example}`);
  return lines.join("\n") + "\n";
}
