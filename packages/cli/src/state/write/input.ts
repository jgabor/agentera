import fs from "node:fs";

import { loadYamlMapping } from "../../core/yaml.js";
import { glossaryCaveatContract } from "../../registries/glossaryCaveatContract.js";

export type StructuredInputFieldType = "string" | "date" | "datetime" | "mapping" | "list";

export interface StructuredInputFieldDescriptor {
  path: string;
  type: StructuredInputFieldType;
  required: boolean;
  enum?: readonly string[];
  itemType?: StructuredInputFieldType;
  acceptedForms?: readonly string[];
  shape?: string;
  update: "replace" | "defaulted" | "append_unique" | "patch";
  description: string;
}

export interface StructuredInputSchemaDescriptor {
  root: string;
  fields: readonly StructuredInputFieldDescriptor[];
  semantics: Record<string, unknown>;
  ownedFields: readonly string[];
  immutableFields: readonly string[];
  bounds: Record<string, number>;
  examples: readonly string[];
}

const caveat = glossaryCaveatContract();
const field = (
  path: string,
  type: StructuredInputFieldType,
  description: string,
  options: Omit<StructuredInputFieldDescriptor, "path" | "type" | "description"> = { required: false, update: "replace" },
): StructuredInputFieldDescriptor => ({ path, type, description, ...options });

const PROGRESS_INPUT_SCHEMA: StructuredInputSchemaDescriptor = {
  root: "one progress cycle record",
  fields: [
    field("timestamp", "datetime", "Writer-defaulted cycle timestamp.", { required: false, update: "defaulted" }),
    field("type", "string", "Conventional change type.", { required: true, enum: ["feat", "fix", "docs", "refactor", "chore", "test"], update: "replace" }),
    field("phase", "string", "Lifecycle phase.", { required: true, enum: ["envision", "deliberate", "plan", "build", "audit"], update: "replace" }),
    field("what", "string", "Non-empty summary of the cycle.", { required: true, update: "replace" }),
    field("inspiration", "string", "Optional inspiration evidence.", { required: false, update: "replace" }),
    field("discovered", "string", "Optional discovery evidence.", { required: false, update: "replace" }),
    field("verified", "string", "Optional verification evidence.", { required: false, update: "replace" }),
    field("next", "string", "Optional next-step evidence.", { required: false, update: "replace" }),
    field("context", "mapping", "Required context mapping.", { required: true, shape: "intent:string, constraints?:string, unknowns?:string, scope?:string", update: "replace" }),
    field("context.intent", "string", "Required cycle intent.", { required: true, update: "replace" }),
    field("context.constraints", "string", "Optional constraints.", { required: false, update: "replace" }),
    field("context.unknowns", "string", "Optional unknowns.", { required: false, update: "replace" }),
    field("context.scope", "string", "Optional scope.", { required: false, update: "replace" }),
    field("glossary_caveat", "mapping", "Optional bounded glossary-caveat lifecycle envelope.", { required: false, shape: "event, reason, ownership_state, caveat_id?, transition_id?", update: "replace" }),
    field("glossary_caveat.event", "string", "Caveat lifecycle event.", { required: false, enum: caveat.events, update: "replace" }),
    field("glossary_caveat.reason", "string", "Authority-declared caveat reason.", { required: false, enum: caveat.reasons, update: "replace" }),
    field("glossary_caveat.ownership_state", "string", "Authority-declared ownership state.", { required: false, enum: caveat.ownershipStates, update: "replace" }),
    field("glossary_caveat.caveat_id", "string", "Existing opaque caveat selector for terminal events.", { required: false, update: "replace" }),
    field("glossary_caveat.transition_id", "string", "Existing opaque successor selector for supersession.", { required: false, update: "replace" }),
  ],
  semantics: {
    mode: "append_record",
    omitted_fields: "not present in the canonical record except writer-defaulted timestamp",
    writer_metadata: "id, artifact, and publication_order are assigned by the writer and excluded from logical replay comparison",
    glossary_caveat: "current events deduplicate by the existing caveat lifecycle contract; resolved and superseded events remain distinct",
  },
  ownedFields: ["id", "artifact", "publication_order"],
  immutableFields: [],
  bounds: { max_input_utf8_bytes: 32768, max_collection_items: 1 },
  examples: ["agentera state progress append --input progress.yaml --format json"],
};

const DECISION_APPEND_INPUT_SCHEMA: StructuredInputSchemaDescriptor = {
  root: "one decision record",
  fields: [
    field("date", "date", "Writer-defaulted decision date.", { required: false, update: "defaulted" }),
    field("question", "string", "Question under deliberation.", { required: true, update: "replace" }),
    field("context", "string", "Decision context.", { required: true, update: "replace" }),
    field("alternatives", "mapping", "Alternatives mapping or ordered canonical alternative list.", { required: true, acceptedForms: ["mapping", "ordered_alternative_list"], shape: "chosen:string, rejected?:string[]", update: "replace" }),
    field("alternatives.chosen", "string", "Exactly one chosen alternative.", { required: true, update: "replace" }),
    field("alternatives.rejected", "list", "Optional rejected alternatives in caller order.", { required: false, itemType: "string", update: "replace" }),
    field("choice", "string", "Selected choice.", { required: true, update: "replace" }),
    field("reasoning", "string", "Decision reasoning.", { required: true, update: "replace" }),
    field("confidence", "string", "Current confidence vocabulary.", { required: true, enum: ["firm", "provisional", "exploratory"], update: "replace" }),
    field("feeds_into", "string", "Optional downstream relationship.", { required: false, update: "replace" }),
  ],
  semantics: {
    mode: "append_record",
    alternatives: "ordered list ordering is significant; mapping input is normalized to the canonical ordered list",
    writer_metadata: "id and artifact are assigned by the writer and excluded from logical replay comparison",
  },
  ownedFields: ["id", "artifact"],
  immutableFields: ["number", "satisfaction"],
  bounds: { max_input_utf8_bytes: 32768, max_collection_items: 1 },
  examples: ["agentera state decisions append --input decision.yaml --format json"],
};

const DECISION_AMEND_INPUT_SCHEMA: StructuredInputSchemaDescriptor = {
  root: "amendable decision content",
  fields: DECISION_APPEND_INPUT_SCHEMA.fields
    .filter((entry) => entry.path !== "date")
    .map((entry) => ({ ...entry, required: entry.path === "alternatives.chosen" ? false : false, update: entry.path === "alternatives.rejected" ? "append_unique" : "patch" })),
  semantics: {
    mode: "patch",
    omitted_fields: "preserve the effective record",
    alternatives: "alternatives.chosen replaces the chosen value; alternatives.rejected appends unique rejected values in input order",
    immutable_fields: "date, number, satisfaction, id, artifact, and base_sha256 are not amendment content",
  },
  ownedFields: ["id", "artifact", "base_sha256"],
  immutableFields: ["date", "number", "satisfaction"],
  bounds: { max_input_utf8_bytes: 32768, max_collection_items: 1 },
  examples: ["agentera state decisions amend --id qjtrmnpvka --base-sha256 HASH --input amendment.yaml --format json"],
};

const STRUCTURED_INPUT_SCHEMAS: Record<string, StructuredInputSchemaDescriptor> = {
  "progress.append": PROGRESS_INPUT_SCHEMA,
  "decisions.append": DECISION_APPEND_INPUT_SCHEMA,
  "decisions.amend": DECISION_AMEND_INPUT_SCHEMA,
};

export function structuredInputDescriptor(artifact: string, verb: string): StructuredInputSchemaDescriptor | null {
  return STRUCTURED_INPUT_SCHEMAS[`${artifact}.${verb}`] ?? null;
}

export function structuredInputSchemaProjection(schema: StructuredInputSchemaDescriptor): Record<string, unknown> {
  return {
    root: schema.root,
    fields: schema.fields.map((entry) => ({
      path: entry.path,
      type: entry.type,
      required: entry.required,
      ...(entry.enum ? { enum: [...entry.enum] } : {}),
      ...(entry.itemType ? { item_type: entry.itemType } : {}),
      ...(entry.acceptedForms ? { accepted_forms: [...entry.acceptedForms] } : {}),
      ...(entry.shape ? { shape: entry.shape } : {}),
      update: entry.update,
      description: entry.description,
    })),
    semantics: structuredClone(schema.semantics),
    owned_fields: [...schema.ownedFields],
    immutable_fields: [...schema.immutableFields],
    bounds: structuredClone(schema.bounds),
    examples: [...schema.examples],
  };
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, violations: string[]): void {
  if (typeof value !== "string" || value.length === 0)
    violations.push(`${field} must be a non-empty string`);
}

function optionalString(value: unknown, field: string, violations: string[]): void {
  if (value !== undefined && (typeof value !== "string" || value.length === 0))
    violations.push(`${field} must be a non-empty string when present`);
}

function unknownFields(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  violations: string[],
): void {
  for (const field of Object.keys(input))
    if (!allowed.has(field)) violations.push(`input field '${field}' is not accepted for this mutation`);
}

function descriptorsFor(schema: StructuredInputSchemaDescriptor, prefix: string): StructuredInputFieldDescriptor[] {
  return schema.fields.filter((entry) => entry.path === prefix || entry.path.startsWith(`${prefix}.`));
}

function descriptor(schema: StructuredInputSchemaDescriptor, path: string): StructuredInputFieldDescriptor {
  const found = schema.fields.find((entry) => entry.path === path);
  if (!found) throw new Error(`structured input schema is missing '${path}'`);
  return found;
}

function topLevelFields(schema: StructuredInputSchemaDescriptor): Set<string> {
  return new Set(schema.fields.map((entry) => entry.path.split(".")[0]));
}

function enumValues(schema: StructuredInputSchemaDescriptor, path: string): readonly string[] {
  return descriptor(schema, path).enum ?? [];
}

function alternativesViolations(
  value: unknown,
  violations: string[],
  requireChosen: boolean,
  schema: StructuredInputSchemaDescriptor,
): void {
  if (Array.isArray(value)) {
    const chosen = value.filter(
      (entry) => mapping(entry) && entry.status === "chosen",
    );
    if (chosen.length !== 1 || value.some(
      (entry) => !mapping(entry) || typeof entry.name !== "string" || entry.name.length === 0 || !["chosen", "rejected"].includes(String(entry.status)),
    )) {
      violations.push("alternatives must be a mapping or a list with exactly one named chosen alternative");
    }
    if (!requireChosen && value.length === 0) violations.push("alternatives must not be empty");
    return;
  }
  if (!mapping(value)) {
    violations.push("alternatives must be a mapping with chosen and rejected fields");
    return;
  }
  unknownFields(value, new Set(descriptorsFor(schema, "alternatives").map((entry) => entry.path.split(".").at(-1) as string)), violations);
  if (requireChosen) requiredString(value.chosen, "alternatives.chosen", violations);
  else if (value.chosen !== undefined) optionalString(value.chosen, "alternatives.chosen", violations);
  if (value.rejected !== undefined && (!Array.isArray(value.rejected) || value.rejected.some((entry) => typeof entry !== "string" || entry.length === 0)))
    violations.push("alternatives.rejected must be a list of non-empty strings when present");
}

function progressInputViolations(input: Record<string, unknown>): string[] {
  const violations: string[] = [];
  const schema = structuredInputDescriptor("progress", "append") as StructuredInputSchemaDescriptor;
  unknownFields(input, topLevelFields(schema), violations);
  requiredString(input.type, "type", violations);
  requiredString(input.phase, "phase", violations);
  requiredString(input.what, "what", violations);
  if (typeof input.type === "string" && !enumValues(schema, "type").includes(input.type))
    violations.push(`type must be one of ${enumValues(schema, "type").join(", ")}`);
  if (typeof input.phase === "string" && !enumValues(schema, "phase").includes(input.phase))
    violations.push(`phase must be one of ${enumValues(schema, "phase").join(", ")}`);
  if (input.timestamp !== undefined && (typeof input.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(input.timestamp)))
    violations.push("timestamp must use YYYY-MM-DD HH:MM when present");
  for (const field of ["inspiration", "discovered", "verified", "next"])
    optionalString(input[field], field, violations);
  if (!mapping(input.context)) violations.push("context must be a mapping with intent");
  else {
    unknownFields(input.context, new Set(descriptorsFor(schema, "context").map((entry) => entry.path.split(".").at(-1) as string)), violations);
    requiredString(input.context.intent, "context.intent", violations);
    for (const field of ["constraints", "unknowns", "scope"])
      optionalString(input.context[field], `context.${field}`, violations);
  }
  if (input.glossary_caveat !== undefined) {
    if (!mapping(input.glossary_caveat)) violations.push("glossary_caveat must be a mapping");
    else {
      unknownFields(input.glossary_caveat, new Set(descriptorsFor(schema, "glossary_caveat").map((entry) => entry.path.split(".").at(-1) as string)), violations);
      for (const field of descriptorsFor(schema, "glossary_caveat").map((entry) => entry.path.split(".").at(-1) as string).filter((entry) => entry !== "glossary_caveat"))
        if (input.glossary_caveat[field] !== undefined && input.glossary_caveat[field] !== null)
          optionalString(input.glossary_caveat[field], `glossary_caveat.${field}`, violations);
    }
  }
  return violations;
}

function decisionInputViolations(input: Record<string, unknown>, verb: "append" | "amend"): string[] {
  const violations: string[] = [];
  const schema = structuredInputDescriptor("decisions", verb) as StructuredInputSchemaDescriptor;
  unknownFields(input, topLevelFields(schema), violations);
  if (verb === "append") {
    requiredString(input.question, "question", violations);
    requiredString(input.context, "context", violations);
    requiredString(input.choice, "choice", violations);
    requiredString(input.reasoning, "reasoning", violations);
    requiredString(input.confidence, "confidence", violations);
    if (input.date !== undefined && (typeof input.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)))
      violations.push("date must use YYYY-MM-DD when present");
  } else {
    if (Object.keys(input).length === 0) violations.push("decision amendment requires at least one content field");
    for (const field of ["question", "context", "choice", "reasoning", "confidence", "feeds_into"])
      optionalString(input[field], field, violations);
  }
  if (input.confidence !== undefined && (typeof input.confidence !== "string" || !enumValues(schema, "confidence").includes(input.confidence)))
    violations.push(`confidence must be one of ${enumValues(schema, "confidence").join(", ")}`);
  if (input.alternatives !== undefined) alternativesViolations(input.alternatives, violations, verb === "append", schema);
  else if (verb === "append") violations.push("alternatives is required");
  return violations;
}

export function structuredRecordInputViolations(
  artifact: string,
  verb: string,
  input: Record<string, unknown> | null,
): string[] {
  if (!input || (artifact !== "progress" && artifact !== "decisions")) return [];
  if (artifact === "progress" && verb === "append") return progressInputViolations(input);
  if (artifact === "decisions" && (verb === "append" || verb === "amend"))
    return decisionInputViolations(input, verb);
  return [];
}

export function normalizeDecisionRecordInput(input: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(input);
  if (!Array.isArray(result.alternatives)) return result;
  const alternatives = result.alternatives as unknown[];
  const chosen = alternatives.find((entry) => mapping(entry) && entry.status === "chosen") as Record<string, unknown> | undefined;
  result.alternatives = {
    chosen: chosen?.name,
    rejected: alternatives
      .filter((entry) => mapping(entry) && entry.status === "rejected")
      .map((entry) => (entry as Record<string, unknown>).name),
  };
  return result;
}

export function loadStructuredInput(
  source: string,
  readStdin: () => string | Buffer,
  maxBytes?: number,
): Record<string, unknown> {
  let bytes: Buffer;
  if (source === "-") {
    const input = readStdin();
    bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  }
  else {
    try {
      bytes = fs.readFileSync(source);
    } catch {
      throw new Error(`input file '${source}' is not readable`);
    }
  }
  if (maxBytes !== undefined && maxBytes > 0 && bytes.byteLength > maxBytes)
    throw new Error(`input exceeds the ${maxBytes}-byte UTF-8 limit`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("input is not valid UTF-8");
  }
  try {
    return loadYamlMapping(text);
  } catch (error) {
    throw new Error(`input is not valid YAML or JSON: ${(error as Error).message}`);
  }
}
