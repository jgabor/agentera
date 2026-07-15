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

function liveDoc(p: string): Record<string, unknown> {
  if (!fs.existsSync(p)) return {};
  return loadYamlMapping(fs.readFileSync(p, "utf8"));
}

function defaultVerb(artifact: WritableArtifact): Exclude<WriteVerb, "explain"> {
  return artifact === "plan" ? "append" : "append";
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
  const resolved = artifact === "experiments"
    ? path.join(projectRoot, ".agentera", "optimize", "<objective>", "experiments.yaml")
    : resolveArtifactPath(record, projectRoot, { strictWrite: true });
  const doc = artifact === "experiments" ? {} : liveDoc(resolved);
  const next =
    artifact === "experiments"
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
  const fields = projectedFields(spec, validator).map((field) => ({
    flag: field.flag,
    field: field.field,
    required: Boolean(field.required),
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
    result.compaction = artifact === "experiments"
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
      cli_owned_fields: spec.cliOwnedFields ?? [],
      defaulted_fields: artifact === "health" ? { date: "today" } : {},
      groups:
        artifact === "health"
          ? ["AUDIT", "DIMENSION", "FINDING", "TRENDS"]
          : artifact === "experiments"
            ? ["EXPERIMENT"]
            : ["HEADER", "PLAN", "SCOPE", "TASK"],
    };
  }
  result.guidance = [
    artifact === "plan" && verb === "create"
      ? "supply sequential task numbers and valid dependencies; previous_plan_archived is assigned by the CLI"
      : artifact === "plan"
        ? "task numbers are assigned by the CLI for append"
        : artifact === "health" && verb === "repair"
          ? "repair is a destructive projection edit; select an existing duplicate audit and pass --force"
          : artifact === "experiments"
            ? "pass the intended non-negative --number; the CLI validates and assigns it to the entry"
            : "number is assigned by the CLI; do not pass --number",
    "do not embed commit hashes; evidence belongs in the commit message (Decision 66)",
    "fold the artifact write into the implementation commit per AGENTS.md",
  ];
  result.example = exampleFor(artifact, verb);
  return result;
}

export function exampleFor(artifact: WritableArtifact, verb: string): string {
  if (artifact === "progress")
    return 'agentera state progress append --type fix --phase build --what "..." --intent "..." --format json';
  if (artifact === "decisions" && verb === "update")
    return 'agentera state decisions update --number 1 --satisfaction-state provisionally_satisfied --satisfaction-evidence "..."';
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
