import fs from "node:fs";

import { updatePersonalGlossaryProfile, type PersonalGlossaryEntry } from "../../analytics/personalGlossaryProfile.js";
import { loadYamlMapping } from "../../core/yaml.js";
import { personalGlossaryOutputContract, type GlossaryAdmissionContext } from "../../registries/glossaryEntryContract.js";
import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";
import { emitStructured } from "../structured.js";
import type { Io } from "../dispatch/shared.js";

type Mapping = Record<string, unknown>;
const REQUEST_FIELDS = ["schema_version", "profile_path", "as_of", "fresh_entries", "retained_history"];
const HISTORY_FIELDS = ["source_id", "evidence_anchor", "source_kind", "signal_type"];
const RECOVERY = "Correct the request and retry the same command; no profile bytes were changed.";

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Mapping : null;
}

function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function invalid(io: Io, body: InvalidInputErrorBody): number {
  return emitInvalidInput(io, { format: "json", body: { ...body, recovery: body.recovery ?? RECOVERY } });
}

function parseArgs(argv: string[]): { input: string; dryRun: boolean } | InvalidInputErrorBody {
  let input: string | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inline] = argument.split("=", 2);
    if (name === "--dry-run") {
      if (inline !== undefined) return { class: "unrecognized_argument", message: "--dry-run does not accept a value" };
      dryRun = true;
      continue;
    }
    if (name === "--input" || name === "--format") {
      const value = inline ?? argv[++index];
      if (!value || value.startsWith("--")) return { class: "missing_argument", message: `${name} requires a value`, syntax: `${name} VALUE` };
      if (name === "--format") {
        if (value !== "json") return { class: "invalid_choice", message: `argument --format: invalid choice: '${value}' (choose from 'json')`, valid_values: ["json"] };
      } else {
        if (input !== undefined) return { class: "mutually_exclusive", message: "--input may only be supplied once" };
        input = value;
      }
      continue;
    }
    return { class: "unrecognized_argument", message: `unrecognized arguments: ${argument}`, syntax: "agentera report profile-glossary --input <file|-> [--dry-run] --format json" };
  }
  if (!input) return { class: "missing_argument", message: "--input is required", syntax: "agentera report profile-glossary --input <file|-> [--dry-run] --format json" };
  return { input, dryRun };
}

function readRequest(source: string, io: Io): Mapping {
  let bytes: Buffer;
  if (source === "-") bytes = Buffer.from(io.stdin ? io.stdin() : fs.readFileSync(0));
  else bytes = fs.readFileSync(source);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = mapping(loadYamlMapping(text));
  if (!parsed) throw new Error("request is not a mapping");
  return parsed;
}

function validateRequest(value: Mapping): InvalidInputErrorBody | null {
  const contract = personalGlossaryOutputContract();
  const keys = Object.keys(value);
  const unsupported = keys.filter((key) => !REQUEST_FIELDS.includes(key));
  const missing = REQUEST_FIELDS.filter((key) => !(key in value));
  if (unsupported.length > 0 || missing.length > 0) {
    return { class: "schema_violation", message: `request fields are invalid${missing.length ? `; missing: ${missing.join(", ")}` : ""}${unsupported.length ? `; unsupported: ${unsupported.join(", ")}` : ""}`, valid_values: REQUEST_FIELDS };
  }
  if (value.schema_version !== contract.requestSchemaVersion) {
    return { class: "schema_violation", message: `schema_version must be ${contract.requestSchemaVersion}`, valid_values: [contract.requestSchemaVersion] };
  }
  if (typeof value.profile_path !== "string" || value.profile_path.trim() === "") {
    return { class: "invalid_request", message: "profile_path must be the exact non-empty path returned by prime profile context", valid_values: ["profile_context.profile.path"] };
  }
  if (!calendarDate(value.as_of)) {
    return { class: "invalid_request", message: "as_of must be an ISO calendar date", valid_values: ["YYYY-MM-DD"] };
  }
  if (!Array.isArray(value.fresh_entries) || value.fresh_entries.some((entry) => !mapping(entry))) {
    return { class: "invalid_request", message: "fresh_entries must be a list of shared personal glossary entries", valid_values: ["fresh_entries: []"] };
  }
  for (const [index, raw] of value.fresh_entries.entries()) {
    const entry = mapping(raw)!;
    const temporal = mapping(entry.temporal);
    if (!temporal || !calendarDate(temporal.observed_at) || !calendarDate(temporal.last_confirmed_at)) {
      return { class: "invalid_request", message: `fresh_entries[${index}].temporal requires observed_at and last_confirmed_at ISO calendar dates`, valid_values: ["YYYY-MM-DD"] };
    }
    if (!(["stable", "durable", "situational"] as unknown[]).includes(entry.permanence)) {
      return { class: "invalid_request", message: `fresh_entries[${index}].permanence is invalid`, valid_values: ["stable", "durable", "situational"] };
    }
    const provenance = mapping(entry.provenance);
    if (!provenance || !["personal_explicit_definition", "personal_inferred_usage"].includes(String(provenance.kind))) {
      return { class: "invalid_request", message: `fresh_entries[${index}].provenance.kind is invalid`, valid_values: ["personal_explicit_definition", "personal_inferred_usage"] };
    }
  }
  if (!Array.isArray(value.retained_history) || value.retained_history.some((row) => !mapping(row))) {
    return { class: "invalid_request", message: "retained_history must be a list", valid_values: ["retained_history: []"] };
  }
  for (const [index, raw] of value.retained_history.entries()) {
    const row = mapping(raw)!;
    if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...HISTORY_FIELDS].sort()) || HISTORY_FIELDS.some((field) => typeof row[field] !== "string" || String(row[field]).trim() === "")) {
      return { class: "invalid_request", message: `retained_history[${index}] must contain exactly ${HISTORY_FIELDS.join(", ")}`, valid_values: HISTORY_FIELDS };
    }
  }
  return null;
}

function admissionContext(rows: unknown[]): GlossaryAdmissionContext | InvalidInputErrorBody {
  const retainedHistory = new Map<string, { sourceId: string; sourceKind: string; signalType: string }>();
  for (const raw of rows) {
    const row = mapping(raw)!;
    const anchor = String(row.evidence_anchor);
    if (retainedHistory.has(anchor)) return { class: "conflict", message: `retained_history contains duplicate evidence_anchor '${anchor}'`, valid_values: ["one row per evidence_anchor"] };
    retainedHistory.set(anchor, { sourceId: String(row.source_id), sourceKind: String(row.source_kind), signalType: String(row.signal_type) });
  }
  return { retainedHistory };
}

export function runPersonalGlossaryCommand(argv: string[], io: Io): number {
  const parsed = parseArgs(argv);
  if ("class" in parsed) return invalid(io, parsed);
  let request: Mapping;
  try {
    request = readRequest(parsed.input, io);
  } catch {
    return invalid(io, { class: "invalid_format", message: "--input must be a readable UTF-8 YAML or JSON mapping", valid_values: ["YAML mapping", "JSON object"] });
  }
  const requestError = validateRequest(request);
  if (requestError) return invalid(io, requestError);
  const profilePath = String(request.profile_path);
  try {
    if (!fs.statSync(profilePath).isFile()) throw new Error("not a regular file");
  } catch {
    return invalid(io, { class: "invalid_request", message: `profile_path is not an existing readable PROFILE.md file: ${profilePath}`, valid_values: ["existing PROFILE.md path from profile_context.profile.path"] });
  }
  const context = admissionContext(request.retained_history as unknown[]);
  if ("class" in context) return invalid(io, context);
  try {
    const result = updatePersonalGlossaryProfile({
      profilePath,
      asOf: String(request.as_of),
      freshEntries: request.fresh_entries as PersonalGlossaryEntry[],
      retainedHistory: context,
      dryRun: parsed.dryRun,
    });
    const candidateStatus = result.changed ? "changed" : "unchanged";
    emitStructured({
      schemaVersion: "agentera.personalGlossaryUpdate.v1",
      command: "report profile-glossary",
      status: parsed.dryRun ? "dry_run_candidate" : result.changed ? "changed" : "unchanged_replay",
      dry_run: parsed.dryRun,
      candidate_status: candidateStatus,
      profile_path: profilePath,
      entry_count: result.entries.length,
    }, "json", io.out ?? ((text) => process.stdout.write(text)));
    return 0;
  } catch (error) {
    const message = (error as Error).message;
    return invalid(io, {
      class: /conflict|duplicate|ambiguous/i.test(message) ? "conflict" : "invalid_request",
      message,
      valid_values: ["stable", "durable", "situational", "personal_explicit_definition", "personal_inferred_usage"],
    });
  }
}
