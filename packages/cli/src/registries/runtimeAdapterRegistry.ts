import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";

/** RuntimeAdapter registry loader and contract validator. Port of scripts/runtime_adapter_registry.py. */

type Dict = Record<string, any>;

export const EXPECTED_RUNTIME_ORDER = [
  "claude",
  "opencode",
  "copilot",
  "codex",
  "cursor",
  "cursor-agent",
] as const;

export const REQUIRED_GROUPS = [
  "identity",
  "host_detection",
  "lifecycle_events",
  "artifact_validation",
  "subagent_dispatch",
  "config_targets",
  "diagnostics",
  "documentation_claims",
] as const;

const REQUIRED_FIELDS: Record<string, string[]> = {
  identity: ["runtime_id", "display_name", "adapter_family", "support_status"],
  host_detection: ["binary_names", "host_config_locations", "availability_probe_label"],
  lifecycle_events: ["supported_events", "unsupported_events", "event_status", "limitations"],
  artifact_validation: ["validation_events", "hard_gate_claims", "payload_reconstruction_limitations"],
  subagent_dispatch: ["mechanism", "setup_targets", "descriptor_sources", "invocation_pattern", "limitations"],
  config_targets: [
    "runtime_config_files",
    "hook_targets",
    "plugin_targets",
    "environment_exports",
    "write_safety_labels",
  ],
  diagnostics: ["check_names", "status_labels", "gap_labels", "primary_messages"],
  documentation_claims: ["reference_paths", "parity_claims", "install_claims", "known_drifts"],
};

const ALLOWED_FIELDS: Record<string, string[]> = Object.fromEntries(
  Object.entries(REQUIRED_FIELDS).map(([group, fields]) => [
    group,
    group === "subagent_dispatch" ? [...fields, "tool_configuration"] : fields,
  ]),
);

const LIST_FIELDS = new Set([
  "binary_names",
  "host_config_locations",
  "supported_events",
  "unsupported_events",
  "validation_events",
  "hard_gate_claims",
  "payload_reconstruction_limitations",
  "setup_targets",
  "descriptor_sources",
  "limitations",
  "runtime_config_files",
  "hook_targets",
  "plugin_targets",
  "environment_exports",
  "write_safety_labels",
  "check_names",
  "status_labels",
  "gap_labels",
  "primary_messages",
  "reference_paths",
  "parity_claims",
  "install_claims",
  "known_drifts",
]);

const STRING_FIELDS = new Set([
  "runtime_id",
  "display_name",
  "adapter_family",
  "support_status",
  "availability_probe_label",
  "mechanism",
  "invocation_pattern",
  "tool_configuration",
]);

const MAP_FIELDS = new Set(["event_status"]);

const SUPPORTED_EVENT_NAMES = new Set([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "Stop",
  "SubagentStop",
  "PermissionRequest",
  "PreCompact",
  "Notification",
  "preToolUse",
  "postToolUse",
  "sessionStart",
  "sessionEnd",
  "userPromptSubmitted",
  "errorOccurred",
  "shell.env",
  "chat.message",
  "tool.execute.before",
  "tool.execute.after",
  "experimental.session.compacting",
  "session.created",
  "session.idle",
  "subagentStart",
  "subagentStop",
  "beforeSubmitPrompt",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "preCompact",
  "stop",
]);

const CONSUMER_GROUPS: Record<string, readonly string[]> = {
  lifecycle: ["identity", "lifecycle_events", "artifact_validation", "subagent_dispatch", "documentation_claims"],
  doctor: ["identity", "host_detection", "config_targets", "diagnostics", "documentation_claims"],
  upgrade: ["identity", "host_detection", "subagent_dispatch", "config_targets", "diagnostics"],
  docs: REQUIRED_GROUPS,
  tests: REQUIRED_GROUPS,
};

const FORBIDDEN_OWNERSHIP_FIELDS = new Set([
  "package_metadata",
  "package_manifest",
  "package_manifest_schemas",
  "release_metadata",
  "shared_package_paths",
  "version_authority",
  "install_root",
  "install_root_classification",
  "AGENTERA_HOME_precedence",
  "default_durable_root",
  "managed_classification",
  "root_diagnostics",
  "ownership",
]);

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

function defaultRegistryPathValue(): string {
  return path.join(resolveSourceRoot(), "references/adapters/runtime-adapter-registry.yaml");
}

export function defaultRegistryPath(): string {
  return defaultRegistryPathValue();
}

function isMapping(value: unknown): value is Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringList(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringMap(value: unknown): boolean {
  return (
    isMapping(value) &&
    Object.entries(value).every(([key, item]) => typeof key === "string" && typeof item === "string")
  );
}

export class RuntimeAdapterRegistry {
  records: Dict[];

  constructor(records: Dict[]) {
    this.records = records;
  }

  get runtimeIds(): string[] {
    return this.records.map((record) => record.identity.runtime_id);
  }

  get(runtimeId: string): Dict {
    for (const record of this.records) {
      if (record.identity.runtime_id === runtimeId) {
        return record;
      }
    }
    throw new RegistryError(`unknown runtime id: ${runtimeId}`);
  }

  consumerView(consumer: string, runtimeId: string): Dict {
    const groups = CONSUMER_GROUPS[consumer];
    if (groups === undefined) {
      throw new RegistryError(`unknown registry consumer: ${consumer}`);
    }
    const record = this.get(runtimeId);
    const view: Dict = {};
    for (const group of groups) {
      view[group] = record[group];
    }
    return view;
  }
}

export function loadRegistry(registryPath: string = defaultRegistryPathValue()): RuntimeAdapterRegistry {
  const data = loadYamlMapping(fs.readFileSync(registryPath, "utf8"));
  const errors = validateRegistryData(data);
  if (errors.length > 0) {
    throw new RegistryError("RuntimeAdapter registry validation failed: " + errors.join("; "));
  }
  return new RuntimeAdapterRegistry((data as Dict).records as Dict[]);
}

export function validateRegistryFile(registryPath: string = defaultRegistryPathValue()): string[] {
  return validateRegistryData(loadYamlMapping(fs.readFileSync(registryPath, "utf8")));
}

export function validateRegistryData(data: unknown): string[] {
  const errors: string[] = [];
  if (!isMapping(data)) {
    return ["registry must be a YAML object"];
  }
  if (data.schema_version !== "agentera.runtimeAdapterRegistry.v1") {
    errors.push("registry.schema_version must be agentera.runtimeAdapterRegistry.v1");
  }

  if (JSON.stringify(data.runtime_order) !== JSON.stringify([...EXPECTED_RUNTIME_ORDER])) {
    errors.push(
      "registry.runtime_order must be claude, opencode, copilot, codex, cursor, cursor-agent",
    );
  }

  const records = data.records;
  if (!Array.isArray(records)) {
    return [...errors, "registry.records must be a list"];
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  records.forEach((record, index) => {
    const prefix = `records[${index}]`;
    if (!isMapping(record)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    errors.push(...validateForbiddenFields(prefix, record));
    for (const group of REQUIRED_GROUPS) {
      if (!(group in record)) {
        errors.push(`${prefix}: missing required group ${group}`);
      }
    }
    for (const group of Object.keys(record)) {
      if (!(REQUIRED_GROUPS as readonly string[]).includes(group)) {
        errors.push(`${prefix}: unknown group ${group}`);
      }
    }
    for (const group of REQUIRED_GROUPS) {
      const groupValue = record[group];
      if (isMapping(groupValue)) {
        errors.push(...validateGroup(`${prefix}.${group}`, group, groupValue));
      } else if (group in record) {
        errors.push(`${prefix}.${group} must be an object`);
      }
    }

    const identity = record.identity;
    const runtimeId = isMapping(identity) ? identity.runtime_id : null;
    if (typeof runtimeId !== "string") {
      return;
    }
    ids.push(runtimeId);
    if (!(EXPECTED_RUNTIME_ORDER as readonly string[]).includes(runtimeId)) {
      errors.push(`${prefix}.identity.runtime_id unknown runtime id: ${runtimeId}`);
    }
    if (seen.has(runtimeId)) {
      errors.push(`duplicate runtime id: ${runtimeId}`);
    }
    seen.add(runtimeId);
  });

  if (JSON.stringify(ids) !== JSON.stringify([...EXPECTED_RUNTIME_ORDER])) {
    errors.push(
      "registry.records must be ordered as claude, opencode, copilot, codex, cursor, cursor-agent",
    );
  }
  return errors;
}

function validateGroup(prefix: string, group: string, value: Dict): string[] {
  const errors: string[] = [];
  errors.push(...validateForbiddenFields(prefix, value));
  for (const field of REQUIRED_FIELDS[group]) {
    if (!(field in value)) {
      errors.push(`${prefix}: missing required field ${field}`);
    }
  }
  for (const [field, fieldValue] of Object.entries(value)) {
    if (!ALLOWED_FIELDS[group].includes(field)) {
      errors.push(`${prefix}: unknown field ${field}`);
      continue;
    }
    if (STRING_FIELDS.has(field) && typeof fieldValue !== "string") {
      errors.push(`${prefix}.${field} must be a string`);
    } else if (LIST_FIELDS.has(field) && !isStringList(fieldValue)) {
      errors.push(`${prefix}.${field} must be a list of strings`);
    } else if (MAP_FIELDS.has(field) && !isStringMap(fieldValue)) {
      errors.push(`${prefix}.${field} must be a string map`);
    }
  }

  errors.push(...validateEventNames(prefix, value));
  return errors;
}

function validateEventNames(prefix: string, value: Dict): string[] {
  const errors: string[] = [];
  for (const field of ["supported_events", "unsupported_events", "validation_events"]) {
    const events = value[field];
    if (!Array.isArray(events)) {
      continue;
    }
    for (const event of events) {
      if (!SUPPORTED_EVENT_NAMES.has(event)) {
        errors.push(`${prefix}.${field}: unsupported event name ${event}`);
      }
    }
  }
  const eventStatus = value.event_status;
  if (isMapping(eventStatus)) {
    for (const event of Object.keys(eventStatus)) {
      if (!SUPPORTED_EVENT_NAMES.has(event)) {
        errors.push(`${prefix}.event_status: unsupported event name ${event}`);
      }
    }
  }
  return errors;
}

function validateForbiddenFields(prefix: string, value: Dict): string[] {
  return Object.keys(value)
    .sort()
    .filter((field) => FORBIDDEN_OWNERSHIP_FIELDS.has(field))
    .map((field) => `${prefix}: forbidden ownership field ${field}`);
}
