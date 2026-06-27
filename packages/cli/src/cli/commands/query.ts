import fs from "node:fs";
import path from "node:path";

import { resolveArtifactPath, ArtifactRecord } from "../../registries/artifactRegistry.js";
import {
  activeObjectiveName,
  artifactPath,
  discoverSchemasDir,
  loadSchemas,
  resolveArtifactPathLocal,
  SchemaInfo,
} from "../appContext.js";
import { validateAgentString } from "../argvalidate.js";
import { loadDocsPathOverrides } from "../../registries/artifactRegistry.js";
import { emitStructured } from "../structured.js";
import {
  COMMAND_FILTERS,
  emitStateStructured,
  extractEntries,
  filterByFieldValue,
  filterByTopic,
  formatEntry,
  loadArtifact,
  missingSchemaError,
  recentCycles,
  sourceMetadata,
  structuredState,
  validateFilterValues,
} from "../stateQuery.js";
import { displayFields, queryTodo, StateArgs } from "./state/index.js";
import type { JsonObject } from "../../core/jsonValue.js";

type Io = { out?: (t: string) => void; err?: (t: string) => void };

const ENCODED_TRAVERSAL_RE = /%(?:2e|2f|5c)/i;
const ALLOWED_RAW_ARTIFACT_USES = [
  "artifact writes",
  "artifact archival",
  "artifact validation",
  "corruption diagnostics",
  "CLI defects",
  "unavailable or incomplete CLI state after CLI fallbacks",
  "benchmark analysis",
];
const BENCHMARK_CONTEXT_COMMAND = "agentera prime --context optimize --format json";
const STATE_COMMAND_NAMES = new Set([
  "decisions",
  "docs",
  "experiments",
  "health",
  "objective",
  "plan",
  "progress",
  "todo",
]);

export interface QueryArgs {
  query?: string | null;
  list_artifacts?: boolean;
  topic?: string | null;
  severity?: string | null;
  dimension?: string | null;
  status?: string | null;
  limit?: number | null;
  format?: string;
  fields?: string | null;
}

function out(io: Io): (t: string) => void {
  return io.out ?? ((t: string) => process.stdout.write(t));
}
function err(io: Io): (t: string) => void {
  return io.err ?? ((t: string) => process.stderr.write(t));
}

function projectRelativeOrAbsolute(p: string): string {
  const cwd = path.resolve(process.cwd());
  const rel = path.relative(cwd, p);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return p;
  return rel;
}

function artifactReadInterfaces(name: string, record: ArtifactRecord | null): JsonObject {
  const artifactId = record !== null ? record.artifactId : name;
  const routineCommand = STATE_COMMAND_NAMES.has(artifactId) ? `agentera ${artifactId} --format json` : null;
  let advancedCommand: string | null;
  if (artifactId === "benchmark_context") advancedCommand = BENCHMARK_CONTEXT_COMMAND;
  else if (STATE_COMMAND_NAMES.has(artifactId)) advancedCommand = null;
  else advancedCommand = `agentera query ${artifactId} --format json`;
  let policy: string;
  if (routineCommand) policy = "Use the routine state command for normal content reads before any raw artifact access.";
  else if (advancedCommand) policy = "Use the listed CLI discovery/query surface before any last-resort raw artifact access.";
  else policy = "No normal content-read command is registered; raw access is limited to allowed boundary cases.";
  return {
    normal_read_command: routineCommand,
    advanced_query_command: advancedCommand,
    raw_access_boundary: {
      normal_policy: policy,
      allowed_raw_artifact_uses: ALLOWED_RAW_ARTIFACT_USES,
    },
  };
}

function artifactLocationRecord(
  name: string,
  info: SchemaInfo,
  schemasDir: string,
  docsOverrides: Record<string, string>,
): JsonObject {
  const record = info.record ?? null;
  const schema = info.schema && typeof info.schema === "object" ? info.schema : {};
  // cast: schema.meta is read from a parsed artifact schema (YAML IO boundary)
  const meta = (schema.meta ?? {}) as JsonObject;
  const schemaFile = path.join(schemasDir, `${name}.yaml`);
  const artifactId = record !== null ? record.artifactId : name;
  const displayName = record !== null ? record.displayName : String(meta.name ?? name);
  const defaultPath = record !== null ? record.defaultPath : String(info.path ?? "");
  let mappedPath = defaultPath;
  let resolutionSource = record !== null ? "registry default" : "schema metadata";
  const caveats: string[] = [];
  if (record !== null && record.docsYamlCanOverridePath && record.displayName in docsOverrides) {
    mappedPath = docsOverrides[record.displayName];
    resolutionSource = ".agentera/docs.yaml mapping";
  }
  const objectiveName = activeObjectiveName();
  let resolvedPath: string | null = null;
  if (record !== null && record.pathTemplate && mappedPath.includes("<name>") && !objectiveName) {
    caveats.push("Path template contains <name>; no active objective name was available for resolution.");
  } else {
    try {
      resolvedPath =
        record !== null ? resolveArtifactPath(record, process.cwd(), objectiveName) : resolveArtifactPathLocal(mappedPath);
    } catch (exc) {
      caveats.push((exc as Error).message);
    }
  }
  const pathPayload = {
    default_path: defaultPath,
    mapped_path: mappedPath,
    resolved_path: resolvedPath !== null ? resolvedPath : null,
    display_path: resolvedPath !== null ? projectRelativeOrAbsolute(resolvedPath) : mappedPath,
    resolution_source: resolutionSource,
    exists: resolvedPath !== null ? fs.existsSync(resolvedPath) : false,
    docs_yaml_can_override_path: record !== null ? record.docsYamlCanOverridePath : false,
    project_boundary_check: resolvedPath !== null ? "enforced" : "not_resolved",
  };
  return {
    artifact_id: artifactId,
    name: artifactId,
    display_name: displayName,
    artifact_type: record !== null ? record.artifactType : meta.artifact_type ?? "unknown",
    format: typeof meta === "object" ? meta.format ?? "unknown" : "unknown",
    producer: record !== null ? [...record.producers].sort() : meta.producer ?? "unknown",
    consumers: record !== null ? [...record.consumers].sort() : meta.consumers ?? "unknown",
    schema_file: fileExists(schemaFile) ? schemaFile : null,
    path: pathPayload,
    ...artifactReadInterfaces(name, record),
    caveats,
  };
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function artifactLocationContract(schemasDir: string, schemas: Record<string, SchemaInfo>): JsonObject {
  const docsOverrides = loadDocsPathOverrides(process.cwd());
  const names = Object.keys(schemas).sort();
  const records = names.map((name) => artifactLocationRecord(name, schemas[name], schemasDir, docsOverrides));
  // cast: record.caveats is built from schema/registry path resolution (IO boundary)
  const caveats = records.flatMap((record) => record.caveats as string[]);
  return {
    schemaVersion: "agentera.artifact_locations.v1",
    status: dirExists(schemasDir) ? "complete" : "missing_schemas",
    source: {
      schemas_dir: schemasDir,
      docs_yaml_path: path.join(process.cwd(), ".agentera", "docs.yaml"),
      docs_yaml_overrides_loaded: Object.keys(docsOverrides).length > 0,
    },
    source_contract: {
      raw_artifact_reads_required_for_discovery: false,
      normal_content_policy:
        "Use routine state commands when normal_read_command is present; use query only for advanced/custom artifact inspection.",
      raw_artifact_read_policy:
        "Raw artifact reads remain valid only for explicit writes, archival, validation, corruption diagnostics, CLI defects, unavailable/incomplete CLI state after fallbacks, and benchmark analysis.",
      allowed_raw_artifact_uses: ALLOWED_RAW_ARTIFACT_USES,
    },
    artifacts: records,
    caveats,
  };
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function queryGenericEntries(args: QueryArgs, schemas: Record<string, SchemaInfo>, name: string): JsonObject[] {
  const info = schemas[name];
  const data = loadArtifact(artifactPath(info, name));
  let entries = extractEntries(data);
  if (entries.length === 0) return [];
  const topic = args.topic ?? null;
  const sev = args.severity ?? null;
  const dim = args.dimension ?? null;
  const status = args.status ?? null;
  if (topic) entries = filterByTopic(entries, topic, info.fields);
  if (sev) entries = filterByFieldValue(entries, "severity", sev);
  if (status) entries = filterByFieldValue(entries, "status", status);
  if (dim) {
    entries = filterByFieldValue(entries, "dimension", dim, true);
    if (entries.length === 0) {
      entries = filterByFieldValue(extractEntries(data), "dimensions", dim, true);
    }
  }
  return entries;
}

function queryGeneric(args: QueryArgs, schemas: Record<string, SchemaInfo>, name: string, io: Io): number {
  const o = out(io);
  const e = err(io);
  const format = args.format ?? "text";
  const entries = queryGenericEntries(args, schemas, name);
  if (format !== "text") {
    const info = schemas[name];
    const p = artifactPath(info, name);
    const source = sourceMetadata(name, p);
    const filters = {
      topic: args.topic ?? null,
      severity: args.severity ?? null,
      status: args.status ?? null,
      dimension: args.dimension ?? null,
    };
    return emitStateStructured(name, structuredState(name, entries, source, { filters }), format, args.fields, o, e);
  }
  if (entries.length === 0) return 1;
  const info = schemas[name];
  const disp = displayFields(info.fields);
  for (const entry of entries) {
    const line = formatEntry(entry, disp);
    if (line) o(line + "\n");
  }
  return 0;
}

function queryLastPhase(args: QueryArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  const o = out(io);
  const e = err(io);
  const format = args.format ?? "text";
  const info = schemas.progress;
  if (!info) {
    e(missingSchemaError("progress") + "\n");
    return 1;
  }
  const data = loadArtifact(artifactPath(info, "progress"));
  const entries = extractEntries(data);
  if (entries.length === 0) {
    if (format !== "text") emitStructured(null, format, o);
    return 0;
  }
  const last = recentCycles(entries, 1)[0];
  const phase = last.phase ?? "";
  if (format !== "text") {
    emitStructured({ phase }, format, o);
    return 0;
  }
  if (phase) o(phase + "\n");
  return 0;
}

function queryDesign(args: QueryArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  const o = out(io);
  const e = err(io);
  const info = schemas.design;
  if (!info) {
    e(missingSchemaError("design") + "\n");
    return 1;
  }
  const p = artifactPath(info, "design");
  const data = loadArtifact(p);
  const entries = extractEntries(data);
  if (entries.length > 0) {
    let filtered = entries;
    const topic = args.topic ?? null;
    if (topic) filtered = filterByTopic(filtered, topic, info.fields);
    for (const entry of filtered) {
      const line = formatEntry(entry, ["category", "name", "value"]);
      if (line) o(line + "\n");
    }
    return 0;
  }
  if (!fs.existsSync(p)) return 0;
  const text = fs.readFileSync(p, "utf8");
  const markers: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith("<!-- design:") && stripped.endsWith("-->")) {
      markers.push(stripped.slice("<!-- design:".length, stripped.length - "-->".length).trim());
    }
  }
  o(`Design: sections=${markers.length}\n`);
  for (const marker of markers.slice(0, 20)) o(`category=${marker}\n`);
  return 0;
}

export function cmdQuery(args: QueryArgs, io: Io): number {
  const o = out(io);
  const e = err(io);
  const format = args.format ?? "text";
  // cast: args are parsed CLI argv values passed to the filter validator (external-input boundary)
  validateFilterValues(args as JsonObject, COMMAND_FILTERS.query);
  if (args.limit !== null && args.limit !== undefined && args.limit < 0) {
    throw new Error("limit must be zero or greater");
  }
  if (args.list_artifacts) {
    const schemasDir = discoverSchemasDir();
    const schemas = loadSchemas(schemasDir);
    const names = Object.keys(schemas).sort();
    if (format !== "text") {
      const locations = artifactLocationContract(schemasDir, schemas);
      emitStructured(
        {
          schemaVersion: "agentera.query.list_artifacts.v2",
          command: "query",
          status: locations.status,
          names,
          artifacts: locations.artifacts,
          source: locations.source,
          source_contract: locations.source_contract,
          caveats: locations.caveats,
        },
        format,
        o,
      );
      return 0;
    }
    for (const name of names) o(name + "\n");
    return 0;
  }
  const query = args.query ?? "";
  if (!query) {
    e("Error: query pattern required (or use --list-artifacts)\n");
    return 1;
  }
  validateAgentString(query, "query");
  if (query.includes("/") || query.includes("\\") || query === "." || query === ".." || ENCODED_TRAVERSAL_RE.test(query)) {
    throw new Error(`unsupported artifact/query name ${pyRepr(query)}; path-like values are not artifact names`);
  }
  if (STATE_COMMAND_NAMES.has(query)) {
    e(`Unsupported routine query: ${query}. Use \`agentera ${query}\` instead.\n`);
    return 1;
  }
  const schemas = loadSchemas(discoverSchemasDir());
  const stateArgs = args as unknown as StateArgs;
  const handlers: Record<string, (a: QueryArgs, s: Record<string, SchemaInfo>, io: Io) => number> = {
    "last-phase": queryLastPhase,
    design: queryDesign,
    "open-todos": (a, s, ioo) => queryTodo({ ...(a as unknown as StateArgs), command: "todo" }, s, ioo, true),
  };
  if (query in handlers) {
    if (format !== "text" && query in schemas) return queryGeneric(args, schemas, query, io);
    return handlers[query](args, schemas, io);
  }
  if (query in schemas) return queryGeneric(args, schemas, query, io);
  for (const name of Object.keys(schemas)) {
    if (query === name || query === name.replace(/s$/, "") || query === name + "s") {
      return queryGeneric(args, schemas, name, io);
    }
  }
  e(`Unknown query: ${query}\n`);
  return 1;
}

function pyRepr(value: string): string {
  return value.includes("'") && !value.includes('"') ? `"${value}"` : `'${value}'`;
}
