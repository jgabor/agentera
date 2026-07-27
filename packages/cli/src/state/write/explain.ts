import path from "node:path";

import { ArtifactSchemaValidator } from "../../hooks/validateArtifact/index.js";
import { loadArtifactRegistry, resolveArtifactPath } from "../../registries/artifactRegistry.js";
import { schemaBudget, projectedFields } from "./fields.js";
import {
  operationSpec,
  writerOwnedFields,
  verbsForArtifact,
  type WritableArtifact,
  type WriteVerb,
} from "./operations.js";
import { reject } from "./errors.js";

function defaultVerb(artifact: WritableArtifact): Exclude<WriteVerb, "explain"> {
  return ["experiments", "glossary"].includes(artifact) ? "publish" : ["objective", "todo", "docs"].includes(artifact) ? "create" : "append";
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
  const entityArtifact = artifact !== "glossary";
  const resolved = entityArtifact
    ? path.join(projectRoot, ".agentera", "entities", artifact, artifact === "progress" ? "progress_cycle" : artifact === "health" ? "health_audit" : artifact === "plan" ? ["append", "update", "set-status", "supersede", "record-evaluation"].includes(verb) ? "plan_task" : "plan" : artifact === "objective" ? "objective" : artifact === "experiments" ? "experiment" : artifact === "todo" ? "todo_item" : artifact === "docs" ? "documentation_inventory_entry" : verb === "append" ? "decision" : verb === "update" ? "decision_satisfaction" : "decision_revision", "<id>.yaml")
    : resolveArtifactPath(record, projectRoot, { strictWrite: true });
  const validator = new ArtifactSchemaValidator();
  const fields = (entityArtifact && artifact === "plan" && verb === "supersede"
    ? [{ flag: "--id", field: "id", kind: "string" as const, required: true }, ...projectedFields(spec, validator)]
    : projectedFields(spec, validator))
    .filter(() => !(entityArtifact && artifact === "health" && verb === "repair"))
    .filter((field) => artifact !== "decisions" || !["update", "amend"].includes(verb) || (entityArtifact ? field.flag !== "--number" : !["--id", "--base-sha256"].includes(field.flag)))
    .filter((field) => !(entityArtifact && artifact === "experiments" && field.flag === "--number"))
    .map((field) => ({
    flag: entityArtifact && artifact === "plan" && field.flag === "--task" ? "--id" : field.flag,
    field: entityArtifact && artifact === "plan" && field.flag === "--task" ? "id" : field.field,
    required: Boolean(field.required || (artifact === "decisions" && ["update", "amend"].includes(verb) && (entityArtifact ? field.flag === "--id" || (verb === "amend" && field.flag === "--base-sha256") : field.flag === "--number"))),
    type: entityArtifact && artifact === "plan" && field.flag === "--task" ? "string" : field.kind,
    ...(field.validValues ? { valid_values: field.validValues } : {}),
    ...(field.repeatable ? { repeatable: true } : {}),
    ...(field.description ? { description:
      entityArtifact && artifact === "objective" && field.flag === "--id"
        ? "Bare ten-letter objective ID returned by objective create or list."
        : entityArtifact && artifact === "experiments" && field.flag === "--objective"
          ? "Bare ten-letter objective ID owning the experiment."
          : entityArtifact && artifact === "experiments" && field.flag === "--id"
            ? "Existing bare ten-letter experiment ID for exact immutable replay."
            : field.description } : {}),
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
    next: {},
    budget: schemaBudget(artifact, validator),
    fields,
  };
  const owned = writerOwnedFields(artifact);
  if (owned.length) result.writer_owned_fields = owned;
  if (spec.compacts) {
    result.compaction = `not applicable; each canonical ${artifact} entity is authority and no aggregate projection or numbered archive is written`;
  }
  if (spec.inputRoot) {
    result.input_schema = {
      flag: "--input",
      sources: ["file path", "- (stdin)"],
      parser: "yaml",
      accepts_json: true,
      root: spec.inputRoot,
      cli_owned_fields: entityArtifact && artifact === "experiments"
        ? ["id", "artifact", "objective"]
        : entityArtifact && artifact === "objective"
          ? ["id", "artifact"]
        : entityArtifact && artifact === "health" ? ["id", "artifact", "appended_at"]
        : entityArtifact && ["docs", "plan"].includes(artifact) ? ["id", "artifact"] : spec.cliOwnedFields ?? [],
      defaulted_fields: artifact === "health" ? { date: "today" } : {},
      groups:
        artifact === "glossary"
          ? ["PROPOSAL", "CONFIRMATION"]
          : artifact === "health"
          ? ["AUDIT", "DIMENSION", "FINDING", "TRENDS"]
          : artifact === "experiments"
            ? ["EXPERIMENT"]
            : ["HEADER", "PLAN", "SCOPE", "TASK"],
    };
  }
  if (artifact === "glossary") {
    result.identity = {
      display_name: record.displayName,
      default_path: record.defaultPath,
      authority: "artifact registry",
    };
    result.implementation_status = record.implementationStatus;
    result.producer = [...record.producers].sort();
    result.request_schema_version = "agentera.glossaryPublicationRequest.v1";
    result.document_schema_version = "agentera.projectGlossary.v1";
    result.request_example = {
      schema_version: "agentera.glossaryPublicationRequest.v1",
      proposal: {
        family: "terminology_drift",
        concept: "structured value",
        proposed_canonical_term: "JsonValue",
        canonical_evidence: [{ source_path: "src/value.ts", line: 1, source_record_sha256: "<lowercase-sha256>" }],
        variants: [{ term: "Dict", evidence: [{ source_path: "src/dict.ts", line: 1, source_record_sha256: "<lowercase-sha256>" }] }],
        severity: "warning",
        confidence: 84,
        proposal_digest: "<audit-emitted-lowercase-sha256>",
      },
      confirmation: {
        proposal_digest: "<same-audit-emitted-lowercase-sha256>",
        confirmed_by: "user",
        confirmed_at: "2026-07-26T14:00:00Z",
      },
    };
    result.recovery = "Rerun audit against current project files, obtain explicit user confirmation for its proposal_digest, and retry with the new request.";
  }
  result.guidance = decisionsGuidance(artifact, verb, entityArtifact && artifact === "decisions", entityArtifact && artifact === "health", entityArtifact);
  result.example = entityArtifact && artifact === "health" && verb === "repair"
    ? "agentera check validate state --format json"
    : exampleFor(artifact, verb, entityArtifact && artifact === "decisions", entityArtifact);
  return result;
}

function decisionsGuidance(artifact: WritableArtifact, verb: string, entityDecisions = false, entityHealth = false, entityArtifact = false): string[] {
  const base = [
    "do not embed commit hashes; evidence belongs in the commit message (Decision 66)",
    "fold the artifact write into the implementation commit per AGENTS.md",
  ];
  if (artifact === "glossary") return [
    "build is the only publisher; audit and discuss remain mutation-free",
    "confirmation.confirmed_by must be user and must bind the exact proposal digest and timestamp",
    "the writer revalidates every cited project source line and publishes approval plus entry as one atomic document",
    "the v1LegacyCruft guard rejects literal confirmed variants; read-only consumer advice is active through agentera report glossary-advice",
    "the publication operation never performs consumer lookup, precedence, semantic review, profile mutation, or docs-mapping mutation",
  ];
  if (entityArtifact && artifact === "plan" && verb === "create")
    return [
      "the CLI assigns bare IDs to the plan and each task and publishes one canonical file per entity",
      ...base,
    ];
  if (entityArtifact && artifact === "plan" && verb === "record-evaluation")
    return [
      "select one task entity with its bare ten-letter --id; ordinal selectors are unavailable",
      "evaluate before completing a task during normal orchestration",
      "a first PASS on an unevaluated complete replacement is recovery only when an open same-plan superseded predecessor names it in superseded_by",
      ...base,
    ];
  if (entityArtifact && artifact === "plan" && ["update", "set-status", "supersede"].includes(verb))
    return ["select one task entity with its bare ten-letter --id; ordinal selectors are unavailable", ...base];
  if (entityArtifact && artifact === "plan" && verb === "append")
    return ["the CLI assigns a bare ten-letter ID to the new task entity", ...base];
  if (entityArtifact && artifact === "plan")
    return ["the active plan entity is selected by lifecycle state", ...base];
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
  if (entityArtifact && artifact === "experiments")
    return ["select the owner with its bare ten-letter --objective ID; numeric and composite selectors are unavailable", "omit --id for a new immutable experiment; pass an existing bare --id only for exact replay", ...base];
  if (artifact === "experiments")
    return ["pass the intended non-negative --number; the CLI validates and assigns it to the entry", ...base];
  if (entityArtifact && artifact === "objective" && verb === "update")
    return ["select one objective with its bare ten-letter --id; numeric and composite selectors are unavailable", "the CLI preserves that ID while replacing the validated objective record", ...base];
  if (entityArtifact && artifact === "objective")
    return ["a bare ten-letter objective ID is assigned by the CLI; do not pass an identity", ...base];
  if (entityArtifact && artifact === "todo" && verb === "update")
    return [
      "select one TODO item with its bare ten-letter --id; numeric, prefixed, composite, alias, and path identities are unavailable",
      "supplying any readiness flag replaces complete readiness: include --capability, --reason, --queue-rank, and --order-reason; omitted dependencies, blocker, and gate become [], null, and null",
      "an update with no readiness flags preserves the current readiness or its needs-triage absence",
      ...base,
    ];
  if (entityArtifact && artifact === "todo" && verb === "resolve")
    return ["select one TODO item with its bare ten-letter --id; numeric, prefixed, composite, alias, and path identities are unavailable", ...base];
  if (entityArtifact && artifact === "todo")
    return [
      "a bare ten-letter TODO item ID is assigned by the CLI; status starts open",
      "supplying any readiness flag declares complete readiness: include --capability, --reason, --queue-rank, and --order-reason; omitted dependencies, blocker, and gate become [], null, and null",
      "omit every readiness flag to create a valid needs-triage TODO",
      ...base,
    ];
  if (entityArtifact && artifact === "docs" && verb === "update")
    return ["select one documentation inventory entry with its bare ten-letter --id; path remains record data, not identity", ...base];
  if (entityArtifact && artifact === "docs")
    return ["a bare ten-letter documentation inventory ID is assigned by the CLI; path remains record data", ...base];
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
      entityDecisions
        ? "select an existing decision by bare ID with --id; it is caller-supplied and never assigned by the CLI"
        : "select an existing decision number with --number; it is caller-supplied and never assigned by the CLI",
      "update writes only satisfaction overlay fields; decision content is amended, not updated",
      ...base,
    ];
  if (artifact === "decisions" && verb === "amend")
    return [
      entityDecisions
        ? "select an existing decision by bare ID with --id; it is caller-supplied and never assigned by the CLI"
        : "select an existing decision number with --number; it is caller-supplied and never assigned by the CLI",
      "supply at least one amendable content field (--question, --context, --alternative-chosen, --alternative-rejected, --choice, --reasoning, --confidence, --feeds-into)",
      "--alternative-rejected is repeatable and appends one rejected alternative each time it is supplied",
      "confidence must be current vocabulary (firm, provisional, exploratory); unsupported inherited labels on untouched records stay legacy",
      "dry-run reports the exact revision, effective record, and projection effect without writing any file",
      "apply publishes a record-local revision document override with recovery; the decisions projection stays byte-stable and reads compose base→revisions→overlay",
      "an identical re-submission is an idempotent replay; retry converges on a stable revision identity without duplicates or mixed state",
    ];
  return [entityArtifact ? "a bare ten-letter ID is assigned by the CLI; do not pass an identity" : "number is assigned by the CLI; do not pass --number", ...base];
}

export function exampleFor(artifact: WritableArtifact, verb: string, entityDecisions = false, entityArtifact = false): string {
  if (artifact === "glossary")
    return "agentera state glossary publish --input glossary-publication.yaml --format json";
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
  if (entityArtifact && artifact === "objective" && verb === "create") return "agentera state objective create --input objective.yaml --format json";
  if (entityArtifact && artifact === "objective" && verb === "update") return "agentera state objective update --id qjtrmnpvka --input objective.yaml --format json";
  if (entityArtifact && artifact === "todo" && verb === "create") return 'agentera state todo create --severity normal --description "..." --capability build --reason "..." --queue-rank 1 --order-reason "..." --format json';
  if (entityArtifact && artifact === "todo" && verb === "resolve") return "agentera state todo resolve --id qjtrmnpvka --format json";
  if (entityArtifact && artifact === "todo" && verb === "update") return 'agentera state todo update --id qjtrmnpvka --capability build --reason "..." --queue-rank 1 --order-reason "..." --format json';
  if (entityArtifact && artifact === "docs" && verb === "create") return "agentera state docs create --input documentation.yaml --format json";
  if (entityArtifact && artifact === "docs" && verb === "update") return "agentera state docs update --id qjtrmnpvka --input documentation.yaml --format json";
  if (verb === "create") return "agentera state plan create --input plan.yaml --format json";
  if (verb === "archive") return "agentera state plan archive --dry-run";
  if (verb === "update") return entityArtifact
    ? 'agentera state plan update --id qjtrmnpvka --name "..." --format json'
    : 'agentera state plan update --task 1 --name "..." --format json';
  if (verb === "set-status")
    return entityArtifact
      ? "agentera state plan set-status --id qjtrmnpvka --status complete --format json"
      : "agentera state plan set-status --task 1 --status complete --format json";
  if (verb === "supersede")
    return entityArtifact
      ? 'agentera state plan supersede --id qjtrmnpvka --by zqtrmnpvka --reason "Replacement tasks cover this work." --format json'
      : "agentera state plan supersede --task 1 --by 2 --reason \"Replacement tasks cover this work.\" --format json";
  if (verb === "set-plan-status")
    return "agentera state plan set-plan-status --status complete --format json";
  if (verb === "record-evaluation")
    return entityArtifact
      ? 'agentera state plan record-evaluation --id qjtrmnpvka --attempt-id audit-1 --verdict pass --provenance "audit report" --format json'
      : 'agentera state plan record-evaluation --task 1 --attempt-id audit-1 --verdict pass --provenance "audit report" --format json';
  if (entityArtifact && verb === "publish")
    return "agentera state experiments publish --objective qjtrmnpvka --input experiment.yaml --format json";
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
