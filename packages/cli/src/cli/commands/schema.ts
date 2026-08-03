import fs from "node:fs";
import path from "node:path";

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
import { CANONICAL_SHARED_SKILL_PATH } from "../../setup/sharedSkill.js";
import { loadStateRetrievalAuthority } from "../../state/retrievalAuthority.js";
import { personalGlossaryOutputContract } from "../../registries/glossaryEntryContract.js";
import { describeArtifactSchemaFields } from "../../registries/artifactSchemaProjection.js";
import { advertisedValidateFamilyNames } from "./validate.js";

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
const DOCTOR_SELF_CHECK_CATEGORIES = [
  "Agentera CLI self-check status",
  "installed app and install-root status",
  "canonical shared-skill diagnosis",
  "project integration and project-state migration diagnostics",
  "bounded offline smoke checks when requested",
] as string[];
const DOCTOR_EXCLUDES = [
  "project artifact health",
  "codebase quality audit findings",
  "capability architecture, test, dependency, or documentation audit output",
] as string[];
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
    "Preview or apply one-way app and project-state migration.",
  doctor: "Check Agentera CLI, app, shared-skill, and project-integration status.",
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
    "only",
    "dry_run",
    "yes",
    "force",
    "channel",
  ],
  schema: ["format"],
};

function integrationAuthorityPath(): string {
  const sourceRoot = path.resolve(discoverSchemasDir(), "..", "..", "..", "..");
  return path.join(sourceRoot, "skills", "agentera", "SKILL.md");
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
      implementation_status: meta.implementation_status ?? "implemented",
      format: meta.format ?? "unknown",
      producer: meta.producer ?? "unknown",
      consumers: meta.consumers ?? "unknown",
      write_interface: writeInterface,
      fields: describeArtifactSchemaFields(schema),
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
  const appModel = activeAppModel();
  const schemasDir = discoverSchemasDir(appModel);
  const schemas = loadSchemas(schemasDir);
  const gaps: JsonObject[] = [];
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
  const retrievalAuthority = loadStateRetrievalAuthority();
  const profileGlossary = personalGlossaryOutputContract();

  const authorityPath = integrationAuthorityPath();

  return {
    schemaVersion: "agentera.schema.v1",
    command,
    status: gaps.length > 0 ? "incomplete" : "ok",
    source: {
      integration_authority: authorityPath,
      integration_authority_exists: fileExists(authorityPath),
      schemas_dir: schemasDir,
      schemas_dir_exists: dirExists(schemasDir),
      schema_count: artifactSchemas.length,
      app_model: appModelPayload(appModel),
    },
    commands: describeCommands(),
    validation: {
      command: "agentera check validate",
       families: [...advertisedValidateFamilyNames()],
    },
    state_writer: stateWriterContract(),
    state_retrieval: { authority: retrievalAuthority.authority, ...retrievalAuthority.retrieval },
    integration: {
      authority: "skills/agentera/SKILL.md",
      active_contract: "one shared skill plus the Agentera CLI",
      shared_skill: {
        path: CANONICAL_SHARED_SKILL_PATH,
        state_field: "shared_skill",
      },
      cli: {
        command: "agentera",
      },
      personal_glossary: {
        command: profileGlossary.command,
        request_schema_version: profileGlossary.requestSchemaVersion,
        output_statuses: profileGlossary.outputStatuses,
        project_checkout: "not_required",
      },
      historical_import: {
        source: "claude",
        import_flag: "--import-source claude",
        source_class: "historical_import",
        default_view: "excluded",
        all_sources_view: "--sources all",
        sensitivity_warning:
          "Transcripts can contain secrets, file contents, and command output; import is local and read-only.",
      },
    },
    routine_state_commands: ROUTINE_STATE_COMMANDS,
    structured_output: {
      formats: ["json", "yaml"],
      fields_by_command: {
        routine_state_commands: ROUTINE_STRUCTURED_FIELDS,
        status: STATUS_STRUCTURED_FIELDS,
      },
    },
    field_selection: {
      syntax: "--fields FIELD[,FIELD...]",
      retained_context: REQUIRED_SPARSE_CONTEXT_FIELDS,
      applies_to: ROUTINE_STATE_COMMANDS,
    },
    slash_route_aliases: {
      status: "excluded_from_cli_commands",
      aliases: {},
      cli_commands_added: true,
      note: "Decision 43 slash-route aliases map to direct capability-name routing guidance commands in Agentera 3.0.",
    },
    artifact_schemas: artifactSchemas,
    artifact_locations: artifactLocationsPayload,
    doctor: {
      command: "doctor",
      removed_command: "bundle-status",
      compatibility_alias: "forbidden",
      self_check_categories: DOCTOR_SELF_CHECK_CATEGORIES,
      excludes: DOCTOR_EXCLUDES,
      adjacent_surfaces: { codebase_audit: "/agentera audit" },
      signal_kinds: DOCTOR_SIGNAL_KINDS,
      shared_skill_field: "shared_skill",
      integration_mode: "shared_skill_and_cli_only",
    },
    gaps,
  };
}

export function cmdSchema(args: { format?: string }, io: Io): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  emitStructured(buildSchemaPayload("schema"), args.format ?? "json", out);
  return 0;
}
