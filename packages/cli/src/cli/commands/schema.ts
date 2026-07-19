import fs from "node:fs";
import path from "node:path";

import { parseYaml } from "../../core/yaml.js";
import { activeAppModel, discoverSchemasDir, loadSchemas, SchemaInfo } from "../appContext.js";
import { emitStructured } from "../structured.js";
import {
  appModelPayload,
  REQUIRED_SPARSE_CONTEXT_FIELDS,
  ROUTINE_STRUCTURED_FIELDS,
  PRIME_STRUCTURED_FIELDS,
  surfaceMissingMessage,
} from "../stateQuery.js";
import { artifactLocationContract } from "./query.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { stateWriterArtifactContract, stateWriterContract } from "../../state/write/operations.js";
import {
  LIFECYCLE_ACTION_CLASS_VALUES,
  LIFECYCLE_APPLICABILITY_VALUES,
  LIFECYCLE_COMMAND_ELIGIBILITY_VALUES,
  loadLifecycleAuthority,
} from "../../runtime/lifecycleAuthority.js";
import { loadRetiredRuntimeCleanupContract } from "../../runtime/retiredRuntimeCleanup.js";
import {
  LIFECYCLE_SNAPSHOT_SCHEMA_VERSION,
  LIFECYCLE_PROJECTION_SCHEMA_VERSION,
  LIFECYCLE_STATUS_VOCABULARY_VERSION,
  LIFECYCLE_SUMMARY_SCHEMA_VERSION,
} from "../../runtime/lifecycleSnapshot.js";
import {
  ACTIVE_RUNTIME_SELECTORS,
  LIFECYCLE_UPGRADE_SCHEMA,
} from "../../upgrade/lifecycleUpgrade.js";
import { entityPublicRetrieval, loadStateRetrievalAuthority } from "../../state/retrievalAuthority.js";
import { entityMigrationAuthorityProjection } from "../../state/entityMigrationPreview.js";

export interface TransitionalTopLevelAlias {
  legacy: string;
  canonical: string;
  structuredExampleArgv: string[];
}

export const TRANSITIONAL_TOP_LEVEL_ALIASES: TransitionalTopLevelAlias[] = [
  {
    legacy: "query",
    canonical: "state query",
    structuredExampleArgv: ["query", "--list-artifacts", "--format", "json"],
  },
  {
    legacy: "compact",
    canonical: "check compact",
    structuredExampleArgv: ["compact", "--project", "PROJECT", "--format", "json"],
  },
  {
    legacy: "verify",
    canonical: "check verify",
    structuredExampleArgv: ["verify", "eval", "skills", "--dry-run", "--format", "json"],
  },
  {
    legacy: "stats",
    canonical: "report",
    structuredExampleArgv: ["stats", "refresh", "--dry-run", "--format", "json"],
  },
  {
    legacy: "lint",
    canonical: "check lint",
    structuredExampleArgv: [
      "lint", "--artifact", "progress", "--text", "alias-parity", "--format", "json",
    ],
  },
  {
    legacy: "validate",
    canonical: "check validate",
    structuredExampleArgv: ["validate", "capability-contract", "--format", "json"],
  },
];

export const REMOVED_TOP_LEVEL_CORRECTIONS: Record<string, string> = {
  status: "prime",
  hej: "prime",
  describe: "schema",
  gate: "check compact",
  progress: "state progress",
  health: "state health",
  todo: "state todo",
  decisions: "state decisions",
  docs: "state docs",
  objective: "state objective",
  experiments: "state experiments",
};

/** Port of scripts/agentera cmd_schema / _build_schema_payload. */

type Io = { out?: (t: string) => void; err?: (t: string) => void };

const CAPABILITY_NAMES = [
  "status",
  "vision",
  "discuss",
  "research",
  "plan",
  "build",
  "optimize",
  "audit",
  "document",
  "profile",
  "design",
  "orchestrate",
];
const ROUTINE_STATE_COMMANDS = [
  "status",
  "plan",
  "progress",
  "health",
  "todo",
  "decisions",
  "docs",
  "objective",
  "experiments",
];
const DOCTOR_SIGNAL_KINDS = [
  "missing_bundle",
  "invalid_install_root",
  "unmanaged_install_root",
  "invalid_bundle",
  "missing_marker",
  "version_mismatch",
  "corrupt_bundle_marker",
];
const STATUS_STRUCTURED_FIELDS = PRIME_STRUCTURED_FIELDS;
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  prime:
    "Composite orientation briefing and capability startup context; bare JSON is at most 12000 UTF-8 bytes and status startup at most 25000.",
  schema: "Runtime CLI/schema introspection.",
  query: "Deprecated alias for state query. Advanced custom artifact query.",
  lint: "Deprecated alias for check lint. Optional draft prose preview; typed writers validate published bytes.",
  compact: "Deprecated alias for check compact. Check or fix artifact compaction budgets.",
  verify: "Deprecated alias for check verify. Run bounded verification families.",
  stats: "Deprecated alias for report. Read or refresh privacy-gated usage analytics.",
  validate: "Deprecated alias for check validate. Validate capabilities and repository contracts.",
  upgrade:
    "Preview or apply app migration plus explicitly selected Agentera-owned runtime lifecycle repair.",
  doctor: "Check Agentera CLI, app, and runtime status.",
};
function availableStructuredFields(command: string): string[] {
  if (command === "prime") return [...STATUS_STRUCTURED_FIELDS, "capability_context"];
  if (command === "status") return STATUS_STRUCTURED_FIELDS;
  if (CAPABILITY_NAMES.includes(command)) return ["command", "status", "capability", "routing"];
  return ROUTINE_STRUCTURED_FIELDS;
}

// COMMAND_FILTERS for the routine/state/lint/gate/compact/doctor/upgrade commands.
const COMMAND_FILTERS_ALL: Record<string, string[]> = {
  status: [],
  plan: ["status"],
  progress: ["topic", "status", "limit"],
  health: ["dimension"],
  todo: ["severity", "status"],
  decisions: ["topic"],
  docs: ["topic", "status"],
  objective: ["status"],
  experiments: ["topic", "status", "limit"],
  query: ["list_artifacts", "topic", "severity", "dimension", "status", "limit"],
  lint: ["artifact", "file", "text", "strict", "format"],
  compact: ["project", "mode", "format"],
  doctor: ["install_root", "home", "project", "expected_version", "expect_command"],
  upgrade: [
    "project",
    "install_root",
    "home",
    "runtime",
    "legacy_cleanup",
    "only",
    "dry_run",
    "yes",
    "force",
    "channel",
  ],
  schema: ["format"],
};

function contractPath(): string {
  const sourceRoot = path.resolve(discoverSchemasDir(), "..", "..", "..", "..");
  return path.join(sourceRoot, "references", "cli", "agent-ready-state-contract.yaml");
}

function loadDecision45Contract(): [JsonObject | null, string | null] {
  const p = contractPath();
  let isFile = false;
  try {
    isFile = fs.statSync(p).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) return [null, "Decision 45 CLI contract is missing"];
  try {
    // cast: parseYaml result of the Decision 45 contract file (YAML IO boundary)
    return [parseYaml(fs.readFileSync(p, "utf8")) as JsonObject, null];
  } catch (exc) {
    return [null, `Decision 45 CLI contract could not be read: ${(exc as Error).message}`];
  }
}

function schemaFieldDescription(entry: JsonObject): JsonObject {
  return {
    id: entry.id ?? null,
    field: entry.field ?? null,
    type: entry.type ?? "unknown",
    required: "required" in entry ? entry.required : "unknown",
    format: entry.format ?? null,
    validation: entry.validation ?? [],
  };
}

const FIELD_SKIP = new Set([
  "meta",
  "GROUP_PREFIXES",
  "BUDGET",
  "COMPACTION",
  "VALIDATION",
  "ARCHIVE",
  "CONVENTION",
  "CONVENTIONS",
]);

function describeSchemaFields(schema: JsonObject): JsonObject[] {
  const fields: JsonObject[] = [];
  for (const [groupKey, groupVal] of Object.entries(schema)) {
    if (
      FIELD_SKIP.has(groupKey) ||
      !groupVal ||
      typeof groupVal !== "object" ||
      Array.isArray(groupVal)
    )
      continue;
    // cast: groupVal is a parsed artifact schema field group (YAML IO boundary)
    for (const entry of Object.values(groupVal as JsonObject)) {
      if (entry && typeof entry === "object" && !Array.isArray(entry) && "field" in entry) {
        // cast: entry is a parsed field descriptor from the schema (YAML IO boundary)
        const field = schemaFieldDescription(entry as JsonObject);
        field.group = groupKey;
        fields.push(field);
      }
    }
  }
  return fields;
}

function commandDescription(
  name: string,
  kind: string,
  fields: string[] | null = null,
  outputFormats?: string[],
  filters?: string[],
): JsonObject {
  let formats = outputFormats ?? ["text", "json", "yaml"];
  if (!outputFormats && name === "lint") formats = ["text", "json"];
  else if (!outputFormats && name === "compact") formats = ["text", "json"];
  else if (!outputFormats && name === "doctor") formats = ["text", "json"];
  else if (!outputFormats && name === "upgrade") formats = ["text", "json"];
  else if (!outputFormats && name === "schema") formats = ["json", "yaml"];
  else if (!outputFormats && name === "prime") formats = ["text", "json", "yaml"];
  const description = kind === "capability_routing"
    ? `Route to ${name} capability guidance.`
    : kind === "routine_state"
      ? `Read ${name} project state through the agentera state namespace.`
      : COMMAND_DESCRIPTIONS[name] ?? "unknown";
  const alias = TRANSITIONAL_TOP_LEVEL_ALIASES.find((entry) => entry.legacy === name);
  return {
    name,
    kind,
    description,
    filters: filters ?? COMMAND_FILTERS_ALL[name] ?? [],
    output_formats: formats,
    structured_fields: fields ?? [],
    ...(alias ? {
      alias_for: alias.canonical,
      structured_example_argv: alias.structuredExampleArgv,
    } : {}),
  };
}

function describeCommands(): JsonObject[] {
  const commands: JsonObject[] = [
    commandDescription("prime", "orientation", availableStructuredFields("prime")),
  ];
  for (const name of CAPABILITY_NAMES) {
    if (name === "status") continue;
    commands.push(commandDescription(name, "capability_routing", availableStructuredFields(name)));
  }
  for (const name of ROUTINE_STATE_COMMANDS) {
    commands.push(commandDescription(name, "routine_state", availableStructuredFields(name)));
  }
  commands.push(
    commandDescription("query", "advanced_artifact_query"),
    commandDescription("compact", "artifact_compaction", [
      "command",
      "status",
      "project",
      "summary",
      "operations",
    ]),
    commandDescription("verify", "verification", [
      "command",
      "status",
      "family",
      "target",
      "engine",
      "diagnostics",
      "safety",
    ]),
    commandDescription("stats", "usage_analytics"),
    commandDescription("lint", "artifact_lint", [
      "command",
      "status",
      "artifact",
      "checks",
      "summary",
    ]),
    commandDescription("validate", "validation"),
    commandDescription("schema", "runtime_introspection"),
    commandDescription("upgrade", "upgrade", [
      "schemaVersion",
      "mode",
      "status",
      "phase",
      "phases",
      "lifecycle",
      "summary",
      "state_validation",
      "startup_validation",
      "dryRunCommand",
      "applyCommand",
    ]),
    commandDescription("doctor", "self_check"),
  );
  return commands;
}

function contractSection(contract: JsonObject | null, key: string, gaps: JsonObject[]): any {
  if (contract && typeof contract === "object" && !Array.isArray(contract) && key in contract) {
    return contract[key];
  }
  gaps.push({
    scope: key,
    status: "unknown",
    message: `Decision 45 contract section '${key}' is unavailable`,
  });
  return null;
}

function describeArtifactSchemas(
  schemasDir: string,
  schemas: Record<string, SchemaInfo>,
  model: ReturnType<typeof activeAppModel>,
  artifactLocations: Record<string, JsonObject> | null,
): [JsonObject[], JsonObject[]] {
  const gaps: JsonObject[] = [];
  let isDir = false;
  try {
    isDir = fs.statSync(schemasDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    gaps.push({
      scope: "artifact_schemas",
      status: "missing",
      message: surfaceMissingMessage("artifact schema directory", schemasDir, model),
    });
    return [[], gaps];
  }
  const artifacts: JsonObject[] = [];
  for (const name of Object.keys(schemas).sort()) {
    const info = schemas[name];
    const schema = info.schema && typeof info.schema === "object" ? info.schema : {};
    // cast: schema.meta is read from a parsed artifact schema (YAML IO boundary)
    const meta = (schema.meta ?? {}) as JsonObject;
    const schemaFile = path.join(schemasDir, `${name}.yaml`);
    const location = artifactLocations ? (artifactLocations[name] ?? null) : null;
    const hasMeta = meta && Object.keys(meta).length > 0;
    const writeInterface = stateWriterArtifactContract(name);
    artifacts.push({
      name,
      status: hasMeta ? "discovered" : "unknown_metadata",
      schema_file: fileExists(schemaFile) ? schemaFile : null,
      path: info.path || "unknown",
      location,
      artifact_type: meta.artifact_type ?? "unknown",
      format: meta.format ?? "unknown",
      producer: meta.producer ?? "unknown",
      consumers: meta.consumers ?? "unknown",
      write_interface: writeInterface,
      fields: describeSchemaFields(schema),
    });
    if (!hasMeta) {
      gaps.push({
        scope: `artifact_schemas.${name}`,
        status: "unknown",
        message: "schema metadata is absent or unreadable",
      });
    }
  }
  return [artifacts, gaps];
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function buildSchemaPayload(command = "schema"): JsonObject {
  const [contract, contractError] = loadDecision45Contract();
  const appModel = activeAppModel();
  const schemasDir = discoverSchemasDir(appModel);
  const schemas = loadSchemas(schemasDir);
  const gaps: JsonObject[] = [];
  if (contractError) gaps.push({ scope: "contract", status: "missing", message: contractError });
  const artifactLocationsPayload = artifactLocationContract(schemasDir, schemas);
  const artifactLocations: Record<string, JsonObject> = {};
  // cast: artifacts payload is built by query.ts over on-disk schemas/registry (IO boundary)
  for (const entry of artifactLocationsPayload.artifacts as JsonObject[])
    artifactLocations[String(entry.name)] = entry;
  const [artifactSchemas, schemaGaps] = describeArtifactSchemas(
    schemasDir,
    schemas,
    appModel,
    artifactLocations,
  );
  gaps.push(...schemaGaps);
  const lifecycleAuthority = loadLifecycleAuthority();
  const retiredRuntimeCleanup = loadRetiredRuntimeCleanupContract();
  const retrievalAuthority = loadStateRetrievalAuthority();

  const slashAliases = contractSection(contract, "slash_route_aliases", gaps);
  const doctorContract = contractSection(contract, "doctor", gaps);
  const structuredOutput = contractSection(contract, "structured_output", gaps);
  const fieldSelection = contractSection(contract, "field_selection", gaps);

  const isDict = (v: any) => v && typeof v === "object" && !Array.isArray(v);
  const cp = contractPath();

  return {
    schemaVersion: "agentera.schema.v1",
    command,
    status: gaps.length > 0 ? "incomplete" : "ok",
    source: {
      contract: cp,
      contract_exists: fileExists(cp),
      schemas_dir: schemasDir,
      schemas_dir_exists: dirExists(schemasDir),
      schema_count: artifactSchemas.length,
      app_model: appModelPayload(appModel),
    },
    commands: describeCommands(),
    state_writer: stateWriterContract(),
    state_retrieval: { authority: retrievalAuthority.authority, ...entityPublicRetrieval() },
    entity_migration: entityMigrationAuthorityProjection(),
    runtime_lifecycle: {
      authority: lifecycleAuthority.sourcePath,
      snapshot_schema_version: LIFECYCLE_SNAPSHOT_SCHEMA_VERSION,
      projection_schema_version: LIFECYCLE_PROJECTION_SCHEMA_VERSION,
      summary_schema_version: LIFECYCLE_SUMMARY_SCHEMA_VERSION,
      status_vocabulary_version: LIFECYCLE_STATUS_VOCABULARY_VERSION,
      projection: {
        snapshot_identity: "deterministic_sha256",
        applicability: [...LIFECYCLE_APPLICABILITY_VALUES],
        action_classes: [...LIFECYCLE_ACTION_CLASS_VALUES],
        command_eligibility: [...LIFECYCLE_COMMAND_ELIGIBILITY_VALUES],
        shared_resource_rule: "selected_and_required_by_at_least_one_selected_runtime",
      },
      projections: {
        prime: "bounded summary without category evidence or native command lists",
        doctor:
          "detailed surfaces, eight categories, evidence, precedence, and user-owned native steps",
        upgrade: "explicitly selected read-only preview or approved Agentera-owned lifecycle apply",
      },
      upgrade: {
        schema_version: LIFECYCLE_UPGRADE_SCHEMA,
        command: "agentera upgrade --runtime <all|runtime> --dry-run|--yes",
        selectors: ["all", ...ACTIVE_RUNTIME_SELECTORS],
        projection:
          "lifecycle.projection is the canonical runtime lifecycle snapshot shared with doctor, prime, status, and project integration",
        default_without_runtime_selector: "app_upgrade_only",
        preview: "strictly_read_only",
        apply_requires: "--yes",
        approval_scope: "declared_agentera_owned_operations_only",
        native_actions: "reported_action_required_never_executed",
        trust_actions: "reported_action_required_never_approved",
        ownership_journal:
          ".agentera/runtime-lifecycle/ownership-journal-v1 under the selected app home",
        journal_states: ["absent", "clean", "recoverable_terminal_tail", "corrupt"],
        journal_chain:
          "strict_contiguous_sequence_and_digest_chain; only_one_incomplete_terminal_final_is_read_recoverable_but_mutation_blocking",
        journal_publication:
          "fsynced_unique_temporary_then_atomic_exclusive_final_link_and_directory_fsync",
        lock: "live_preparation_blocks_contenders; atomic_complete_record_with_token_pid_linux_boot_id_and_proc_start_ticks; malformed_final_fails_closed",
        recovery:
          "non_authoritative_temporaries_ignored;_middle_gap_fork_digest_or_disconnection_blocks_all_mutation",
        retired_cleanup:
          "--legacy-cleanup claude (legacy-only, explicit, never active runtime identity)",
        exits: { success: 0, non_success: 1, usage: 2 },
      },
      support_floor: {
        mandatory_evidence_fields: lifecycleAuthority.evidenceFields,
        unknown_or_missing_mandatory_blocks:
          lifecycleAuthority.supportFloorPolicy.unknownOrMissingMandatoryBlocks,
        denied_mandatory_trust_blocks:
          lifecycleAuthority.supportFloorPolicy.deniedMandatoryTrustBlocks,
        known_false_diagnoses_degraded:
          lifecycleAuthority.supportFloorPolicy.knownFalseDiagnosesDegraded,
        not_applicable_scope: lifecycleAuthority.supportFloorPolicy.notApplicableScope,
      },
      ["active_runtime_" + "ids"]: lifecycleAuthority.runtimes.map((runtime) => runtime.id),
      migration_aliases: {
        "cursor-agent": { runtime_id: "cursor", surface_id: "cli", active_runtime: false },
      },
      retired_runtime_inputs: retiredRuntimeCleanup.runtimes.map((runtime) => ({
        id: runtime.id,
        active_runtime: false,
        source_product: runtime.sourceProduct,
        cleanup_contract: retiredRuntimeCleanup.sourcePath,
        cleanup: {
          preview: "strictly_read_only",
          apply_requires: "explicit_approval",
          ownership: "matching legacy ledger identity and fingerprint",
        },
        analytics: {
          import_flag: "--import-source claude",
          source_class: "historical_import",
          active_runtime: false,
          default_view: "excluded",
          all_sources_view: "--sources all",
          sensitivity_warning:
            "Transcripts can contain secrets, file contents, and command output; import is local and read-only.",
        },
      })),
    },
    routine_state_commands: ROUTINE_STATE_COMMANDS,
    structured_output: {
      formats: isDict(structuredOutput)
        ? (structuredOutput.formats ?? ["json", "yaml"])
        : "unknown",
      fields_by_command: {
        routine_state_commands: ROUTINE_STRUCTURED_FIELDS,
        status: STATUS_STRUCTURED_FIELDS,
      },
    },
    field_selection: {
      syntax: isDict(fieldSelection)
        ? (fieldSelection.syntax ?? "--fields FIELD[,FIELD...]")
        : "unknown",
      retained_context: REQUIRED_SPARSE_CONTEXT_FIELDS,
      applies_to: isDict(fieldSelection)
        ? (fieldSelection.applies_to ?? ROUTINE_STATE_COMMANDS)
        : "unknown",
    },
    slash_route_aliases: {
      status: isDict(slashAliases) ? (slashAliases.status ?? "unknown") : "unknown",
      aliases: isDict(slashAliases) ? (slashAliases.aliases ?? {}) : {},
      cli_commands_added: true,
      note: "Decision 43 slash-route aliases map to direct capability-name routing guidance commands in Agentera 3.0.",
    },
    artifact_schemas: artifactSchemas,
    artifact_locations: artifactLocationsPayload,
    doctor: {
      command: "doctor",
      removed_command: isDict(doctorContract)
        ? (doctorContract.removed_command ?? "unknown")
        : "unknown",
      compatibility_alias: isDict(doctorContract)
        ? (doctorContract.compatibility_alias ?? "unknown")
        : "unknown",
      self_check_categories: isDict(doctorContract)
        ? (doctorContract.owns ?? "unknown")
        : "unknown",
      excludes: isDict(doctorContract) ? (doctorContract.excludes ?? "unknown") : "unknown",
      adjacent_surfaces: isDict(doctorContract)
        ? (doctorContract.adjacent_surfaces ?? "unknown")
        : "unknown",
      signal_kinds: DOCTOR_SIGNAL_KINDS,
      runtime_lifecycle_field: "runtime_lifecycle",
      runtime_lifecycle_mode: "read_only_detailed_diagnosis",
    },
    gaps,
  };
}

export function cmdSchema(args: { format?: string }, io: Io): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  emitStructured(buildSchemaPayload("schema"), args.format ?? "json", out);
  return 0;
}
