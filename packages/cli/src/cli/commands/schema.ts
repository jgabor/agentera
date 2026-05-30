import fs from "node:fs";
import path from "node:path";

import { parseYaml } from "../../core/yaml.js";
import {
  activeAppModel,
  discoverSchemasDir,
  loadSchemas,
  SchemaInfo,
} from "../appContext.js";
import { emitStructured } from "../structured.js";
import {
  appModelPayload,
  REQUIRED_SPARSE_CONTEXT_FIELDS,
  ROUTINE_STRUCTURED_FIELDS,
  surfaceMissingMessage,
} from "../stateQuery.js";
import { artifactLocationContract } from "./query.js";

/** Port of scripts/agentera cmd_schema / _build_schema_payload. */

type Dict = Record<string, any>;
type Io = { out?: (t: string) => void; err?: (t: string) => void };

const CAPABILITY_NAMES = [
  "hej", "visionera", "resonera", "inspirera", "planera", "realisera",
  "optimera", "inspektera", "dokumentera", "profilera", "visualisera", "orkestrera",
];
const ROUTINE_STATE_COMMANDS = [
  "hej", "plan", "progress", "health", "todo", "decisions", "docs", "objective", "experiments",
];
const DOCTOR_SIGNAL_KINDS = [
  "missing_bundle", "invalid_install_root", "unmanaged_install_root", "invalid_bundle",
  "missing_marker", "version_mismatch", "cli_probe_unavailable", "cli_probe_failed", "missing_command",
];
const HEJ_STRUCTURED_FIELDS = [
  "command", "status", "app_home", "bundle", "mode", "profile", "v1_migration", "health",
  "issues", "plan", "docs", "progress", "objective", "state_presence", "attention",
  "decision_attention", "next_action", "orchestration_context", "closeout_context",
  "evidence_context", "benchmark_context", "execution_context", "source", "source_contract",
];
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  prime: "Composite orientation briefing and capability startup context.",
  hej: "Deprecated alias for prime.",
  schema: "Runtime CLI/schema introspection.",
  plan: "Deprecated alias for state plan. Active plan summary.",
  progress: "Deprecated alias for state progress. Recent cycle summary.",
  health: "Deprecated alias for state health. Latest project artifact health audit.",
  todo: "Deprecated alias for state todo. TODO summary.",
  decisions: "Deprecated alias for state decisions. Decision log.",
  docs: "Deprecated alias for state docs. Documentation contract summary.",
  objective: "Deprecated alias for state objective. Active optimera objective summary.",
  experiments: "Deprecated alias for state experiments. Active optimera experiments summary.",
  query: "Deprecated alias for state query. Advanced custom artifact query.",
  lint: "Deprecated alias for check lint. Run pre-write artifact prose self-audit.",
  gate: "Deprecated alias for check compact. Run check-only repository gates.",
  compact: "Deprecated alias for check compact. Check or fix artifact compaction budgets.",
  upgrade: "Preview or apply phased upgrade: v1→v2 (legacy Python), v2→v3 (explicit --target-major 3 opt-in on 3.x CLI).",
  doctor: "Check Agentera CLI, app, and runtime status.",
  describe: "Deprecated alias for schema.",
};
const COMMAND_FILTERS_SCHEMA: Record<string, string[]> = {
  prime: [],
  hej: [],
  schema: ["format"],
  describe: ["format"],
};

function availableStructuredFields(command: string): string[] {
  if (command === "prime") return [...HEJ_STRUCTURED_FIELDS, "capability_context"];
  if (command === "hej") return HEJ_STRUCTURED_FIELDS;
  if (CAPABILITY_NAMES.includes(command)) return ["command", "status", "capability", "routing"];
  return ROUTINE_STRUCTURED_FIELDS;
}

// COMMAND_FILTERS for the routine/state/lint/gate/compact/doctor/upgrade commands.
const COMMAND_FILTERS_ALL: Record<string, string[]> = {
  hej: [],
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
  gate: ["project", "format"],
  compact: ["project", "mode", "format"],
  doctor: ["install_root", "home", "project", "expected_version", "expect_command"],
  upgrade: ["project", "install_root", "home", "runtime", "only", "dry_run", "yes", "force", "update_packages", "channel", "target_major"],
  describe: ["format"],
  schema: ["format"],
};

function contractPath(): string {
  const sourceRoot = path.resolve(discoverSchemasDir(), "..", "..", "..", "..");
  return path.join(sourceRoot, "references", "cli", "agent-ready-state-contract.yaml");
}

function loadDecision45Contract(): [Dict | null, string | null] {
  const p = contractPath();
  let isFile = false;
  try {
    isFile = fs.statSync(p).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) return [null, "Decision 45 CLI contract is missing"];
  try {
    return [parseYaml(fs.readFileSync(p, "utf8")) as Dict, null];
  } catch (exc) {
    return [null, `Decision 45 CLI contract could not be read: ${(exc as Error).message}`];
  }
}

function schemaFieldDescription(entry: Dict): Dict {
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
  "meta", "GROUP_PREFIXES", "BUDGET", "COMPACTION", "VALIDATION", "ARCHIVE", "CONVENTION", "CONVENTIONS",
]);

function describeSchemaFields(schema: Dict): Dict[] {
  const fields: Dict[] = [];
  for (const [groupKey, groupVal] of Object.entries(schema)) {
    if (FIELD_SKIP.has(groupKey) || !groupVal || typeof groupVal !== "object" || Array.isArray(groupVal)) continue;
    for (const entry of Object.values(groupVal as Dict)) {
      if (entry && typeof entry === "object" && !Array.isArray(entry) && "field" in entry) {
        const field = schemaFieldDescription(entry as Dict);
        field.group = groupKey;
        fields.push(field);
      }
    }
  }
  return fields;
}

function commandDescription(name: string, kind: string, fields: string[] | null = null): Dict {
  let outputFormats = ["text", "json", "yaml"];
  if (name === "lint") outputFormats = ["text", "json"];
  else if (name === "compact" || name === "gate") outputFormats = ["text", "json"];
  else if (name === "doctor") outputFormats = ["text", "json"];
  else if (name === "upgrade") outputFormats = ["text", "json"];
  else if (name === "describe" || name === "schema") outputFormats = ["json", "yaml"];
  else if (name === "prime") outputFormats = ["text", "json", "yaml"];
  return {
    name,
    kind,
    description: COMMAND_DESCRIPTIONS[name] ?? "unknown",
    filters: COMMAND_FILTERS_ALL[name] ?? [],
    output_formats: outputFormats,
    structured_fields: fields ?? [],
  };
}

function describeCommands(): Dict[] {
  const commands: Dict[] = [
    commandDescription("prime", "orientation", availableStructuredFields("prime")),
    commandDescription("hej", "deprecated_alias", availableStructuredFields("hej")),
  ];
  for (const name of CAPABILITY_NAMES) {
    if (name === "hej") continue;
    commands.push(commandDescription(name, "capability_routing", availableStructuredFields(name)));
  }
  for (const name of ROUTINE_STATE_COMMANDS) {
    commands.push(commandDescription(name, "routine_state", availableStructuredFields(name)));
  }
  commands.push(
    commandDescription("query", "advanced_artifact_query"),
    commandDescription("lint", "artifact_lint", ["command", "status", "artifact", "checks", "summary"]),
    commandDescription("gate", "repo_gate", ["command", "status", "project", "summary", "operations"]),
    commandDescription("compact", "artifact_compaction", ["command", "status", "project", "summary", "operations"]),
    commandDescription("schema", "runtime_introspection"),
    commandDescription("describe", "deprecated_alias"),
    commandDescription("upgrade", "upgrade"),
    commandDescription("doctor", "self_check"),
  );
  return commands;
}

function contractSection(contract: Dict | null, key: string, gaps: Dict[]): any {
  if (contract && typeof contract === "object" && !Array.isArray(contract) && key in contract) {
    return contract[key];
  }
  gaps.push({ scope: key, status: "unknown", message: `Decision 45 contract section '${key}' is unavailable` });
  return null;
}

function describeArtifactSchemas(
  schemasDir: string,
  schemas: Record<string, SchemaInfo>,
  model: Dict,
  artifactLocations: Record<string, Dict> | null,
): [Dict[], Dict[]] {
  const gaps: Dict[] = [];
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
  const artifacts: Dict[] = [];
  for (const name of Object.keys(schemas).sort()) {
    const info = schemas[name];
    const schema = info.schema && typeof info.schema === "object" ? info.schema : {};
    const meta = (schema.meta ?? {}) as Dict;
    const schemaFile = path.join(schemasDir, `${name}.yaml`);
    const location = artifactLocations ? artifactLocations[name] ?? null : null;
    const hasMeta = meta && Object.keys(meta).length > 0;
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
      fields: describeSchemaFields(schema),
    });
    if (!hasMeta) {
      gaps.push({ scope: `artifact_schemas.${name}`, status: "unknown", message: "schema metadata is absent or unreadable" });
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

export function buildSchemaPayload(command = "schema"): Dict {
  const [contract, contractError] = loadDecision45Contract();
  const appModel = activeAppModel();
  const schemasDir = discoverSchemasDir(appModel);
  const schemas = loadSchemas(schemasDir);
  const gaps: Dict[] = [];
  if (contractError) gaps.push({ scope: "contract", status: "missing", message: contractError });
  const artifactLocationsPayload = artifactLocationContract(schemasDir, schemas);
  const artifactLocations: Record<string, Dict> = {};
  for (const entry of artifactLocationsPayload.artifacts as Dict[]) artifactLocations[entry.name] = entry;
  const [artifactSchemas, schemaGaps] = describeArtifactSchemas(schemasDir, schemas, appModel as unknown as Dict, artifactLocations);
  gaps.push(...schemaGaps);

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
      app_model: appModelPayload(appModel as unknown as Dict),
    },
    commands: describeCommands(),
    routine_state_commands: ROUTINE_STATE_COMMANDS,
    structured_output: {
      formats: isDict(structuredOutput) ? structuredOutput.formats ?? ["json", "yaml"] : "unknown",
      fields_by_command: {
        routine_state_commands: ROUTINE_STRUCTURED_FIELDS,
        hej: HEJ_STRUCTURED_FIELDS,
      },
    },
    field_selection: {
      syntax: isDict(fieldSelection) ? fieldSelection.syntax ?? "--fields FIELD[,FIELD...]" : "unknown",
      retained_context: REQUIRED_SPARSE_CONTEXT_FIELDS,
      applies_to: isDict(fieldSelection) ? fieldSelection.applies_to ?? ROUTINE_STATE_COMMANDS : "unknown",
    },
    slash_route_aliases: {
      status: isDict(slashAliases) ? slashAliases.status ?? "unknown" : "unknown",
      aliases: isDict(slashAliases) ? slashAliases.aliases ?? {} : {},
      cli_commands_added: true,
      note: "Decision 43 slash-route aliases map to direct capability-name routing guidance commands in Agentera 3.0.",
    },
    artifact_schemas: artifactSchemas,
    artifact_locations: artifactLocationsPayload,
    doctor: {
      command: "doctor",
      removed_command: isDict(doctorContract) ? doctorContract.removed_command ?? "unknown" : "unknown",
      compatibility_alias: isDict(doctorContract) ? doctorContract.compatibility_alias ?? "unknown" : "unknown",
      self_check_categories: isDict(doctorContract) ? doctorContract.owns ?? "unknown" : "unknown",
      excludes: isDict(doctorContract) ? doctorContract.excludes ?? "unknown" : "unknown",
      adjacent_surfaces: isDict(doctorContract) ? doctorContract.adjacent_surfaces ?? "unknown" : "unknown",
      signal_kinds: DOCTOR_SIGNAL_KINDS,
    },
    gaps,
  };
}

export function cmdSchema(args: { format?: string }, io: Io): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  emitStructured(buildSchemaPayload("schema"), args.format ?? "json", out);
  return 0;
}
