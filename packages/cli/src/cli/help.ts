import { CAPABILITY_ROUTING_NAMES } from "./commands/capability.js";
import { verbsForArtifact, WRITABLE_ARTIFACTS } from "../state/write/operations.js";
import { personalGlossaryOutputContract } from "../registries/glossaryEntryContract.js";
import { personalGlossaryCandidateProjectionContract } from "../registries/glossaryCandidateProjectionContract.js";
import { personalGlossaryCandidateDecisionContract } from "../registries/glossaryCandidateDecisionContract.js";
import { personalGlossaryReviewRecordsContract } from "../registries/glossaryReviewRecordsContract.js";
import { describeRouteReceipt } from "../registries/hybridRoute.js";
import { advertisedValidateFamilyNames } from "./commands/validate.js";
import { entityListFamilies, entityRetrievalFamilyForHelpArgs, type EntityListFamilyHelp } from "../state/entityRetrievalHelp.js";
import { preCutoverCommand } from "./preCutoverCommand.js";
import { HELP_TOP_LEVEL_COMMANDS } from "./dispatch/projections.js";

function lines(title: string, items: string[]): string[] {
  return [title, ...items.map((item) => `  ${item}`), ""];
}

export function printTopLevelHelp(): string {
  const choices = HELP_TOP_LEVEL_COMMANDS.join(",");
  const plans = entityListFamilies().find(({ key }) => key === "plans")!;
  const planListExample = `agentera state ${plans.commandTokens.join(" ")} list --format json`;
  return [
    `usage: agentera [-h] [--version] {${choices}} ...`,
    "",
    "agentera: read and write project state, upgrade installs, and print priming guidance",
    "",
    ...lines("Agent commands:", [
      "prime               Composite orientation briefing, capability startup context, or static guidance",
      "schema              Runtime CLI/schema introspection",
      "route               Privacy-safe request-to-capability routing",
      "state               Routine artifact reads, writes, and advanced artifact query",
      ...CAPABILITY_ROUTING_NAMES.map(
        (name) => `${name.padEnd(19)} Route to ${name} capability guidance`,
      ),
    ]),
    ...lines("User commands:", [
      "upgrade             Preview or apply app/project migration and explicit legacy cleanup",
      "app-home            Resolve the platform Agentera app-home path",
      "doctor              Check Agentera CLI, app, and shared-skill status",
      "report              Privacy-gated usage analytics",
      "--version           Print the installed Agentera CLI version",
    ]),
    ...lines("Maintainer commands:", [
      "check               Validation, verification, lint, and repository compaction gates",
    ]),
    "options:",
    "  -h, --help          show this help message and exit",
    "  --version           print the installed Agentera CLI version and exit",
    "",
    [
      `Examples: ${preCutoverCommand("prime --context status --format json")}`,
      `  ${preCutoverCommand(planListExample.slice("agentera ".length))}`,
      `  ${preCutoverCommand("check verify eval skills --dry-run")}`,
      `  ${preCutoverCommand("report refresh --dry-run")}`,
    ].join("\n"),
  ].join("\n");
}

export function printUpgradeHelp(): string {
  return [
    "usage: agentera upgrade [-h] [--project PROJECT] [--install-root INSTALL_ROOT]",
    "                        [--home HOME] [--channel {stable,development}]",
    "                        [--legacy-cleanup RESOURCE_ID] [--reset-product-v1]",
    "                        [--authorization TOKEN]",
    "                        [--only {artifacts,runtime,cleanup}] [--dry-run] [--yes]",
    "                        [--force] [--verify] [--format {text,json}]",
    "",
    "options:",
    "  -h, --help            show this help message and exit",
    "  --project PROJECT     Project directory whose .agentera artifacts should be migrated",
    "  --install-root PATH   Agentera app home to inspect or update",
    "  --home HOME           Home directory for shared-skill detection and explicit native resource cleanup",
    "  --channel CHANNEL     Update channel: stable (2.x) or development (3.x npm)",
    "  --legacy-cleanup ID   Select one declared native Agentera resource for cleanup",
    "  --reset-product-v1    Preview or authorize the bounded destructive product-v1 reset",
    "  --authorization TOKEN Bind product-v1 apply to the exact reviewed preview scope",
    "  --only PHASE          Upgrade phase to include; may be repeated",
    "  --dry-run             Strict read-only preview; no files, locks, caches, native commands, or telemetry",
    "  --yes                 Explicitly approve migration, selected cleanup, or an authorized product-v1 reset",
    "  --force               Replace only where the migration contract explicitly permits it",
    "  --verify              Verify the current install; full v2-to-v3 apply verifies state and startup automatically",
    "  --format {text,json}  Structured output format",
    "",
    "v2-to-v3 development upgrade (one-way):",
    "  Optional preview: npx -y agentera@next upgrade --channel development --project \"$PWD\" --dry-run",
    "  Full apply:       npx -y agentera@next upgrade --channel development --project \"$PWD\" --yes",
    "  Apply requires a Git worktree whose complete v2 migration source is tracked and unchanged at HEAD.",
    "  Cross-major apply is always full: --only cannot be used; there is no rollback, restore, or non-Git workflow.",
    "",
    "active integration:",
    "  Agentera uses the shared skill at ~/.agents/skills/agentera plus the CLI.",
    "  Current runtime selectors and native plugin, hook, agent, command, descriptor, and marketplace writes are retired.",
    `  Native resource cleanup preview: ${preCutoverCommand("upgrade --legacy-cleanup RESOURCE_ID --dry-run")}`,
    `  Native resource cleanup apply:   ${preCutoverCommand("upgrade --legacy-cleanup RESOURCE_ID --yes")}`,
    "",
    "product-v1 reset (irreversible, no backup or restore):",
    `  Preview: ${preCutoverCommand("upgrade --reset-product-v1 --dry-run --format json")}`,
    `  Authorize: ${preCutoverCommand("upgrade --reset-product-v1 --yes --authorization TOKEN --format json")}`,
  ].join("\n");
}

export function printAppHomeHelp(): string {
  return [
    "usage: agentera app-home [-h] [--install-root PATH] [--home HOME] [--format {text,json}]",
    "",
    "Resolve the Agentera app-home path for agent/bootstrap callers.",
    "",
    "options:",
    "  -h, --help            show this help message and exit",
    "  --install-root PATH   Explicit Agentera app home to resolve",
    "  --home HOME           Home directory for platform default resolution",
    "  --format {text,json}  Structured output format",
  ].join("\n");
}

export function printDoctorHelp(): string {
  return [
    "usage: agentera doctor [-h] [--install-root PATH] [--home HOME] [--project PROJECT]",
    "                       [--expected-version VERSION] [--expect-command CMD] [--retired-resource ID]",
    "                       [--smoke] [--allow-live-model] [--format {text,json}]",
    "",
    "options:",
    "  -h, --help              show this help message and exit",
    "  --install-root PATH     Agentera app home to diagnose",
    "  --home HOME             Home directory for shared-skill diagnosis",
    "  --project PROJECT       Project directory context",
    "  --expected-version VER  Expected app files version",
    "  --expect-command CMD    Required CLI command probe; may be repeated",
    "  --retired-resource ID   Read-only exact retired-resource diagnostic preview",
    "  --smoke                 Run bounded offline smoke checks (no live model calls by default)",
    "  --allow-live-model      Record permission for future live model smoke probes",
    "  --format {text,json}    Structured output format",
    "",
    "Reports read-only app, project-state, shared-skill, and CLI evidence, plus retired-resource diagnostics.",
  ].join("\n");
}

function recordFamilyReadSection(command: string): string[] {
  const families = entityListFamilies().filter(({ commandTokens }) => commandTokens[0] === command);
  if (families.length === 0) return [];
  return [
    "Canonical record-family reads:",
    ...families.flatMap((family) => [
      `  List: ${family.syntax}`,
      `  Get:  ${family.get}`,
      ...(family.commandTokens.length === 1
        ? [family.bareRead === "alias"
            ? `  Bare: agentera state ${family.commandTokens.join(" ")} is a strict alias of List.`
            : `  Bare: rejected with recovery to ${family.bareRecovery}.`]
        : []),
      `  Summary fields: ${family.summaryFields.join(", ")}`,
    ]),
    "",
  ];
}

export function printStateHelp(sub?: string): string {
  const stateCommands = stateCommandNames();
  if (sub === "plan") {
    return [
      ...recordFamilyReadSection("plan"),
      `       agentera state plan {${verbsForArtifact("plan").join(",")}} [write flags]`,
      "",
      "Plan and task reads use bare canonical IDs from entity list results.",
      "Invalid historical archives remain non-fatal compatibility diagnostics unless selected.",
       "Task list accepts an optional bare plan ID and otherwise defaults to the sole open plan; task get requires --id.",
       "Only the displayed bare-ID selectors are accepted.",
       "Plan create rejects an open predecessor unless --force can archive exactly one unchanged; create --force records that predecessor's bare ID in successor.previous_plan_archived.",
       "Targeted replacement is explicit: state plan replace --predecessor ID --successor ID, or --predecessor ID --input PLAN.yaml to create the successor. It changes only the named predecessor lifecycle and derived successor lineage.",
       "Competing open-plan diagnostics retain bounded bare IDs and require explicit roles: state plan replace --predecessor PREDECESSOR_ID --successor SUCCESSOR_ID --format json. They never infer a role from list order.",
       "Archive completed plans normally. Archive an unfinished selected plan with --force; an implicit archive with multiple open plans rejects without effects.",
       "List limits are 1 through 100; structured pages are at most 32,768 UTF-8 bytes and omit whole entries only.",
      "Legacy plan identity collisions return a structured ambiguous error.",
      "",
       "Discover writes: agentera state plan explain --format json",
       "All verbs:         agentera state plan explain --all --format json",
    ].join("\n");
  }
  if (sub === "experiments") {
    return [
      ...recordFamilyReadSection("experiments"),
      "       agentera state experiments publish --objective ID [--id ID] --input EXPERIMENT.yaml --format json",
      "       (publish also accepts --dry-run and --format text)",
      "",
      "Publish is the validated mutation authority and atomically writes one schema-valid experiment.",
      "A byte-equivalent identity retry is idempotent; collisions and pre-publication failures preserve current bytes.",
      "Get verifies archive detail first, then reports full, summary-only, or unavailable detail truthfully.",
      "List and publish require one bare objective ID; get requires one bare experiment ID.",
      "Legacy objective/path collisions return a structured ambiguous error.",
      "",
       "Discover writes: agentera state experiments explain --verb publish --format json",
       "All verbs:         agentera state experiments explain --all --format json",
    ].join("\n");
  }
  if (sub === "glossary") {
    return [
      "usage: agentera state glossary publish --input REQUEST.yaml [--dry-run] --format json",
      "       agentera state glossary explain [--verb publish] --format json",
      "",
      "Build-owned publication validates one audit terminology proposal and proposal-specific user confirmation.",
      "The writer revalidates cited source lines and atomically records a separate immutable approval and shared glossary entry.",
      "Confirmed project variants are enforced by the glossary variant guard; profile and docs-mapping mutation remain outside publication.",
      "Audit and discuss remain mutation-free. Discuss, Plan, and Build use read-only glossary advice with project precedence, proven-gap personal fallback, and host review for inferred equivalence.",
      "",
       "Discover writes: agentera state glossary explain --verb publish --format json",
       "All verbs:         agentera state glossary explain --all --format json",
    ].join("\n");
  }
  if (sub === "objective") {
    return [
      ...recordFamilyReadSection("objective"),
      "       agentera state objective create --input OBJECTIVE.yaml --format json",
      "       agentera state objective update --id ID --input OBJECTIVE.yaml --format json",
      "",
      "Objective create publishes one independent entity; update replaces that entity through rollback-safe publication.",
      "Active-objective inference is not a public record-family read.",
      "",
       "Discover writes: agentera state objective explain --format json",
       "All verbs:         agentera state objective explain --all --format json",
    ].join("\n");
  }
  if (sub === "todo") {
    return [
      ...recordFamilyReadSection("todo"),
       "       agentera state todo activate|repair --dry-run|--effect-sha256 SHA256 --yes --format json",
       "       agentera state todo correct-owners --input OWNER_MAPPING.yaml --dry-run|--effect-sha256 SHA256 --yes --format json",
       "       agentera state todo create --input TODO.yaml --format json",
       "       agentera state todo update --id ID --input TODO-PATCH.yaml --format json",
       "       agentera state todo set-severity --id ID --severity LEVEL --reason TEXT --date YYYY-MM-DD --format json",
       "       agentera state todo supersede --id ID --replacement ID --reason TEXT --date YYYY-MM-DD --format json",
       "       agentera state todo resolve|reopen --id ID --reason TEXT --date YYYY-MM-DD --format json",
      "",
      "Each TODO item is one independently mutable canonical entity. IDs are bare ten-letter project-wide identities.",
      "TODO views are bounded in severity/status and Markdown public order; exact get returns complete detail.",
       "Create accepts a full typed YAML/JSON record; update is a patch, so omitted fields preserve state and null/empty-list clears apply only to declared clearable fields.",
       "Readiness is Agentera-owned operational state; public fields are owned by TODO.md and divergent public values fail before effects.",
       "Lifecycle verbs are flag-only typed transitions and cannot be supplied as record content.",
       "Marker-absent repositories must complete migration before ordinary TODO access.",
      "",
       "Discover writes: agentera state todo explain --format json",
       "All verbs:         agentera state todo explain --all --format json",
    ].join("\n");
  }
  if (sub === "docs") {
    return [
      ...recordFamilyReadSection("docs"),
      "       agentera state docs create --input ENTRY.yaml --format json",
      "       agentera state docs update --id ID --input ENTRY.yaml --format json",
      "",
      "Each documentation inventory entry is one independently mutable canonical entity; path is record data, not identity.",
      "Mappings, conventions, coverage, and editorial configuration retain whole-document authority in .agentera/docs.yaml.",
      "List views are bounded by path then ID; exact get returns complete detail.",
      "",
        "Discover writes: agentera state docs explain --format json",
        "All verbs:         agentera state docs explain --all --format json",
    ].join("\n");
  }
  if (sub) {
    const verbs = verbsForArtifact(sub);
    const readSection = recordFamilyReadSection(sub);
    return [
      ...readSection,
      ...(readSection.length === 0 ? [`usage: agentera state ${sub} [operation] [options]`] : []),
      ...(verbs.length ? [`       agentera state ${sub} {${verbs.join(",")}} [write flags]`] : []),
      ...(sub === "progress"
        ? ["       agentera state progress append --input <path|-> --format json"]
        : sub === "decisions"
          ? [
              "       agentera state decisions append --input <path|-> --format json",
              "       agentera state decisions update --id ID --satisfaction-state STATE [transition flags] --format json",
              "       agentera state decisions amend --id ID --base-sha256 HASH --input <path|-> --format json",
            ]
          : []),
      ...(verbs.length
        ? [
            "",
             `Discover writes: agentera state ${sub} explain --format json`,
             `All verbs:        agentera state ${sub} explain --all --format json`,
            `Per verb:        agentera state ${sub} explain --verb VERB --format json`,
          ]
        : []),
      ...(sub === "progress"
        ? ["Record content is one bounded YAML/JSON mapping; content flags are retired and the writer assigns id, artifact, and publication_order."]
        : sub === "decisions"
          ? ["Append and amend accept one bounded YAML/JSON mapping; satisfaction update is a flag-only transition and rejects --input."]
          : []),
      "",
      "options:",
      "  -h, --help            show this help message and exit",
      "  --format FORMAT       Output format: text, json, or yaml",
    ].join("\n");
  }
  return [
    `usage: agentera state [-h] {${stateCommands.join(",")}} ...`,
    "",
    "Routine artifact reads, writes, and advanced artifact query.",
    "Discover typed writes: agentera state <artifact> explain --format json",
    "Discover all verbs: agentera state <artifact> explain --all --format json",
  ].join("\n");
}

export function printStateListHelp(family: EntityListFamilyHelp): string {
  const filterLines = family.filters.length
    ? family.filters.map(({ flag, values }) => `  ${flag.padEnd(35)} Filter; values: ${Array.isArray(values) ? values.join(", ") : values}`)
    : ["  (none)"];
  const identifier = family.familyIdentifier
    ? [
        "Family identifier:",
        `  ${family.familyIdentifier.syntax}${family.familyIdentifier.required ? " (required)" : " (optional)"}`,
        `  ${family.familyIdentifier.description}`,
        "",
      ]
    : [];
  const notes = Object.entries(family.summaryFieldNotes).map(([field, note]) =>
    `  ${field}: ${note.description} Ownership: ${note.ownership}; persisted: ${note.persisted}; ${note.filter ? `--${field.replaceAll("_", "-")} is a filter` : `--${field.replaceAll("_", "-")} is not a filter`}.`,
  );
  return [
    `usage: ${family.syntax}`,
    "",
    `List the ${family.key} retrieval family using the authority-owned bounded projection.`,
    "",
    ...identifier,
    "Filters:",
    ...filterLines,
    "",
    "Summary fields:",
    `  ${family.summaryFields.join(", ")}`,
    ...notes,
    "",
    "Projection selectors:",
    `  ${family.selectors.idsOnly.flag.padEnd(20)} ${family.selectors.idsOnly.description}`,
    `  ${family.selectors.fields.flag.padEnd(20)} ${family.selectors.fields.description}`,
    ...(family.selectors.mutualExclusion ? ["  --ids-only and --fields cannot be combined."] : []),
    "",
    "Bounds and formats:",
    `  limit: minimum ${family.bounds.minimum}, default ${family.bounds.default}, maximum ${family.bounds.maximum}`,
    `  serialized output: at most ${family.bounds.maxUtf8Bytes} UTF-8 bytes; rows and scalar values are not partially returned`,
    `  formats: ${family.formats.join(", ")}`,
    "",
    "Examples:",
    `  ${family.example}`,
    `  ${family.get}`,
    "",
    `Unsupported filters, fields, or selectors report this family's valid vocabulary and a correction based on: ${family.example}`,
  ].join("\n");
}

export function printStateGetHelp(family: EntityListFamilyHelp): string {
  return [
    `usage: ${family.get}`,
    "",
    `Get one complete canonical ${family.key} record by its exact opaque ID.`,
    "",
    "Selectors and formats:",
    "  --id ID              required bare ten-letter canonical identity",
    `  --format FORMAT       ${family.formats.join(", ")}`,
    "",
    `List identities: ${family.example}`,
    `Exact get:       ${family.get}`,
  ].join("\n");
}

export function stateCommandNames(): string[] {
  return [...new Set([
    ...entityListFamilies().map(({ commandTokens }) => commandTokens[0]),
    ...WRITABLE_ARTIFACTS,
    "query",
  ])];
}

export function printCheckHelp(sub?: string): string {
  if (sub === "verify") {
    return [
        "usage: agentera check verify [-h] eval {skills,semantic,routing,glossary} [--format text|json] [options]",
      "",
      "Evaluation verify gates. Smoke verify is retired on the npm self-contained CLI;",
      "use the stable Python line for smoke maintainer harnesses.",
    ].join("\n");
  }
  if (sub === "validate") {
    return [
      "usage: agentera check validate [-h] VALIDATE_FAMILY [options]",
      "",
      "Validate capabilities, state, and retained repository contracts.",
      "",
      "validate families:",
      ...advertisedValidateFamilyNames().map((family) =>
        ["retained-references", "activation-conjunction"].includes(family) ? `  ${family} (source checkout only)` : `  ${family}`,
      ),
    ].join("\n");
  }
  if (sub === "durability") {
    return [
      "usage: agentera check durability [-h] [--project PATH] [--artifact ARTIFACT]",
      "                                [--number N|--id ID] [--limit N] --format {text,json,yaml}",
      "",
      "Read-only local archive and optional reachable Git durability evidence.",
      "This is an explicit migration/readiness diagnostic, not ordinary retrieval grammar.",
      "Git is never required for local state writes and no remote is contacted.",
      "",
      "options:",
      "  -h, --help            show this help message and exit",
      "  --project PATH        Project directory to inspect",
      "  --artifact ARTIFACT   progress, decisions, or health",
      "  --number N            Positive archive entry number; requires --artifact",
      "  --id ID                Bare canonical entity ID after cutover; requires --artifact",
      "  --limit N             Bound returned archive entries (maximum 100)",
      "  --format FORMAT       Output format: text, json, or yaml",
    ].join("\n");
  }
  if (sub) {
    return [
      `usage: agentera check ${sub} [-h] [options]`,
      "",
      "options:",
      "  -h, --help            show this help message and exit",
    ].join("\n");
  }
  return [
    "usage: agentera check [-h] {validate,verify,lint,compact,durability} ...",
    "",
    "Validation, verification, lint, and repository compaction gates.",
  ].join("\n");
}

export function printReportHelp(): string {
  const profileGlossary = personalGlossaryOutputContract();
  const candidateReads = personalGlossaryCandidateProjectionContract();
  const candidateDecision = personalGlossaryCandidateDecisionContract();
  const reviewRecords = personalGlossaryReviewRecordsContract();
  return [
    "usage: agentera report [-h] [--format {text,json}] [--project VALUE] [--sources {active,all}]",
    "                       | agentera report refresh [--dry-run|--consent local-history]",
    "                         [--import-source claude]",
    "                         [--no-<runtime> ...] [--accept-coverage-gap]",
     `                       | ${profileGlossary.command} --input <file|-> [--dry-run] --format json`,
    "                       | agentera report glossary-advice --input <file|-> --format json",
    "                       | agentera report profile-grounding --format json",
    `                       | ${candidateReads.candidateReadCommand} list [--source-family explicit|recurring]`,
    "                         [--provenance-kind KIND] [--scope personal|ambiguous] [--limit N] [--cursor TOKEN] --format json",
    `                       | ${candidateReads.candidateReadCommand} get --candidate-id ID --candidate-revision REVISION`,
    "                         --generation GENERATION --policy-version POLICY --format json",
     `                       | ${candidateDecision.command} --input <file|-> --format json`,
     `                       | ${reviewRecords.command} queue --input <file|-> --format json`,
     `                       | ${reviewRecords.command} disposition --input <file|-> --format json`,
     `                       | ${reviewRecords.command} list [--status pending|terminal] [--limit N] [--cursor TOKEN] --format json`,
     `                       | ${reviewRecords.command} get --review-id ID --candidate-id ID --candidate-revision REVISION`,
     "                         --generation GENERATION --policy-version POLICY --format json",
    "",
    "Privacy-gated usage analytics over an existing corpus.",
    "Default analytics use --sources active and exclude historical imports.",
    "Use --sources all to include historical records with visible provenance.",
     `Personal glossary publication accepts one ${profileGlossary.requestSchemaVersion} mapping with a prior CLI decision and its host receipt; this subcommand requires no project checkout.`,
    "Profile grounding reports one bounded validity object (valid, absent, or repair_needed); only valid responses include non-glossary content.",
    "Build requests bounded glossary advice through structured input; the command is read-only and does not publish or refresh state.",
     "Personal glossary candidate reads are private, user-local, non-interactive, and read-only. They require a readable current bounded",
     "evidence-tier generation and a projection bound to it. They never read a project glossary, refresh evidence, acquire consent,",
     "record review state, or alter the candidate projection. List emits only summaries and bounded",
    "projection-local abstention and coverage counts. Safe context becomes unavailable at its 30-day expiry without changing projection bytes.",
    "Exact read returns only opaque validated occurrences and a currently available safe context.",
    "Both forms emit JSON on stdout. Exit 0 reports a current page or exact candidate, exit 1 reports unavailable/stale state, and exit 2",
    "reports malformed arguments. Copy a returned next_cursor exactly; it binds the collection, generation, policy, filters, limit, order,",
    "and expiry-aware safe-context availability snapshot.",
       `Personal glossary decisions accept either a ${candidateDecision.requestSchemaVersion} host receipt or a ${candidateDecision.receiptConstructionRequestSchemaVersion}`,
     "classification with exact candidate bindings. The CLI binds it to the current private projection, current evidence, and quality",
     "gate, then emits automatic_admission, review_required, or abstain. The classification form constructs and returns its receipt.",
     "It never writes a review, profile, project glossary, candidate projection, or project state. Host confidence cannot enable",
      "inferred automatic admission.",
      "Personal glossary publication consumes a current explicit automatic admission, or one current accepted/corrected review authorization.",
      "Immediately before changing the owned PROFILE.md Glossary section, it revalidates the current candidate, projection, receipt,",
      "decision, explicit user-authored evidence, policy, quality gate, scope, meaning, and revision. It never accepts a profile path,",
      "reads a project glossary, or echoes candidate content. Accepted/corrected review publication revalidates the same current",
      "projection, receipt, decision, evidence, policy, scope, meaning, and revision before the profile effect.",
      "Personal glossary reviews queue only a current review_required decision. Disposition accepts only a fresh signed current-user",
      "agentera-local-host IPC approval verified by the configured user-local Ed25519 public key. It records accept, correct, reject,",
       "or defer without changing a profile entry, project state, candidate projection, or publication. Accept/correct returns only an",
       "opaque authorization for the separate publish command. Exact approval replay is idempotent and conflicting nonce reuse fails.",
       "Canonical v1 pending stores remain readable without mutation; only disposition revalidates and migrates one valid v1 record",
       "to v2, deriving its missing scope from the current validated host receipt. Invalid or ambiguous v1 input has no effects.",
       "Rejected and deferred records suppress a recurrence with the same stable identity, semantic fingerprint, scope, and policy.",
      "Meaning, scope, or policy changes requeue with a visible reopening reason. List and exact reads emit only opaque bindings,",
      "a stable reason, lifecycle dates, status, disposition, and reopening reason. They require the configured",
     "current-user owner and current candidate-projection binding, use opaque snapshot cursors, and never return terms, meanings,",
     "evidence, source, session, project, path, tool, or approval material. Terminal review metadata expires after 90 days through",
     "separate authenticated owner maintenance; reads never perform maintenance.",
    "",
    "Corpus extraction flags (report refresh with --consent local-history):",
    "  These flags deselect runtimes that would otherwise be included when their",
    "  store exists. Full-mode profile runs a Coverage Audit first; skipping an",
    "  available runtime flags the run until --accept-coverage-gap is passed.",
    "  --no-codex            Skip codex even if ~/.codex/sessions exists",
    "  --no-opencode         Skip opencode even if the opencode.db store exists",
    "  --no-copilot          Skip github-copilot even if session-store.db exists",
    "  --no-cursor           Skip Cursor IDE and CLI stores",
    "  --import-source claude Explicitly import local Claude history as historical data.",
    "                         Transcripts can contain secrets, file contents, and command output.",
    "                         Import is read-only, active_runtime=false, and excluded by default analytics.",
    "  --accept-coverage-gap Proceed despite skipped available runtimes (EX2)",
    "  --coverage-audit-only Run the Coverage Audit summary only; do not extract",
  ].join("\n");
}

export function printPrimeHelp(): string {
  return [
    "usage: agentera prime [-h] [--format {text,json,yaml}] [--context CAPABILITY]",
    "                       [--input FILE|-] [--guidance] [--dashboard] [--orientation] [--fields FIELDS]",
    "",
    "Composite orientation briefing, capability startup context, or static guidance.",
    "",
    "options:",
    "  -h, --help            show this help message and end",
    "  --format FORMAT       Output format: text, json, or yaml",
    "  --context CAPABILITY  Emit startup context for a capability (e.g. plan)",
    "  --input FILE|-         Transient agentera.buildExecutionRequest.v1 input; valid only with --context build",
    "  --guidance            Emit static routing guidance",
    "  --dashboard           Emit the prime orientation dashboard",
    "  --orientation         Emit orientation briefing sections",
    "  --fields FIELDS       Comma-separated field filter for JSON/YAML output",
    "",
    "JSON output uses bounded surfaces: bare prime is at most 12000 UTF-8 bytes and status context at most 22500; startup contains one availability projection and aggregate outcome, while schema discovery owns writer detail.",
  ].join("\n");
}

export function printSchemaHelp(): string {
  return [
    "usage: agentera schema [-h] [--format {json,yaml}]",
    "",
    "Runtime CLI and schema introspection.",
    "Includes the state_writer operation matrix and per-artifact write_interface metadata.",
    "",
    "options:",
    "  -h, --help            show this help message and exit",
    "  --format FORMAT       Output format: json or yaml",
  ].join("\n");
}

export function printCapabilityHelp(capability: string): string {
  return [
    `usage: agentera ${capability} [-h] [--format {text,json,yaml}]`,
    "",
    `Route to ${capability} capability guidance (not a full capability runner).`,
    "",
    "options:",
    "  -h, --help            show this help message and exit",
    "  --format FORMAT       Output format: text, json, or yaml",
    "",
    `Startup context: ${preCutoverCommand(`prime --context ${capability} --format json`)}`,
  ].join("\n");
}

export function printRouteHelp(): string {
  const receipt = describeRouteReceipt();
  const example = JSON.stringify(receipt.stdin_example.input);
  const inspect = (value: unknown): string[] => JSON.stringify(value, null, 2).split("\n").map((line) => `  ${line}`);
  return [
    `usage: ${preCutoverCommand("route <request|receipt> --input PATH [--format json]")}`,
    `       ${preCutoverCommand("route evaluate --format json")}`,
    "",
    "Route one transient request or validate one semantic host receipt through the shared hybrid contract.",
    "Request text is accepted only from the structured YAML or JSON input document, never argv.",
    "Use --input - to read the document from stdin. Output is JSON on stdout.",
    "Evaluate runs the frozen offline conformance corpus without a semantic host; it exits 1 when its report status is fail.",
    "",
    "input document: { version: agentera.route_request.v1, request: <string> }",
    "Semantic receipt contract (also returned as receipt_contract after semantic_required):",
    `  ${receipt.schemaVersion}; receipt version ${receipt.version}; outcomes: ${receipt.outcomes.join(", ")}.`,
    "  Submit exactly { request: <original string>, receipt: <complete nullable receipt> }; request text stays in stdin or a file.",
    "  Complete nullable receipt schema:",
    ...inspect(receipt.nullable_schema),
    "  Outcome nullability rules:",
    ...inspect(receipt.outcome_rules),
    "  Compound rules:",
    ...inspect(receipt.compound),
    "  remainder_span rule:",
    ...inspect(receipt.remainder_span),
    "  Runnable stdin round trip (run the command, write the JSON to stdin, then close stdin):",
    `  ${receipt.stdin_command}`,
    `  ${example}`,
    "A receipt result authorizes only its reported startup command; clarify starts none.",
  ].join("\n");
}

export function printCommandHelp(command: string, rest: string[] = []): string | null {
  const sub = rest.find((a) => !a.startsWith("-") && a !== "--help" && a !== "-h");
  switch (command) {
    case "prime":
      return printPrimeHelp();
    case "schema":
      return printSchemaHelp();
    case "route":
      return printRouteHelp();
    case "upgrade":
      return printUpgradeHelp();
    case "app-home":
      return printAppHomeHelp();
    case "doctor":
      return printDoctorHelp();
    case "state": {
      const retrieval = entityRetrievalFamilyForHelpArgs(rest);
      return retrieval
        ? retrieval.verb === "list" ? printStateListHelp(retrieval.family) : printStateGetHelp(retrieval.family)
        : sub && stateCommandNames().includes(sub) ? printStateHelp(sub) : printStateHelp();
    }
    case "check":
      return printCheckHelp(sub);
    case "report":
    case "stats":
      return printReportHelp();
    case "verify":
      return printCheckHelp("verify");
    case "--version":
    case "version":
      return "usage: agentera --version [--format {text,json}]\n\nPrint the installed Agentera CLI version.\n";
    default:
      if ((CAPABILITY_ROUTING_NAMES as readonly string[]).includes(command)) {
        return printCapabilityHelp(command);
      }
      return null;
  }
}

export function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

export function splitHelpArgs(argv: string[]): { args: string[]; help: boolean } {
  const idx = argv.findIndex((a) => a === "--help" || a === "-h");
  if (idx === -1) return { args: argv, help: false };
  return { args: argv.filter((_, i) => i !== idx), help: true };
}
