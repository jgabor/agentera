import { ArtifactSchemaValidator } from "../../hooks/validateArtifact/index.js";
import { iterGroupEntries } from "../../hooks/validateArtifact/schema.js";
import { confidenceFloor, terminologyProposalDigest } from "../../audit/terminologyDrift.js";
import { createHash } from "node:crypto";
import { loadTodoReadinessContract } from "../../registries/todoReadinessContract.js";
import { DOC_STATUSES, TODO_SEVERITIES } from "../todoDocsEntityValidation.js";
import { structuredInputDescriptor, structuredInputSchemaProjection } from "./input.js";
import { operationSpec, type WritableArtifact } from "./operations.js";
import { loadStateStorageAuthority } from "../stateStorageAuthority.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import { decisionOverlayContract } from "../archiveDiscovery.js";
import { preCutoverCommandFromBare } from "../../cli/preCutoverCommand.js";

const field = (path: string, type: string, required: boolean, description: string) => ({
  path,
  type,
  required,
  description,
});

/** Only the field groups actually consumed by these record writers are projected.
 * Aggregate identity, paths, compaction and historical lifecycle schemas are not
 * operation inputs. The entity writer qualifications below remain explicit.
 */
function recordFields(artifact: WritableArtifact, verb: string): unknown[] {
  const descriptor = structuredInputDescriptor(artifact, verb);
  if (descriptor) return structuredInputSchemaProjection(descriptor).fields as unknown[];
  if (artifact === "objective")
    return [
      field("header", "mapping", true, "Objective header, without header.id."),
      field("header.title", "string", true, "Non-empty display title; identity is independent of title."),
      {
        ...field("header.status", "string", true, "Current objective lifecycle."),
        enum: ["open", "active", "closed"],
      },
      field("header.created", "string", false, "Creation date used for ordering when present."),
      field("objective", "mapping", true, "Objective content."),
      field("objective.description", "string", true, "Non-empty objective description."),
      field("objective.measurement", "string", true, "Non-empty measurement method."),
      field("metric", "mapping", true, "Metric content."),
      ...["description", "direction", "unit"].map((name) => field(`metric.${name}`, "string", true, "Non-empty metric attribute.")),
      field("baseline", "mapping", true, "Baseline content."),
      field("baseline.description", "string", true, "Non-empty baseline description."),
      field("scope", "mapping", true, "Objective boundaries."),
      field("scope.included", "list", true, "Non-empty included scope list."),
      field("scope.excluded", "list", true, "Excluded scope list; may be empty."),
    ];
  if (artifact === "glossary")
    return [
      {
        ...field("schema_version", "string", true, "Exact publication request version."),
        enum: ["agentera.glossaryPublicationRequest.v1"],
      },
      field("proposal", "mapping", true, "Exact canonical terminology_drift proposal emitted by Audit; no undeclared fields."),
      field("proposal.family", "string", true, "Must be terminology_drift."),
      field("proposal.concept", "string", true, "Non-empty concept."),
      field("proposal.proposed_canonical_term", "string", true, "Best-supported term under Audit ordering: evidence count, then term tie-break. Term identities are Unicode caseless-exact unique."),
      field("proposal.canonical_evidence", "mapping[]", true, "Non-empty distinct source-line evidence in canonical Audit order."),
      field("proposal.canonical_evidence[].source_path", "string", true, "Safe project-relative source path; symlink escape and unsafe paths reject."),
      field("proposal.canonical_evidence[].line", "integer", true, "Positive one-based source line containing the cited term."),
      field("proposal.canonical_evidence[].source_record_sha256", "string", true, "Lowercase SHA-256 of exact source line bytes, excluding line terminator."),
      field("proposal.variants", "mapping[]", true, "Non-empty canonical Audit-ordered variants, each exactly term and evidence."),
      field("proposal.variants[].term", "string", true, "Non-empty unique term distinct from canonical term under Unicode caseless-exact comparison."),
      field("proposal.variants[].evidence", "mapping[]", true, "Same complete source_path, line, source_record_sha256 shape as canonical_evidence; identities distinct within each term."),
      {
        ...field("proposal.severity", "string", true, "Confidence below 70 requires info."),
        enum: ["critical", "warning", "info"],
      },
      field("proposal.confidence", "integer", true, `Integer from ${confidenceFloor()} through 100 (protocol CONFIDENCE_SCALE CS3 floor); below 70 requires info severity.`),
      field("proposal.personal_divergence", "mapping", false, "When present exactly personal_term (non-empty) and project_term (equal to proposed_canonical_term); this does not authorize personal-profile reads or writes."),
      field("proposal.proposal_digest", "string", true, "Lowercase SHA-256 of normalized canonical proposal JSON, excluding proposal_digest. Copy the exact Audit value; changing content invalidates approval."),
      field("confirmation", "mapping", true, "Exactly proposal_digest, confirmed_by and confirmed_at; no generic consent."),
      field("confirmation.proposal_digest", "string", true, "Must equal the submitted canonical proposal digest."),
      field("confirmation.confirmed_by", "string", true, "Must be user, backed by actual explicit user approval."),
      field("confirmation.confirmed_at", "string", true, "Valid ISO-8601 date-time with seconds and timezone; optional fractional seconds."),
    ];
  if (artifact === "docs")
    return [
      field("document", "string", true, "Non-empty documentation name; the canonical identity is the writer-assigned bare ID."),
      field("path", "string", true, "Non-empty path stored as inventory data, never an output destination or a document write."),
      field("last_updated", "string", true, "YYYY-MM-DD; supplied by the caller, not defaulted."),
      { ...field("status", "string", true, "Inventory status."), enum: DOC_STATUSES },
    ];
  if (artifact === "todo" && ["create", "update"].includes(verb)) {
    const readiness = loadTodoReadinessContract();
    return [
      field("kind", "string", verb === "create", "Lowercase identifier matching ^[a-z][a-z0-9_-]{0,31}$."),
      field("target_version", "string|null", verb === "create", "Non-empty version string or null. Null clears on update."),
      field("title", "string", verb === "create", "Non-empty title; description is retired and rejected as input."),
      field("requirements", "string[]|null", verb === "create", "Requirements; null clears on update. Use [] in a complete record."),
      field("acceptance", "string[]|null", verb === "create", "Acceptance criteria; null clears on update. Use [] in a complete record."),
      field("release_blocker", "boolean", verb === "create", "Explicit false is the non-blocking value; cannot be cleared on update."),
      {
        ...field("severity", "string", verb === "create", "Public severity."),
        enum: TODO_SEVERITIES,
      },
      {
        ...field("readiness", "mapping|null", false, "Complete replacement, not a nested patch; null clears. Every declared member is required."),
        fields: readiness.fields,
        allowed_capabilities: readiness.allowedDestinations,
      },
    ];
  }
  const groups: Record<string, Record<string, string>> = {
    plan: {
      HEADER: "header",
      PLAN: "",
      SCOPE: "scope",
      TASK: "tasks[]",
      UNKNOWN: "unknowns[]",
      REJECTED: "rejected[]",
    },
    experiments: { EXPERIMENT: "" },
    health: {
      AUDIT: "",
      DIMENSION: "dimensions_detail[]",
      FINDING: "dimensions_detail[].findings[]",
      TRENDS: "trends",
      PATTERNS: "patterns",
    },
  };
  if (!groups[artifact]) return [];
  const schema = new ArtifactSchemaValidator().loadSchema(artifact);
  if (!schema) throw new Error(`Missing ${artifact} record schema.`);
  const fields: unknown[] = [];
  for (const [group, prefix] of Object.entries(groups[artifact])) {
    for (const entry of iterGroupEntries(schema, group)) {
      const name = String(entry.field);
      const namePath = prefix ? `${prefix}.${name}` : name;
      if (["id", "header.id", "number", "appended_at", "archive_identity", "previous_plan_archived", "task_ids", "replacement_input_sha256"].includes(namePath)) continue;
      if (name === "entry") continue;
      const { id: _id, parent: _parent, field: _field, ...definition } = entry;
      fields.push({
        ...definition,
        path: namePath,
        ...(artifact === "health" && namePath === "date" ? { required: false, default: "today (local date)" } : {}),
        ...(artifact === "plan" && namePath === "tasks[].number"
          ? {
              description: "Create-local sequential ordinal 1..N; removed and resolved to bare task IDs on publication.",
            }
          : {}),
        ...(artifact === "experiments" && namePath === "regression"
          ? {
              required: true,
              description: "Regression evidence is required by the canonical experiment record contract, including baseline publication.",
            }
          : {}),
      });
    }
  }
  if (artifact === "plan") {
    // Complete-plan create/replace retain these fields outside the aggregate
    // TASK schema; they do not use the append/update field-type validator.
    fields.push(
      field(
        "tasks[].evidence",
        "any",
        false,
        "Optional task evidence, conventionally a string or list of strings. Retained as supplied by complete-plan create/replace, with no field-specific type or non-empty check. Omission leaves it absent; null is retained, not a patch clear. General plan validation and budgets still apply.",
      ),
      field(
        "tasks[].blocked_reason",
        "any",
        false,
        "Optional task blocker explanation, conventionally a string. Retained as supplied by complete-plan create/replace, with no field-specific type, non-empty or blocked-status requirement. Omission leaves it absent; null is retained, not a patch clear. General plan validation and budgets still apply.",
      ),
    );
  }
  return fields;
}

const INPUT_EXAMPLES: Record<string, Record<string, unknown>> = {
  "progress.append": {
    type: "feat",
    phase: "build",
    what: "Add bounded operation guidance",
    context: { intent: "Explain accepted writer inputs" },
  },
  "decisions.append": {
    question: "Which input format?",
    context: "Automation needs explicit types.",
    alternatives: { chosen: "JSON", rejected: ["Positional prose"] },
    choice: "JSON",
    reasoning: "Preserves nested types.",
    confidence: "firm",
  },
  "decisions.amend": { reasoning: "JSON and YAML both preserve nested types." },
  "plan.append": {
    name: "Verify operation examples",
    depends_on: [],
    acceptance: ["GIVEN an example WHEN previewed THEN validation passes"],
  },
  "plan.update": { evidence: ["Operation example preview passed"] },
  "plan.create": {
    header: { level: "light", created: "2026-09-13", status: "open", title: "Operation guidance" },
    what: "Explain typed state operations through `agentera state plan explain`.",
    why: "Callers need accepted inputs.",
    scope: { included: ["Writer explanations"], excluded: ["Writer behavior"] },
    tasks: [
      {
        number: 1,
        name: "Explain operations",
        status: "pending",
        acceptance: ["GIVEN an operation WHEN explained THEN its input is documented"],
      },
    ],
  },
  "health.append": {
    dimensions: ["artifact_freshness"],
    findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 },
    trajectory: "stable",
    grades: { artifact_freshness: "A" },
    dimensions_detail: [
      {
        name: "artifact_freshness",
        grade: "A",
        summary: "Operation guidance matches the writer.",
        findings: [],
      },
    ],
  },
  "objective.create": {
    header: { title: "Reduce latency", status: "open", created: "2026-09-13" },
    objective: {
      description: "Reduce CLI latency",
      why: "Users wait",
      measurement: "Fixed latency harness",
      constraints: [],
    },
    metric: { description: "p95 latency", direction: "minimize", unit: "ms" },
    baseline: { description: "100 ms" },
    gates: {},
    scope: { included: ["CLI"], excluded: ["Network"] },
  },
  "experiments.publish": {
    date: "2026-09-13 09:00",
    label: "baseline",
    hypothesis: "Record the initial measurement",
    method: "Fixed latency harness",
    change: "No change",
    metric: { primary_value: "100 ms", delta_vs_baseline: "0 ms" },
    regression: "Baseline harness passed",
    status: "baseline",
    conclusion: "Baseline recorded",
  },
  "todo.create": {
    kind: "task",
    target_version: null,
    title: "Explain writer input",
    requirements: [],
    acceptance: [],
    release_blocker: false,
    severity: "normal",
  },
  "todo.update": { title: "Explain all writer input" },
  "todo.correct-owners": {
    schema_version: "agentera.todoOwnerCorrection.v1",
    owners: [{ id: "abcdefghij", source_line: 3 }],
  },
  "docs.create": {
    document: "README.md",
    path: "README.md",
    last_updated: "2026-09-13",
    status: "current",
  },
};

const RULES: Record<string, string[]> = {
  "progress.append": [
    "One immutable cycle, not a cycles/archives wrapper. Missing timestamp defaults to local now; supply a stable timestamp when replaying. Writer metadata and publication_order are excluded from logical replay comparison.",
    "An exact logical record replays without allocating a new publication order. Glossary caveat events must satisfy the bounded caveat lifecycle; ordinary routine progress is not required unless the progress-write policy calls for it.",
  ],
  "decisions.append": [
    "One immutable decision, not a decisions wrapper. Missing date defaults to local today. Exactly one chosen alternative; mapping input normalizes to an ordered list. List order is significant for replay.",
    "Ordered alternatives contain non-empty name and status chosen|rejected; exactly one chosen. Do not submit number, satisfaction, or writer identity. Exact normalized content is an idempotent replay.",
  ],
  "decisions.amend": [
    "Non-empty omission-preserving content patch. Date, number, satisfaction and identity cannot change. alternatives.chosen replaces; rejected alternatives append uniquely in caller order.",
    "--base-sha256 is the current effective SHA-256 returned by exact get. The revision is immutable and bound to that base; exact replay does not add another revision. Stale/divergent requests reject; reread the decision and reconsider the patch instead of changing the hash blindly.",
  ],
  "decisions.update": [
    "Only satisfaction changes; the base decision remains immutable. Provisionally satisfied requires non-empty evidence. User-confirmed satisfaction requires non-empty --confirmed-by and --confirmed-at strings. Use the user's attribution and an ISO timestamp backed by actual user confirmation; agent inference is not confirmation. Unlike glossary publication, this parser does not enforce the literal user or a timestamp format.",
    "Read the current satisfaction before choosing a transition. Identical satisfaction is a no-effect replay. A new permitted update replaces satisfaction metadata; it is not an immutable approval receipt.",
  ],
  "plan.create": [
    "One complete plan document, not an entity envelope. header.id, task IDs and lineage are writer-owned. Task numbers are create-local ordinals 1..N. Dependencies may be positive integers or canonical numeric strings referring to tasks in this same input; no duplicates, self edges, missing targets or cycles.",
    "Light/full header level, title, created date and lifecycle plus what, why, scope and tasks follow the field definitions. Full plans also require reviewed, critic_issues and design. critic_issues is 'N found, M addressed, K dismissed'; M+K=N and K equals rejected entries, each with issue and rationale.",
    "unknowns and rejected are optional lists of mappings: omit or use [] when empty; no minimum quota. Each unknown requires question, integer affects_task and resolve_by. Each rejected entry requires issue and rationale. Full-plan task acceptance must be non-empty; complete plan creation requires every task complete.",
    "Cannot create archived plans or superseded tasks. Missing task dependencies and acceptance normalize to empty lists where permitted by level. Strict prose lint and candidate validation run before publication.",
    "Only plan create can initialize genuinely fresh state: the exact real Git worktree root with no .agentera directory. A non-Git directory, a Git subdirectory, or an existing marker-absent .agentera directory is not fresh. Legacy, partial or unknown state requires read-only upgrade inspection and the applicable authorized recovery path. Existing open plans block creation unless --force selects exactly one predecessor; multiple open predecessors reject. Force preserves predecessor task/evaluation history and archives it unchanged.",
    "Creation allocates new identities and is not content-idempotent; inspect the returned plan before retrying an uncertain success. --dry-run validates but does not reserve the returned candidate IDs.",
  ],
  "plan.replace": [
    "Exactly one --predecessor and either --successor or --input, never both. New successor input uses the complete plan-create contract; existing successor must be a distinct canonical open plan.",
    "Archives only the explicitly named predecessor and binds reverse lineage on the successor. Replays must match the exact original successor or input digest; divergent retries reject. Interrupted replacement is recovered by retrying the exact command with original input. Do not delete recovery journals or guess predecessor/successor from list order.",
  ],
  "plan.append": [
    "Select an open plan explicitly by --plan or let the writer select the unique open plan. Status defaults to pending; identity, evaluation and supersession are writer-owned. Dependencies are bare IDs of tasks in that plan, not create-local ordinals.",
    "Within the selected plan, one same-name task with identical logical input is a no-effect replay, preserving its ID and execution/evaluation state. Same-name divergent content or multiple identical matches conflict; use update with the exact task ID rather than appending again. A new name allocates a new task ID.",
  ],
  "plan.update": [
    "Select a bare task --id, optionally checked against --plan. Non-empty omission-preserving patch. Null clears only depends_on, acceptance, evidence and blocked_reason. Dependencies must remain same-plan and acyclic.",
    "surprise belongs to the plan, not the task; it cannot be combined with task-field changes. Status/evaluation/supersession are separate verbs. An unchanged resulting record is a no-effect replay.",
  ],
  "plan.set-status": ["Changes only task execution status. Plan lifecycle is separate. A blocked task with an exhausted evaluation retry budget cannot be reopened; completion must respect persisted evaluation and supersession requirements. Identical status is a no-effect replay."],
  "plan.supersede": [
    "The selected task must currently be blocked, except for exact supersession replay. --by is repeatable, one bare replacement ID per occurrence. Replacements must be distinct same-plan tasks, complete with latest persisted PASS. No self-reference, cycles or missing tasks. Reason must be non-empty and at most 500 characters.",
    "Records superseded status and exact replacement evidence; does not fabricate completion or evaluation. Repeat the exact relationship for replay; divergence rejects.",
  ],
  "plan.record-evaluation": [
    "--attempt-id and --provenance must be non-empty. Fail requires non-empty --failure-evidence; pass forbids it. The last attempt with identical ID/result/provenance is a replay; divergent result data conflicts.",
    "New evaluations reject complete, blocked or superseded tasks. Narrow recovery allows a first PASS for an unevaluated complete replacement only when an open same-plan superseded predecessor names it. Two persisted failures block the task; another failed attempt exceeds the retry budget. recorded_at and counters are writer-owned.",
  ],
  "plan.set-plan-status": ["Select --plan or the unique applicable plan. Completing requires every task complete or validly superseded with complete PASS-evaluated replacements. Does not complete tasks, synthesize evaluations or satisfy the user. Identical lifecycle is replay."],
  "plan.archive": ["Archive a complete plan normally. --force permits archiving a selected open plan without changing tasks, evaluation or completion history. Implicit selection rejects competing open candidates. Exact archive replay is no-effect; archive is not completion."],
  "health.append": [
    "One audit record, not an audits wrapper. Omit number, stable_id, artifact_id, entry_number, id, artifact and appended_at. Missing date defaults to today. The writer assigns UTC appended_at only for new publication and ignores it in logical replay comparison.",
    "Audit owns general health writes. Orchestrate may append only terminal-plan artifact_freshness closure after Audit passes. Exact logical audit replay preserves the original timestamp and evidence; no aggregate compaction or numbered archive is written.",
  ],
  "objective.create": [
    "One complete objective document, not a path-selected singleton. Omit header.id and envelope identities. Writer assigns a bare ten-letter ID; title is not identity. Multiple objectives can coexist; use explicit IDs rather than relying on implicit active-objective selection.",
    "Other non-identity content is retained by this complete-record writer, including objective why/constraints, gates, validation and closure evidence. It does not inherit legacy singleton schema validation or path selection.",
    "Requires header title/status, objective description/measurement, metric description/direction/unit, baseline description and scope included/excluded. Included is non-empty; excluded may be empty. Creation allocates identity; inspect objective list after uncertain success.",
  ],
  "objective.update": ["--id selects a bare objective ID. Input replaces the complete objective record, not a patch. Omitted fields are not preserved. Identity remains unchanged. Canonical state and linked experiment baseline ownership are revalidated. An identical record is replay."],
  "experiments.publish": [
    "One immutable experiment owned by --objective, not an experiments wrapper. --id is optional only for exact replay of an existing experiment owned by that objective. No numeric selectors, number, experiment_number, stable_id or objective_id input.",
    "Publish exactly one baseline before any kept/discarded experiment. Status is baseline|kept|discarded. --id with differing record or objective rejects rather than overwriting. Without --id a new identity is allocated; inspect experiment list after uncertain success. No old 10/40/50 deletion or archive-number behavior applies.",
  ],
  "todo.activate": ["Activates reconciliation only for safe inactive evidence. Preview with --dry-run, review the bounded effect, then apply with --yes and the exact returned --effect-sha256. Unsafe ownership requires correct-owners, not force. Already active exact state is replay."],
  "todo.repair": ["Requires an active reconciliation with diagnosable unambiguous repair. Preview, review and bind --yes to the exact --effect-sha256. Stale, ambiguous or unsupported repair is rejected without effects; do not rewrite ownership evidence manually."],
  "todo.correct-owners": [
    "Requires unsafe inactive ownership and a complete bijection of every canonical entity to every managed checkbox row. IDs and positive one-based source_line values must each be unique. Input has exactly schema_version and owners; each owner exactly id and source_line.",
    "A row already bearing an ID must name the mapped owner. Duplicate managed IDs, unknown IDs and mappings that reopen a resolved entity reject. Use the dedicated reopen transition after safe ownership is established; correction is not lifecycle consent.",
    "Preview then --yes with the returned --effect-sha256. The current mapped Markdown rows supply public values and order; operational fields remain unchanged. Stale source lines or digests reject. Recovery requires a fresh reviewed mapping, not generic consent.",
  ],
  "todo.create": [
    "Full typed record, or strict batch envelope. Status, public_order, lifecycle and reconciliation are writer-owned. Active reconciliation is required; creation does not implicitly activate it.",
    "For a batch preview first, then apply with --yes and exact --effect-sha256. Request-local references resolve to writer IDs atomically; no partial batch. Single creation is not an identity replay. After uncertain batch success use the original request and original effect token; changed effects reject.",
  ],
  "todo.update": [
    "Single --id plus non-empty patch, or strict batch envelope without --id. Omitted fields preserve values; null clears target_version, requirements, acceptance or readiness only. readiness is a complete replacement, not a nested patch. Updating title on a legacy record converts public content to typed fields; description remains rejected as input.",
    "Active reconciliation and valid references are required. Batch preview/apply binds exact effects through --yes and --effect-sha256; single unchanged patch is replay. Updating public fields also reconciles the managed Markdown row atomically.",
  ],
  "todo.set-severity": [
    "Single target requires --id, --severity, --reason and --date; alternatively a strict batch envelope. Reason is trimmed, non-empty and at most 500 Unicode code points. Date is a real YYYY-MM-DD date, not defaulted.",
    "Exact lifecycle transition replays. Same reason/date with a different severity conflicts; use a distinct reason/date only for a genuinely new transition. Batches require reviewed effect-bound consent and atomically update public rows and entities.",
  ],
  "todo.resolve": ["Requires an open item, --id, --reason and --date, or a strict resolution batch. Exact prior transition replays on the resolved item; a divergent retry rejects. Batches require preview then exact effect-bound consent. Resolution moves the managed row to the resolved section; no item is deleted."],
  "todo.reopen": ["Requires a resolved item with --id, --reason and --date. Reopens the managed row without inventing readiness or evaluation. Exact prior transition replays; a divergent attempt on an already open item rejects."],
  "todo.supersede": ["Requires an open item and distinct existing --replacement bare TODO ID. Replacement chains must remain acyclic. --reason and --date are required. Resolves the old item and records lifecycle replacement, preserving operational content. Exact transition replays; conflicting replacement rejects."],
  "docs.create": ["One documentation inventory record only. Does not create, edit or validate the referenced document. The writer assigns a bare ID. Creation is not a content-idempotent update. Other non-identity record data is retained; the legacy singleton DOCS mapping is not an input wrapper."],
  "docs.update": ["Select --id and supply the complete inventory entry, not a patch. Omission does not preserve fields. path remains record data, not a write target. Identical full record is a no-effect replay."],
  "glossary.publish": [
    "Only Build publishes the existing project glossary; Audit and Discuss are mutation-free. Exact audited proposal plus explicit user confirmation is required, including digest and zoned ISO timestamp. Generic --yes is not approval.",
    "Revalidates every safe project-relative evidence path, one-based line and SHA-256 against current bytes and term occurrence. Stale evidence, identity collision or divergent approval rejects. Publishes approval and entry atomically; exact approval replay is no-effect. Rerun Audit and obtain fresh confirmation after a meaningful proposal change.",
  ],
};

function glossaryExample(): Record<string, unknown> {
  const source = "export type JsonValue = LegacyJsonValue;";
  const evidence = {
    source_path: "value.ts",
    line: 1,
    source_record_sha256: createHash("sha256").update(source).digest("hex"),
  };
  const finding = {
    family: "terminology_drift" as const,
    concept: "structured value",
    proposed_canonical_term: "JsonValue",
    canonical_evidence: [evidence],
    variants: [{ term: "LegacyJsonValue", evidence: [evidence] }],
    severity: "warning" as const,
    confidence: 84,
  };
  const digest = terminologyProposalDigest(finding);
  return {
    schema_version: "agentera.glossaryPublicationRequest.v1",
    proposal: { ...finding, proposal_digest: digest },
    confirmation: {
      proposal_digest: digest,
      confirmed_by: "user",
      confirmed_at: "2026-09-13T09:00:00Z",
    },
  };
}

function batch(verb: string): Record<string, unknown> | null {
  if (!["create", "update", "set-severity", "resolve"].includes(verb)) return null;
  const version = `agentera.todo${({ create: "Create", update: "Update", "set-severity": "SetSeverity", resolve: "Resolve" } as Record<string, string>)[verb]}Batch.v1`;
  const member = (
    {
      create: "creates",
      update: "updates",
      "set-severity": "transitions",
      resolve: "resolutions",
    } as Record<string, string>
  )[verb];
  const entry =
    verb === "create"
      ? { local_ref: "guidance", record: INPUT_EXAMPLES["todo.create"] }
      : verb === "update"
        ? { id: "abcdefghij", patch: INPUT_EXAMPLES["todo.update"] }
        : {
            id: "abcdefghij",
            reason: "Acceptance verified",
            date: "2026-09-13",
            ...(verb === "set-severity" ? { severity: "normal" } : {}),
          };
  return {
    schema_version: version,
    member,
    bounds: "1..256 entries; exact envelope and entry keys; unique local_ref or id",
    entry_fields: Object.keys(entry),
    local_references: verb === "create" ? "local_ref matches ^[a-z][a-z0-9_-]{0,63}$. readiness.dependencies accepts {local_ref} within this request or {artifact: todo, id}; no missing references, duplicate refs, self edges or cycles." : null,
    selectors: "Batch --input cannot mix single-target flags. Apply requires --yes and the unchanged preview --effect-sha256.",
    example: { schema_version: version, [member]: [entry] },
  };
}

function fullPlanExample(): Record<string, unknown> {
  const light = structuredClone(INPUT_EXAMPLES["plan.create"]);
  return {
    ...light,
    header: {
      ...(light.header as Record<string, unknown>),
      level: "full",
      reviewed: "2026-09-13",
      critic_issues: "0 found, 0 addressed, 0 dismissed",
    },
    design: "Describe each writer operation, then validate its examples against the same writer.",
    overall_acceptance: "GIVEN typed operations WHEN explained THEN callers can validate their inputs without guessing.",
    tasks: [
      ...(light.tasks as unknown[]),
      {
        number: 2,
        name: "Validate explanations",
        depends_on: ["1"],
        status: "pending",
        acceptance: ["GIVEN an explained input WHEN previewed THEN the writer accepts it"],
      },
    ],
  };
}

export function currentOperationDetail(artifact: WritableArtifact, verb: string, explain: Record<string, unknown>): Record<string, unknown> {
  const spec = operationSpec(artifact, verb);
  if (!spec || !RULES[`${artifact}.${verb}`]) throw new Error(`Missing current operation detail for ${artifact}.${verb}.`);
  const exampleKey = artifact === "objective" && verb === "update" ? "objective.create" : artifact === "docs" && verb === "update" ? "docs.create" : artifact === "plan" && verb === "replace" ? "plan.create" : `${artifact}.${verb}`;
  const structured = spec.inputMode === "structured";
  const descriptor = structuredInputDescriptor(artifact, verb);
  const example = artifact === "glossary" ? glossaryExample() : INPUT_EXAMPLES[exampleKey];
  const { document: storage } = loadStateStorageAuthority(resolveSourceRoot());
  const target = storage.entity_target as Record<string, unknown>;
  const definitions = target.entities as Record<string, unknown>[];
  const boundary =
    artifact === "plan"
      ? ["append", "update", "set-status", "supersede", "record-evaluation"].includes(verb)
        ? "plan_task"
        : "plan"
      : (
          {
            progress: "progress_cycle",
            decisions: verb === "append" ? "decision" : verb === "amend" ? "decision_revision" : "decision_satisfaction",
            health: "health_audit",
            objective: "objective",
            experiments: "experiment",
            todo: "todo_item",
            docs: "documentation_inventory_entry",
          } as Record<string, string>
        )[artifact];
  const entity = definitions.find((entry) => entry.boundary === boundary);
  return {
    artifact,
    verb,
    flags: explain.fields,
    input: {
      ...(explain.input as Record<string, unknown>),
      max_utf8_bytes: spec.inputMaxBytes,
      ...(structured
        ? {
            fields: recordFields(artifact, verb),
            ...(descriptor ? { semantics: descriptor.semantics } : {}),
            ...(artifact === "todo" ? { batch: batch(verb) } : {}),
          }
        : {}),
    },
    ownership: {
      writer_owned_fields: spec.ownedFields,
      caller_input_forbidden_fields: spec.cliOwnedFields,
      guidance: explain.guidance,
    },
    preconditions: {
      state: "Completed entity-mode state and project write permission are required to mutate. The sole fresh-state initializer is plan create; explanation is static and does not initialize, upgrade or repair state.",
      operation: explain.preconditions,
    },
    constraints_effects_replay: RULES[`${artifact}.${verb}`],
    ...(artifact === "decisions" && verb === "update"
      ? {
          transitions: {
            allowed_next: decisionOverlayContract().allowedNext,
            exception: "Downgrading user_confirmed_satisfied requires explicit current user confirmation metadata. Ordinary update is a full satisfaction replacement; omitted metadata is not retained automatically.",
          },
        }
      : {}),
    controls: {
      dry_run: "--dry-run validates the selected operation and previews effects; it does not grant apply consent or reserve newly allocated IDs.",
      project: "--project PATH chooses the mutation project (default cwd); unavailable on this static detail query.",
      force: spec.allowForce ? explain.force_semantics : "Not accepted.",
      format: "json",
    },
    examples: {
      commands: (explain.examples as string[]).map(preCutoverCommandFromBare),
      ...(artifact === "plan" && ["create", "replace"].includes(verb) ? { full_input: fullPlanExample() } : {}),
      ...(artifact === "glossary"
        ? {
            fixture_preconditions: { "value.ts": "export type JsonValue = LegacyJsonValue;\n" },
            consent: "The illustrative confirmation is not real approval. Obtain explicit user approval of the exact audited proposal before any project publication.",
          }
        : {}),
      ...(example
        ? {
            input: structuredClone(example),
            qualification: "Illustrative input, not evidence or approval. Use real project facts and replace selector IDs with IDs returned by reads. Preview before apply where appropriate.",
          }
        : {}),
    },
    recovery: explain.recovery,
    validation: {
      ...(entity ? { resulting_entity_record: entity.record } : {}),
      bounds: explain.bounds,
      scope: "The resulting entity contract includes writer-assigned fields; those are not caller input. Input validation and locked state/relationship validation both apply. A preview is not an apply receipt.",
      transaction: "Individual file replacements are atomic. Multi-target writers use their existing rollback or recoverable journal; this is not a global atomic multi-file snapshot. Preserve recovery evidence and retry the exact authorized request after interruption.",
    },
    legacy: "Legacy aggregate wrappers, numeric/composite selectors and archived identity fields are not new writer inputs. Read compatibility or upgrade support does not authorize writing those shapes. This operation does not add a generic singleton or file writer.",
  };
}
