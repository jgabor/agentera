import { artifactPath, discoverSchemasDir, loadSchemas, SchemaInfo } from "../appContext.js";
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
  truncate,
  validateFilterValues,
} from "../stateQuery.js";

type Dict = Record<string, any>;
type Io = { out?: (t: string) => void; err?: (t: string) => void };

export interface StateArgs {
  command: string;
  topic?: string | null;
  status?: string | null;
  dimension?: string | null;
  severity?: string | null;
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

export function queryProgress(args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  const o = out(io);
  const e = err(io);
  const info = schemas.progress;
  if (!info) {
    e(missingSchemaError("progress") + "\n");
    return 1;
  }
  const p = artifactPath(info, "progress");
  const data = loadArtifact(p);
  let entries = extractEntries(data);
  const topic = args.topic ?? null;
  if (topic) entries = filterByTopic(entries, topic, info.fields);
  const statusFilter = args.status ?? null;
  if (statusFilter) entries = filterByFieldValue(entries, "type", statusFilter);
  const effectiveLimit = (args.limit ?? 5) || 5;
  entries = recentCycles(entries, effectiveLimit);

  if ((args.format ?? "text") !== "text") {
    return emitStateStructured(
      "progress",
      structuredState("progress", entries, sourceMetadata("progress", p), {
        filters: { topic, status: statusFilter, limit: effectiveLimit },
      }),
      args.format ?? "text",
      args.fields,
      o,
      e,
    );
  }
  if (entries.length === 0) return 0;
  for (const entry of entries) {
    o(formatEntry(entry, ["number", "timestamp", "type", "phase", "commit"]) + "\n");
    for (const key of ["what", "verified", "next"]) {
      const value = entry[key];
      if (value) o(`  ${key}: ${truncate(value)}\n`);
    }
  }
  return 0;
}

const STATE_COMMAND_HANDLERS: Record<
  string,
  (args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io) => number
> = {
  progress: queryProgress,
};

export function isPortedStateCommand(command: string): boolean {
  return command in STATE_COMMAND_HANDLERS;
}

export function cmdState(args: StateArgs, io: Io): number {
  const e = err(io);
  try {
    validateFilterValues(args as Dict, COMMAND_FILTERS[args.command] ?? []);
    if (args.limit !== null && args.limit !== undefined && args.limit < 0) {
      throw new Error("limit must be zero or greater");
    }
    const schemas = loadSchemas(discoverSchemasDir());
    const handler = STATE_COMMAND_HANDLERS[args.command];
    return handler(args, schemas, io);
  } catch (exc) {
    e(`Error: ${(exc as Error).message}\n`);
    return 2;
  }
}
