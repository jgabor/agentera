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
import { structuredInputDescriptor, structuredInputSchemaProjection } from "./input.js";
import { artifactSchemaFieldsForOperation } from "../../registries/artifactSchemaProjection.js";
import { progressWriteGuidance } from "../progressWritePolicy.js";

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
        : artifact === "plan" && field.flag === "--id" && ["update", "set-status", "supersede", "record-evaluation"].includes(verb)
          ? "Bare ten-letter task ID returned by plan task append or list."
          : artifact === "plan" && field.flag === "--plan"
            ? "Bare ten-letter plan ID returned by plan create or list."
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
    ...(spec.inputOptional ? { optional: true } : {}),
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
    allow_force: spec.allowForce,
    ...(spec.allowForce ? {
      force_semantics: artifact === "plan" && verb === "create"
        ? "With exactly one canonical open predecessor, --force archives it unchanged and publishes a successor whose previous_plan_archived field contains the predecessor's bare ID. Multiple open predecessors are rejected."
        : artifact === "plan" && verb === "archive"
          ? "--force archives an open selected plan without changing task, evaluation, or completion history. An implicit archive rejects multiple open candidates."
          : "--force is accepted only where the operation's locked canonical-state decision permits it.",
    } : {}),
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
    const structured = structuredInputDescriptor(artifact, verb);
    result.input_schema = {
      flag: "--input",
      sources: spec.inputSources,
       parser: "yaml_or_json_mapping",
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
                : artifact === "todo"
                  ? verb === "correct-owners" ? ["OWNER_MAPPING"] : ["TODO_PUBLIC", "TODO_OPERATIONAL"]
                 : artifact === "progress"
                   ? ["CYCLE", "CONTEXT", "GLOSSARY_CAVEAT"]
                   : artifact === "decisions"
                     ? ["DECISION", "ALTERNATIVES"]
                     : ["HEADER", "PLAN", "SCOPE", "TASK"],
    };
    if (structured) {
      const projection = structuredInputSchemaProjection(structured);
      result.input_schema = {
        ...(result.input_schema as Record<string, unknown>),
        structured_fields: projection.fields,
        semantics: projection.semantics,
        owned_fields: projection.owned_fields,
        immutable_fields: projection.immutable_fields,
        bounds: projection.bounds,
        examples: projection.examples,
      };
    }
    const artifactSchemaFields = artifactSchemaFieldsForOperation(
      validator.loadSchema(artifact),
      verb,
    );
    if (artifactSchemaFields.length > 0)
      result.input_schema = {
        ...(result.input_schema as Record<string, unknown>),
        artifact_schema_fields: artifactSchemaFields,
      };
    if (artifact === "progress" && verb === "append")
      result.input_schema = { ...(result.input_schema as Record<string, unknown>), record_fields: ["timestamp", "type", "phase", "what", "inspiration", "discovered", "verified", "next", "context", "glossary_caveat"] };
    if (artifact === "decisions" && verb === "append")
      result.input_schema = { ...(result.input_schema as Record<string, unknown>), record_fields: ["date", "question", "context", "alternatives", "choice", "reasoning", "confidence", "feeds_into"] };
    if (artifact === "decisions" && verb === "amend")
      result.input_schema = { ...(result.input_schema as Record<string, unknown>), record_fields: ["question", "context", "alternatives", "choice", "reasoning", "confidence", "feeds_into"] };
    if (artifact === "plan" && verb === "append")
      result.input_schema = { ...(result.input_schema as Record<string, unknown>), record_fields: ["name", "depends_on", "acceptance", "evidence", "blocked_reason"] };
    if (artifact === "plan" && verb === "update")
      result.input_schema = { ...(result.input_schema as Record<string, unknown>), record_fields: ["name", "depends_on", "acceptance", "evidence", "blocked_reason", "surprise"], clearable_patch_fields: ["depends_on", "acceptance", "evidence", "blocked_reason"] };
    if (artifact === "todo" && verb === "correct-owners") {
      result.input_schema = {
        ...(result.input_schema as Record<string, unknown>),
        record_fields: ["schema_version", "owners", "owners.id", "owners.source_line"],
      };
    } else if (artifact === "todo") {
      result.input_schema = {
        ...(result.input_schema as Record<string, unknown>),
        typed_fields: ["kind", "target_version", "title", "requirements", "acceptance", "release_blocker", "severity", "readiness"],
        clearable_patch_fields: ["target_version", "requirements", "acceptance", "readiness"],
        full_record_required_fields: ["kind", "target_version", "title", "requirements", "acceptance", "release_blocker", "severity"],
      };
    }
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
  if (entityArtifact && artifact === "plan" && verb === "create") return [
    "the CLI assigns bare ten-letter envelope IDs to the plan and each task and publishes one canonical file per entity",
    "task numbers and dependency values in this atomic input are create-local symbolic ordinals; the writer removes them and resolves dependencies to bare task IDs",
    "legacy composite header.id values are migration-only and never public selectors",
    "without --force, an open plan blocks creation; with exactly one open predecessor, --force archives it unchanged and writes its bare ID to successor.previous_plan_archived",
    "multiple open predecessors reject before effects; preview and apply derive the same lifecycle decision under the writer lock",
    ...base,
  ];
  if (entityArtifact && artifact === "plan" && verb === "record-evaluation") return [
    "select one task entity with its bare ten-letter --id; numeric and composite selectors are unavailable",
    "evaluate before completing a task during normal orchestration",
    "a first PASS on an unevaluated complete replacement is recovery only when an open same-plan superseded predecessor names it in superseded_by",
    ...base,
  ];
  if (entityArtifact && artifact === "plan" && verb === "supersede") return [
    "select one task entity with its bare ten-letter --id; numeric and composite selectors are unavailable",
    "each replacement must be complete with latest persisted PASS",
    "if a non-PASS replacement is not already referenced by a historical superseded predecessor, reopen it, record PASS, complete it, and retry",
    "if a referenced historical replacement is unevaluated complete, record its allowed first PASS while it remains complete, then retry",
    "if a referenced historical replacement has an existing non-PASS evaluation, first-PASS recovery is unavailable; use another complete latest-PASS replacement, or keep or archive the plan without claiming completion as applicable",
    ...base,
  ];
  if (entityArtifact && artifact === "plan" && verb === "update") return ["select one task entity with its bare ten-letter --id; supply an omission-preserving YAML/JSON task patch through --input", "task status, supersession, evaluation, and plan lifecycle remain flag-only transitions; surprise remains plan-level content", ...base];
  if (entityArtifact && artifact === "plan" && verb === "set-status") return ["select one task entity with its bare ten-letter --id; lifecycle status is a flag-only transition", ...base];
  if (entityArtifact && artifact === "plan" && verb === "append") return ["the CLI assigns a bare ten-letter ID to the new task entity", "supply one complete YAML/JSON task record through --input; dependencies must be bare ten-letter IDs in the selected plan", ...base];
  if (entityArtifact && artifact === "plan" && verb === "archive") return [
    "archive a complete plan normally; --force archives an unfinished selected plan without changing task, evaluation, or completion history",
    "an implicit archive rejects multiple open candidates; select an exact historical plan with its bare --plan ID",
    ...base,
  ];
  if (entityArtifact && artifact === "plan" && verb === "replace") return [
    "name the predecessor and successor with bare IDs from canonical evidence; never infer roles from list order",
    "when competing open plans block selection, use npx -y agentera@next state plan replace --predecessor PREDECESSOR_ID --successor SUCCESSOR_ID --format json only after the complete recovery pair is known",
    "pending plan replacement journals block plan reads until the exact retry completes or restores the operation",
    ...base,
  ];
  if (entityArtifact && artifact === "plan") return [
    "the active plan entity is selected by lifecycle state",
    ...(verb === "set-plan-status" ? ["open-to-complete requires every superseded_by replacement to be complete with latest persisted PASS; historical unevaluated complete replacements may record their allowed first PASS, then retry"] : []),
    ...base,
  ];
  if (entityArtifact && artifact === "experiments") return ["select the owner with its bare ten-letter --objective ID; numeric and composite selectors are unavailable", "omit --id for a new immutable experiment; pass an existing bare --id only for exact replay", ...base];
  if (entityArtifact && artifact === "objective" && verb === "update") return ["select one objective with its bare ten-letter --id; numeric selectors are unavailable", "the CLI preserves that ID while replacing the validated objective record", ...base];
  if (entityArtifact && artifact === "objective") return ["a bare ten-letter objective ID is assigned by the CLI; do not pass an identity", ...base];
  if (entityArtifact && artifact === "todo" && verb === "update") return [
    "for a singleton, select one TODO item with its bare ten-letter --id; numeric, prefixed, composite, alias, and path identities are unavailable",
    "for a singleton, the input document is a patch: omitted fields preserve state and only target_version, requirements, acceptance, and readiness accept typed clears",
    "for a batch, omit --id and supply one strict agentera.todoUpdateBatch.v1 envelope; preview it with --dry-run before exact confirmed apply",
    "public fields are TODO.md-owned; readiness, dependencies, gates, and evidence are Agentera-owned",
    ...base,
  ];
  if (entityArtifact && artifact === "todo" && ["set-severity", "supersede", "resolve", "reopen"].includes(verb)) return [
    "select one TODO item with its bare ten-letter --id; lifecycle transitions are flag-only and accept no --input record",
    "supply a reason and YYYY-MM-DD date; supersede additionally requires a distinct existing replacement ID",
    ...base,
  ];
  if (entityArtifact && artifact === "todo" && verb === "correct-owners") return [
    "supply every canonical TODO ID with one current one-based Markdown source_line through --input",
    "preview is read-only; apply requires the same owner mapping, its exact effect SHA-256, and --yes",
    "the correction is available only for marker-absent unsafe-inactive state; exact replay validates the stored owner-mapping authorization",
    ...base,
  ];
  if (entityArtifact && artifact === "todo") return [
    "a bare ten-letter TODO item ID is assigned by the CLI; status starts open",
    "create requires a full typed TODO record; readiness is optional and absent means needs-triage",
    "the public marker is rendered as [kind:target] and is not stored in title prose",
    ...base,
  ];
  if (entityArtifact && artifact === "docs" && verb === "update") return ["select one documentation inventory entry with its bare ten-letter --id; path remains record data, not identity", ...base];
  if (entityArtifact && artifact === "docs") return ["a bare ten-letter documentation inventory ID is assigned by the CLI; path remains record data", ...base];
  if (artifact === "progress" && verb === "append") return [...progressWriteGuidance(), "when the policy authorizes or requires progress, supply one cycle mapping with --input PATH or --input -; the writer assigns id, artifact, and publication_order", "record content flags are retired; inspect the structured record_fields in explain before writing", ...base];
  if (artifact === "decisions" && verb === "append") return ["a bare ten-letter ID is assigned by the CLI; do not pass an identity", "supply one decision record mapping with --input PATH or --input -; the writer assigns id and artifact", "record content flags are retired; satisfaction remains a separate flag-only transition", ...base];
  if (artifact === "decisions" && verb === "update") return ["select one base decision with its bare --id; numeric selectors are unavailable", "update replaces only that decision's authority-owned satisfaction entity after transition validation", ...base];
  if (artifact === "decisions" && verb === "amend") return ["select one base decision with its bare --id and current --base-sha256", "supply amendable decision content with --input PATH or --input -; record content flags are retired", "apply publishes one immutable revision entity; identical retries converge and same-base divergence conflicts", ...base];
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
  if (explain.allow_force === true) lines.push("", "Optional:", `  --force                  ${String(explain.force_semantics ?? "Apply the operation's force contract.")}`);
  lines.push("", "Recovery:", `  ${String(explain.recovery ?? "Correct the input and retry; no state was changed.")}`, "", "Example:", `  ${String(explain.example ?? "")}`);
  return lines.join("\n") + "\n";
}
