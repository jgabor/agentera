import path from "node:path";

import { ArtifactSchemaValidator } from "../../hooks/validateArtifact/index.js";
import { loadArtifactRegistry, resolveArtifactPath } from "../../registries/artifactRegistry.js";
import { schemaBudget, projectedFields } from "./fields.js";
import {
  loadMutationGrammar,
} from "./grammar.js";
import {
  operationSpec,
  mutationParityMatrix,
  writerOwnedFields,
  verbsForArtifact,
  type WritableArtifact,
  type WriteVerb,
  type OperationField,
} from "./operations.js";
import { reject } from "./errors.js";

function defaultVerb(artifact: WritableArtifact): Exclude<WriteVerb, "explain"> {
  const verb = verbsForArtifact(artifact).find((candidate) => candidate !== "explain");
  if (!verb) reject({ class: "unsupported_target", message: `artifact "${artifact}" has no public mutation` });
  return verb as Exclude<WriteVerb, "explain">;
}

function entityBoundary(artifact: WritableArtifact, verb: string): string {
  if (artifact === "progress") return "progress_cycle";
  if (artifact === "health") return "health_audit";
  if (artifact === "plan") return ["append", "update", "set-status", "supersede", "record-evaluation"].includes(verb) ? "plan_task" : "plan";
  if (artifact === "objective") return "objective";
  if (artifact === "experiments") return "experiment";
  if (artifact === "todo") return "todo_item";
  if (artifact === "docs") return "documentation_inventory_entry";
  return verb === "append" ? "decision" : verb === "update" ? "decision_satisfaction" : "decision_revision";
}

function exposedFields(
  artifact: WritableArtifact,
  verb: string,
  spec: NonNullable<ReturnType<typeof operationSpec>>,
  validator: ArtifactSchemaValidator,
): Record<string, unknown>[] {
  let source: OperationField[] = projectedFields(spec, validator);
  return source.map((field) => ({
    flag: field.flag,
    field: field.field,
    required: field.required === true,
    type: field.kind,
    ...(field.validValues ? { valid_values: field.validValues } : {}),
    ...(field.repeatable ? { repeatable: true } : {}),
    ...(field.description ? { description:
      artifact === "objective" && field.flag === "--id"
        ? "Bare ten-letter objective ID returned by objective create or list."
        : artifact === "experiments" && field.flag === "--objective"
          ? "Bare ten-letter objective ID owning the experiment."
          : artifact === "experiments" && field.flag === "--id"
            ? "Existing bare ten-letter experiment ID for exact immutable replay."
            : field.description } : {}),
    ...(field.kind === "date" ? { format: "YYYY-MM-DD" } : {}),
    ...(field.kind === "datetime" ? { format: "YYYY-MM-DD HH:MM" } : {}),
    ...(field.flag === "--timestamp" ? { default: "now" } : {}),
    ...(field.flag === "--date" ? { default: "today" } : {}),
  }));
}

function pathFor(artifact: WritableArtifact, verb: string, projectRoot: string): string {
  const record = loadArtifactRegistry().get(artifact);
  if (!record) reject({ class: "unsupported_target", message: `artifact "${artifact}" is not registered` });
  const entityArtifact = artifact !== "glossary";
  const resolved = entityArtifact
    ? path.join(projectRoot, ".agentera", "entities", artifact, entityBoundary(artifact, verb), "<id>.yaml")
    : resolveArtifactPath(record, projectRoot, { strictWrite: true });
  return path.relative(projectRoot, resolved) || resolved;
}

function inputProjection(spec: NonNullable<ReturnType<typeof operationSpec>>): Record<string, unknown> {
  return {
    mode: spec.inputMode,
    ...(spec.inputRoot ? { root: spec.inputRoot } : {}),
    sources: spec.inputSources,
    structured_sources: spec.structuredInputSources,
    cli_owned_fields: spec.cliOwnedFields,
    ...(spec.inputMode === "structured" ? {
      flag: "--input",
      stdin_value: "-",
      parser: "yaml_or_json_mapping",
    } : {}),
  };
}

export function buildExplain(
  artifact: WritableArtifact,
  projectRoot: string,
  requestedVerb?: string | null,
): Record<string, unknown> {
  const verb = (requestedVerb ?? defaultVerb(artifact)) as Exclude<WriteVerb, "explain">;
  const spec = operationSpec(artifact, verb);
  const grammar = loadMutationGrammar();
  const declaration = grammar.operations.find((operation) => operation.artifact === artifact && operation.verb === verb);
  if (!spec || !declaration) {
    reject({
      class: "invalid_choice",
      message: `verb "${verb}" does not apply to ${artifact}`,
      valid_values: verbsForArtifact(artifact),
    });
  }
  const record = loadArtifactRegistry().get(artifact);
  if (!record) reject({ class: "unsupported_target", message: `artifact "${artifact}" is not registered` });
  const validator = new ArtifactSchemaValidator();
  const result: Record<string, unknown> = {
    schemaVersion: "agentera.stateWriteExplain.v1",
    command: `state ${artifact} explain`,
    requested_verb: verb,
    artifact,
    path: pathFor(artifact, verb, projectRoot),
    verbs: verbsForArtifact(artifact),
    contract_digest: grammar.contractDigest,
    mutation_class: declaration.mutationClass,
    selectors: declaration.selectors,
    preconditions: declaration.preconditions,
    owned_fields: declaration.ownedFields,
    input: inputProjection(spec),
    recovery: declaration.recovery,
    examples: declaration.examples,
    bounds: declaration.bounds,
    next: {},
    budget: schemaBudget(artifact, validator),
    fields: exposedFields(artifact, verb, spec, validator),
  };
  const owned = writerOwnedFields(artifact);
  if (owned.length) result.writer_owned_fields = owned;
  if (spec.compacts) {
    result.compaction = `not applicable; each canonical ${artifact} entity is authority and no aggregate projection or numbered archive is written`;
  }
  if (spec.inputMode === "structured") {
    result.input_schema = {
      flag: "--input",
      sources: spec.inputSources,
      parser: "yaml",
      accepts_json: true,
      root: spec.inputRoot,
      cli_owned_fields: spec.cliOwnedFields,
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
  }
  result.guidance = decisionsGuidance(artifact, verb, artifact === "health", true);
  result.example = exampleFor(artifact, verb);
  return result;
}

export function buildExplainAll(
  artifact: WritableArtifact,
  projectRoot: string,
): Record<string, unknown> {
  const grammar = loadMutationGrammar();
  const operations = verbsForArtifact(artifact)
    .filter((verb): verb is Exclude<WriteVerb, "explain"> => verb !== "explain")
    .map((verb) => buildExplain(artifact, projectRoot, verb));
  return {
    schemaVersion: "agentera.stateWriteExplainAll.v1",
    command: `state ${artifact} explain --all`,
    artifact,
    authority: grammar.authority,
    contract_digest: grammar.contractDigest,
    verbs: operations.map((operation) => operation.requested_verb),
    operations,
    parity_matrix: mutationParityMatrix([artifact]),
  };
}

function decisionsGuidance(artifact: WritableArtifact, verb: string, _entityHealth = false, entityArtifact = false): string[] {
  const base = [
    "do not embed commit hashes; evidence belongs in the commit message (Decision 66)",
    "fold the artifact write into the implementation commit per AGENTS.md",
  ];
  if (artifact === "glossary") return [
    "build is the only publisher; audit and discuss remain mutation-free",
    "confirmation.confirmed_by must be user and must bind the exact proposal digest and timestamp",
    "the writer revalidates every cited project source line and publishes approval plus entry as one atomic document",
    ...base,
  ];
  if (entityArtifact && artifact === "plan" && verb === "create") return ["the CLI assigns bare IDs to the plan and each task and publishes one canonical file per entity", ...base];
  if (entityArtifact && artifact === "plan" && verb === "record-evaluation") return [
    "select one task entity with its bare ten-letter --id; ordinal selectors are unavailable",
    "evaluate before completing a task during normal orchestration",
    "a first PASS on an unevaluated complete replacement is recovery only when an open same-plan superseded predecessor names it in superseded_by",
    ...base,
  ];
  if (entityArtifact && artifact === "plan" && verb === "supersede") return [
    "select one task entity with its bare ten-letter --id; ordinal selectors are unavailable",
    "each replacement must be complete with latest persisted PASS",
    "if a non-PASS replacement is not already referenced by a historical superseded predecessor, reopen it, record PASS, complete it, and retry",
    "if a referenced historical replacement is unevaluated complete, record its allowed first PASS while it remains complete, then retry",
    "if a referenced historical replacement has an existing non-PASS evaluation, first-PASS recovery is unavailable; use another complete latest-PASS replacement, or keep or archive the plan without claiming completion as applicable",
    ...base,
  ];
  if (entityArtifact && artifact === "plan" && ["update", "set-status"].includes(verb)) return ["select one task entity with its bare ten-letter --id; ordinal selectors are unavailable", ...base];
  if (entityArtifact && artifact === "plan" && verb === "append") return ["the CLI assigns a bare ten-letter ID to the new task entity", ...base];
  if (entityArtifact && artifact === "plan") return [
    "the active plan entity is selected by lifecycle state",
    ...(verb === "set-plan-status" ? ["open-to-complete requires every superseded_by replacement to be complete with latest persisted PASS; historical unevaluated complete replacements may record their allowed first PASS, then retry"] : []),
    ...base,
  ];
  if (entityArtifact && artifact === "experiments") return ["select the owner with its bare ten-letter --objective ID; numeric and composite selectors are unavailable", "omit --id for a new immutable experiment; pass an existing bare --id only for exact replay", ...base];
  if (entityArtifact && artifact === "objective" && verb === "update") return ["select one objective with its bare ten-letter --id; numeric selectors are unavailable", "the CLI preserves that ID while replacing the validated objective record", ...base];
  if (entityArtifact && artifact === "objective") return ["a bare ten-letter objective ID is assigned by the CLI; do not pass an identity", ...base];
  if (entityArtifact && artifact === "todo" && verb === "update") return [
    "select one TODO item with its bare ten-letter --id; numeric, prefixed, composite, alias, and path identities are unavailable",
    "supplying any readiness flag replaces complete readiness: include --capability, --reason, --queue-rank, and --order-reason; omitted dependencies, blocker, and gate become [], null, and null",
    "an update with no readiness flags preserves the current readiness or its needs-triage absence",
    ...base,
  ];
  if (entityArtifact && artifact === "todo" && verb === "resolve") return ["select one TODO item with its bare ten-letter --id; numeric, prefixed, composite, alias, and path identities are unavailable", ...base];
  if (entityArtifact && artifact === "todo") return [
    "a bare ten-letter TODO item ID is assigned by the CLI; status starts open",
    "supplying any readiness flag declares complete readiness: include --capability, --reason, --queue-rank, and --order-reason; omitted dependencies, blocker, and gate become [], null, and null",
    "omit every readiness flag to create a valid needs-triage TODO",
    ...base,
  ];
  if (entityArtifact && artifact === "docs" && verb === "update") return ["select one documentation inventory entry with its bare ten-letter --id; path remains record data, not identity", ...base];
  if (entityArtifact && artifact === "docs") return ["a bare ten-letter documentation inventory ID is assigned by the CLI; path remains record data", ...base];
  if (artifact === "decisions" && verb === "update") return ["select one base decision with its bare --id; numeric selectors are unavailable", "update replaces only that decision's authority-owned satisfaction entity after transition validation", ...base];
  if (artifact === "decisions" && verb === "amend") return ["select one base decision with its bare --id and current --base-sha256", "supply at least one amendable content field; satisfaction remains a separate mutation", "apply publishes one immutable revision entity; identical retries converge and same-base divergence conflicts", ...base];
  return [entityArtifact ? "a bare ten-letter ID is assigned by the CLI; do not pass an identity" : "the writer assigns canonical identity", ...base];
}

export function exampleFor(artifact: WritableArtifact, verb: string): string {
  const declaration = loadMutationGrammar().operations.find((operation) => operation.artifact === artifact && operation.verb === verb);
  if (declaration?.examples[0]) return declaration.examples[0];
  return `agentera state ${artifact} ${verb} --format json`;
}

export function renderExplainText(explain: Record<string, unknown>): string {
  const lines = [
    `usage: agentera state ${explain.artifact} ${(explain as { requested_verb?: string }).requested_verb ?? "explain --all"} [flags]`,
    "",
    `${explain.artifact} (${explain.path ?? "mutation grammar"})`,
    `Class: ${String(explain.mutation_class ?? "all")}`,
    `Contract digest: ${String(explain.contract_digest ?? "unknown")}`,
  ];
  const fields = Array.isArray(explain.fields) ? explain.fields as Array<Record<string, unknown>> : [];
  if (fields.length) {
    const required = fields.filter((field) => field.required);
    const optional = fields.filter((field) => !field.required);
    for (const [heading, entries] of [["Required", required], ["Optional", optional]] as const) {
      if (!entries.length) continue;
      lines.push("", `${heading}:`);
      for (const field of entries) {
        const values = Array.isArray(field.valid_values) ? ` one of: ${(field.valid_values as string[]).join(", ")}` : "";
        lines.push(`  ${String(field.flag).padEnd(24)}${values || String(field.description ?? field.field)}`);
      }
    }
  }
  const input = explain.input as Record<string, unknown> | undefined;
  if (input?.mode === "structured") lines.push("", "Required:", "  --input PATH             YAML/JSON document; use - for stdin");
  lines.push("", "Recovery:", `  ${String(explain.recovery ?? "Correct the input and retry; no state was changed.")}`, "", "Example:", `  ${String(explain.example ?? "")}`);
  return lines.join("\n") + "\n";
}
