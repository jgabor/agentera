import type { JsonObject } from "../core/jsonValue.js";
import { projectEntityDevelopmentValue } from "../core/developmentInvocation.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { ENTITY_LIST_RUNTIME_FAMILIES, ENTITY_LIST_RUNTIME_BOUNDS, ENTITY_LIST_RUNTIME_FORMATS, ENTITY_LIST_RUNTIME_REGISTRY, ENTITY_LIST_RUNTIME_SELECTORS, runtimeEntityFamilyForHelpArgs, runtimeEntityListFamilyForHelpArgs, type EntityListRuntimeFamilyKey } from "./entityListRuntimeRegistry.js";
import { loadStateStorageAuthority } from "./stateStorageAuthority.js";

export const ENTITY_LIST_HELP_SCHEMA_VERSION = "agentera.entityListHelp.v1";

export interface EntityListFilterHelp {
  flag: string;
  name: string;
  values: string | string[];
}

export interface EntityListSummaryFieldNote {
  description: string;
  ownership: string;
  persisted: boolean;
  filter: boolean;
}

export interface EntityListFamilyHelp {
  key: EntityListRuntimeFamilyKey;
  commandTokens: string[];
  syntax: string;
  get: string;
  bareRead: "alias" | "correction";
  bareRecovery?: string;
  filters: EntityListFilterHelp[];
  familyIdentifier?: { syntax: string; required: boolean; description: string };
  summaryFields: string[];
  minimumFields: string[];
  summaryFieldNotes: Record<string, EntityListSummaryFieldNote>;
  selectors: {
    idsOnly: { flag: string; description: string };
    fields: { flag: string; description: string };
    mutualExclusion: boolean;
  };
  bounds: { minimum: number; default: number; maximum: number; maxUtf8Bytes: number };
  formats: string[];
  example: string;
}

interface CachedHelp {
  revision: symbol;
  families: EntityListFamilyHelp[];
}

let cache: CachedHelp | undefined;

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mapping(value: unknown): Record<string, unknown> {
  return isMapping(value) ? value : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  const values = strings(actual);
  return values.length === expected.length && values.every((value, index) => value === expected[index]);
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function requireMapping(parent: Record<string, unknown>, field: string, prefix: string, errors: string[]): Record<string, unknown> {
  if (!isMapping(parent[field])) {
    errors.push(`${prefix}.${field}`);
    return {};
  }
  return parent[field];
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], prefix: string, errors: string[]): void {
  for (const field of required) if (!(field in value)) errors.push(`${prefix}.${field}`);
  const allowed = new Set([...required, ...optional]);
  for (const field of Object.keys(value)) if (!allowed.has(field)) errors.push(`${prefix}.unknown.${field}`);
}

interface ValueFlag {
  flag: string;
  valueSyntax: string;
}

function valueFlag(syntax: string): ValueFlag | undefined {
  const tokens = syntax.split(" ");
  if (tokens.length !== 2 || !/^--[a-z][a-z0-9-]*$/.test(tokens[0]) || tokens[1].length === 0) return undefined;
  return { flag: tokens[0], valueSyntax: tokens[1] };
}

function identityPattern(value: Record<string, unknown>): RegExp | undefined {
  const pattern = mapping(mapping(value.entity_target).identity).accepted_pattern;
  if (typeof pattern !== "string") return undefined;
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function isIdentitySyntax(value: string): boolean {
  return value === "ID" || value.endsWith("_ID");
}

function validIdentity(value: string, syntax: string, pattern: RegExp | undefined): boolean {
  return !isIdentitySyntax(syntax) || Boolean(pattern?.test(value));
}

/**
 * Validate the canonical, whitespace-delimited argv form used by authority
 * examples. This consumes the projected family model; it is not a shell
 * parser and deliberately rejects quoting, expansion, and state-bound cursor
 * or record-field selectors.
 */
function exampleGrammarIssue(example: unknown, family: EntityListFamilyHelp, pattern: RegExp | undefined): string | undefined {
  if (typeof example !== "string") return "type";
  const tokens = example.split(" ");
  if (example.trim() !== example || tokens.some((token) => token.length === 0 || !/^[A-Za-z0-9_@.,:/|=+\-]+$/.test(token)) || tokens.join(" ") !== example) return "lexical_form";

  const prefix = ["npx", "-y", "agentera@next", "state", ...family.commandTokens, "list"];
  if (tokens.length < prefix.length || !prefix.every((token, index) => tokens[index] === token)) return "command";

  const identifierSyntax = family.familyIdentifier?.syntax;
  const identifierFlag = identifierSyntax?.startsWith("--") ? valueFlag(identifierSyntax) : undefined;
  const positionalIdentifier = identifierSyntax && !identifierSyntax.startsWith("--") ? identifierSyntax : undefined;
  if (identifierSyntax?.startsWith("--") && !identifierFlag) return "identifier_metadata";

  const filterFlags = new Map(
    family.filters.flatMap((filter) => {
      const parsed = valueFlag(filter.flag);
      return parsed ? [[parsed.flag, { ...parsed, values: filter.values }] as const] : [];
    }),
  );
  const fieldsFlag = valueFlag(family.selectors.fields.flag);
  if (!fieldsFlag) return "selector_metadata";

  const seen = new Set<string>();
  let identifierSupplied = false;
  let idsOnly = false;
  const argv = tokens.slice(prefix.length);
  for (let index = 0; index < argv.length;) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      if (!positionalIdentifier || identifierSupplied || !validIdentity(token, positionalIdentifier, pattern)) return "identifier";
      identifierSupplied = true;
      index += 1;
      continue;
    }
    if (token.includes("=")) return "lexical_form";
    if (token === family.selectors.idsOnly.flag) {
      if (idsOnly) return "selector";
      idsOnly = true;
      index += 1;
      continue;
    }

    const filter = filterFlags.get(token);
    const kind = token === identifierFlag?.flag ? "identifier" : filter ? "filter" : token === "--limit" ? "limit" : token === "--cursor" ? "cursor" : token === fieldsFlag.flag ? "fields" : token === "--format" ? "format" : undefined;
    if (!kind) return "argument";
    if (seen.has(token)) return "duplicate";
    seen.add(token);
    const argument = argv[index + 1];
    if (!argument || argument.startsWith("--")) return `${kind}_value`;
    index += 2;

    if (kind === "identifier") {
      if (identifierSupplied || !identifierFlag || !validIdentity(argument, identifierFlag.valueSyntax, pattern)) return "identifier";
      identifierSupplied = true;
    } else if (kind === "filter") {
      if (filter!.values !== "free_text" && (!Array.isArray(filter!.values) || !filter!.values.includes(argument))) return "filter_value";
    } else if (kind === "limit") {
      if (!/^[1-9][0-9]*$/.test(argument)) return "limit";
      const limit = Number(argument);
      if (!Number.isSafeInteger(limit) || limit < family.bounds.minimum || limit > family.bounds.maximum) return "limit";
    } else if (kind === "cursor") {
      // An opaque cursor is snapshot-bound and cannot be a durable executable example.
      return "cursor";
    } else if (kind === "fields") {
      // Record-field availability is snapshot-bound; IDs-only is the durable selector example.
      if (idsOnly) return "selector";
      return "fields";
    } else if (kind === "format") {
      if (!family.formats.includes(argument)) return "format";
    }
  }

  if (family.familyIdentifier?.required && !identifierSupplied) return "identifier_required";
  return undefined;
}

function entityRetrieval(value: Record<string, unknown>, artifact: string, boundary: string): Record<string, unknown> {
  const entities = Array.isArray(mapping(value.entity_target).entities) ? (mapping(value.entity_target).entities as unknown[]) : [];
  const entity = entities.map(mapping).find((candidate) => candidate.artifact === artifact && candidate.boundary === boundary);
  return mapping(entity?.retrieval);
}

/** Validate every runtime-consumed list-help field against the implemented grammar registry. */
export function validateEntityListHelp(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const target = requireMapping(value, "entity_target", "", errors);
  const retrieval = requireMapping(target, "public_retrieval", "entity_target", errors);
  if (value.retrieval !== undefined) errors.push("entity_target.public_retrieval.duplicate_active_map");
  const historical = mapping(value.historical_retrieval_evidence);
  if (Object.keys(historical).length > 0 && (historical.status !== "retired_historical_evidence" || historical.runtime_consumption !== "forbidden")) errors.push("historical_retrieval_evidence.runtime_consumption");
  for (const forbidden of ["commands", "identity"]) {
    if (historical[forbidden] !== undefined) errors.push(`historical_retrieval_evidence.${forbidden}`);
  }
  const commands = requireMapping(retrieval, "commands", "entity_target.public_retrieval", errors);
  const help = requireMapping(retrieval, "list_help", "entity_target.public_retrieval", errors);
  const policy = requireMapping(retrieval, "policy", "entity_target.public_retrieval", errors);
  exactKeys(policy, ["schema_version", "status", "authority_boundary", "envelope", "cursor", "omission", "output_bounds", "failures", "archive_policy"], [], "entity_target.public_retrieval.policy", errors);
  if (policy.schema_version !== "agentera.entityPublicRetrievalPolicy.v1") errors.push("entity_target.public_retrieval.policy.schema_version");
  if (policy.status !== "final") errors.push("entity_target.public_retrieval.policy.status");
  if (typeof policy.authority_boundary !== "string" || policy.authority_boundary.trim() === "") errors.push("entity_target.public_retrieval.policy.authority_boundary");
  const envelope = requireMapping(policy, "envelope", "entity_target.public_retrieval.policy", errors);
  const projection = requireMapping(envelope, "bounded_summary_projection", "entity_target.public_retrieval.policy.envelope", errors);
  if (!sameStrings(projection.minimum_fields, ["id", "artifact", "retrieval.get"])) errors.push("entity_target.public_retrieval.policy.envelope.bounded_summary_projection.minimum_fields");
  const familyMinimumFields = requireMapping(projection, "family_minimum_fields", "entity_target.public_retrieval.policy.envelope.bounded_summary_projection", errors);
  exactKeys(familyMinimumFields, ["todo"], [], "entity_target.public_retrieval.policy.envelope.bounded_summary_projection.family_minimum_fields", errors);
  if (!sameStrings(familyMinimumFields.todo, ["queue_rank"])) errors.push("entity_target.public_retrieval.policy.envelope.bounded_summary_projection.family_minimum_fields.todo");
  if (projection.cardinality_owner !== "summary_rows_after_filters_and_cursor") errors.push("entity_target.public_retrieval.policy.envelope.bounded_summary_projection.cardinality_owner");
  exactKeys(help, ["schema_version", "defaults", "families"], [], "entity_target.public_retrieval.list_help", errors);
  const defaults = requireMapping(help, "defaults", "entity_target.public_retrieval.list_help", errors);
  exactKeys(defaults, ["summary_fields", "selectors", "bounds", "formats"], [], "entity_target.public_retrieval.list_help.defaults", errors);
  const selectors = requireMapping(defaults, "selectors", "entity_target.public_retrieval.list_help.defaults", errors);
  exactKeys(selectors, ["ids_only", "fields", "mutual_exclusion"], [], "entity_target.public_retrieval.list_help.defaults.selectors", errors);
  const bounds = requireMapping(defaults, "bounds", "entity_target.public_retrieval.list_help.defaults", errors);
  exactKeys(bounds, ["minimum", "default", "maximum", "max_utf8_bytes"], [], "entity_target.public_retrieval.list_help.defaults.bounds", errors);
  const families = requireMapping(help, "families", "entity_target.public_retrieval.list_help", errors);

  if (help.schema_version !== ENTITY_LIST_HELP_SCHEMA_VERSION) errors.push("entity_target.public_retrieval.list_help.schema_version");
  if (!sameStrings(defaults.summary_fields, ["id", "artifact", "retrieval.get"])) errors.push("entity_target.public_retrieval.list_help.defaults.summary_fields");
  if (!sameStrings(defaults.formats, ENTITY_LIST_RUNTIME_FORMATS)) errors.push("entity_target.public_retrieval.list_help.defaults.formats");
  for (const [field, flag] of [
    ["ids_only", ENTITY_LIST_RUNTIME_SELECTORS.idsOnly],
    ["fields", ENTITY_LIST_RUNTIME_SELECTORS.fields],
  ] as const) {
    const selector = requireMapping(selectors, field, "entity_target.public_retrieval.list_help.defaults.selectors", errors);
    exactKeys(selector, ["flag", "description"], [], `entity_target.public_retrieval.list_help.defaults.selectors.${field}`, errors);
    if (selector.flag !== flag || typeof selector.description !== "string" || selector.description.trim() === "") errors.push(`entity_target.public_retrieval.list_help.defaults.selectors.${field}.value`);
  }
  if (selectors.mutual_exclusion !== true) errors.push("entity_target.public_retrieval.list_help.defaults.selectors.mutual_exclusion");
  for (const field of ["minimum", "default", "maximum", "max_utf8_bytes"]) if (positiveInteger(bounds[field]) === undefined) errors.push(`entity_target.public_retrieval.list_help.defaults.bounds.${field}.value`);
  if (Number(bounds.minimum) > Number(bounds.default) || Number(bounds.default) > Number(bounds.maximum)) errors.push("entity_target.public_retrieval.list_help.defaults.bounds.order");
  if (bounds.minimum !== ENTITY_LIST_RUNTIME_BOUNDS.minimum || bounds.default !== ENTITY_LIST_RUNTIME_BOUNDS.default || bounds.maximum !== ENTITY_LIST_RUNTIME_BOUNDS.maximum || bounds.max_utf8_bytes !== ENTITY_LIST_RUNTIME_BOUNDS.maxUtf8Bytes)
    errors.push("entity_target.public_retrieval.list_help.defaults.bounds.runtime_parity");

  const runtimeKeys = Object.keys(ENTITY_LIST_RUNTIME_REGISTRY).sort();
  for (const [surface, record] of [
    ["commands", commands],
    ["list_help.families", families],
  ] as const) {
    const actual = Object.keys(record).sort();
    for (const key of runtimeKeys) if (!actual.includes(key)) errors.push(`entity_target.public_retrieval.${surface}.missing.${key}`);
    for (const key of actual) if (!runtimeKeys.includes(key)) errors.push(`entity_target.public_retrieval.${surface}.unknown.${key}`);
  }

  const api = mapping(value.api);
  const apiList = mapping(api.list);
  const outputBounds = mapping(policy.output_bounds);
  if (!sameStrings(api.formats, ENTITY_LIST_RUNTIME_FORMATS)) errors.push("api.formats");
  if (bounds.minimum !== apiList.minimum_limit) errors.push("entity_target.public_retrieval.list_help.defaults.bounds.minimum_authority_parity");
  if (bounds.default !== apiList.default_limit) errors.push("entity_target.public_retrieval.list_help.defaults.bounds.default_authority_parity");
  if (bounds.maximum !== apiList.maximum_limit) errors.push("entity_target.public_retrieval.list_help.defaults.bounds.maximum_authority_parity");
  if (bounds.maximum !== outputBounds.maximum_limit) errors.push("entity_target.public_retrieval.list_help.defaults.bounds.maximum_policy_parity");
  if (bounds.max_utf8_bytes !== outputBounds.max_serialized_utf8_bytes) errors.push("entity_target.public_retrieval.list_help.defaults.bounds.bytes_authority_parity");

  const acceptedIdentity = identityPattern(value);

  for (const runtime of ENTITY_LIST_RUNTIME_FAMILIES) {
    const key = runtime.key as EntityListRuntimeFamilyKey;
    const prefix = `entity_target.public_retrieval.list_help.families.${key}`;
    const family = mapping(families[key]);
    const command = mapping(commands[key]);
    exactKeys(command, ["list", "get"], [], `entity_target.public_retrieval.commands.${key}`, errors);
    exactKeys(family, ["command_tokens", "bare_read", "filters", "example"], ["bare_recovery", "family_identifier", "summary_fields", "summary_field_notes"], prefix, errors);
    if (family.bare_read !== "alias" && family.bare_read !== "correction") errors.push(`${prefix}.bare_read`);
    if (family.bare_read !== runtime.bareRead) errors.push(`${prefix}.bare_read.runtime_parity`);
    if (family.bare_read === "correction" && family.bare_recovery !== runtime.projection.bareRecovery) errors.push(`${prefix}.bare_recovery`);
    if (family.bare_read === "alias" && family.bare_recovery !== undefined) errors.push(`${prefix}.bare_recovery.unexpected`);
    if (!sameStrings(family.command_tokens, runtime.commandTokens)) errors.push(`${prefix}.command_tokens`);
    if (!Array.isArray(family.filters)) errors.push(`${prefix}.filters`);
    const rawFilters = Array.isArray(family.filters) ? family.filters : [];
    const filterNames = rawFilters.map((raw) => mapping(raw).name);
    if (
      !sameStrings(
        filterNames,
        runtime.filters.map(({ name }) => name),
      )
    )
      errors.push(`${prefix}.filters.runtime_parity`);
    const parsedFilters: EntityListFilterHelp[] = [];
    rawFilters.forEach((raw, index) => {
      const filter = mapping(raw);
      exactKeys(filter, ["flag", "name", "values"], [], `${prefix}.filters[${index}]`, errors);
      const name = String(filter.name);
      const parsedFlag = typeof filter.flag === "string" ? valueFlag(filter.flag) : undefined;
      const declaredValues = strings(filter.values);
      if (!parsedFlag || parsedFlag.flag !== `--${name}`) errors.push(`${prefix}.filters[${index}].flag`);
      if (filter.values === "free_text") {
        if (!parsedFlag || !/^[A-Z][A-Z0-9_]*$/.test(parsedFlag.valueSyntax)) errors.push(`${prefix}.filters[${index}].flag_value_syntax`);
      } else {
        if (declaredValues.length === 0 || declaredValues.length !== new Set(declaredValues).size || declaredValues.some((value) => value.length === 0 || value.includes(" "))) errors.push(`${prefix}.filters[${index}].values`);
        if (!parsedFlag || parsedFlag.valueSyntax !== declaredValues.join("|")) errors.push(`${prefix}.filters[${index}].flag_value_syntax`);
      }
      const codeFilter = runtime.filters[index];
      if (!codeFilter || codeFilter.name !== name || codeFilter.flag !== filter.flag || JSON.stringify(codeFilter.values) !== JSON.stringify(filter.values)) errors.push(`${prefix}.filters[${index}].runtime_parity`);
      parsedFilters.push({
        flag: String(filter.flag),
        name,
        values: Array.isArray(filter.values) ? strings(filter.values) : String(filter.values),
      });
    });

    const identifier = family.family_identifier === undefined ? undefined : mapping(family.family_identifier);
    if (runtime.familyIdentifier) {
      if (!identifier) errors.push(`${prefix}.family_identifier`);
      else {
        exactKeys(identifier, ["syntax", "required", "description"], [], `${prefix}.family_identifier`, errors);
        if (identifier.syntax !== runtime.familyIdentifier.syntax || identifier.required !== runtime.familyIdentifier.required || typeof identifier.description !== "string" || identifier.description.trim() === "") errors.push(`${prefix}.family_identifier.value`);
      }
    } else if (identifier) errors.push(`${prefix}.family_identifier.unexpected`);

    const summaryFields = family.summary_fields === undefined ? strings(defaults.summary_fields) : strings(family.summary_fields);
    if (!sameStrings(summaryFields, runtime.summaryFields)) errors.push(`${prefix}.summary_fields`);
    if (key === "todo" && family.summary_fields === undefined) errors.push(`${prefix}.summary_fields.required`);
    const notes = family.summary_field_notes === undefined ? {} : mapping(family.summary_field_notes);
    if (family.summary_field_notes !== undefined && !isMapping(family.summary_field_notes)) errors.push(`${prefix}.summary_field_notes.type`);
    if (key === "todo") {
      if (!isMapping(family.summary_field_notes)) errors.push(`${prefix}.summary_field_notes.required`);
      const ownership = {
        public_order: "markdown_read_projection",
        readiness: "agentera_operational_projection",
        actionability: "computed_read_snapshot",
        queue_rank: "computed_read_snapshot",
        reconciliation: "computed_read_snapshot",
      } as const;
      exactKeys(notes, Object.keys(ownership), [], `${prefix}.summary_field_notes`, errors);
      for (const [field, owner] of Object.entries(ownership)) {
        const note = requireMapping(notes, field, `${prefix}.summary_field_notes`, errors);
        exactKeys(note, ["description", "ownership", "persisted", "filter"], [], `${prefix}.summary_field_notes.${field}`, errors);
        if (typeof note.description !== "string" || note.description.trim() === "" || note.ownership !== owner || note.persisted !== false || note.filter !== false) errors.push(`${prefix}.summary_field_notes.${field}.semantics`);
      }
    } else if (Object.keys(notes).length > 0) errors.push(`${prefix}.summary_field_notes.unexpected`);
    const minimumFields = [...strings(projection.minimum_fields), ...strings(familyMinimumFields[key])];
    if (minimumFields.some((field) => !summaryFields.includes(field))) errors.push(`${prefix}.minimum_fields`);

    const projected: EntityListFamilyHelp = {
      key,
      commandTokens: strings(family.command_tokens),
      syntax: String(command.list),
      get: String(command.get),
      bareRead: family.bare_read === "alias" ? "alias" : "correction",
      ...(typeof family.bare_recovery === "string" ? { bareRecovery: family.bare_recovery } : {}),
      filters: parsedFilters,
      ...(identifier
        ? {
            familyIdentifier: {
              syntax: String(identifier.syntax),
              required: identifier.required === true,
              description: String(identifier.description),
            },
          }
        : {}),
      summaryFields,
      minimumFields,
      summaryFieldNotes: {},
      selectors: {
        idsOnly: {
          flag: String(mapping(selectors.ids_only).flag),
          description: String(mapping(selectors.ids_only).description),
        },
        fields: {
          flag: String(mapping(selectors.fields).flag),
          description: String(mapping(selectors.fields).description),
        },
        mutualExclusion: selectors.mutual_exclusion === true,
      },
      bounds: {
        minimum: Number(bounds.minimum),
        default: Number(bounds.default),
        maximum: Number(bounds.maximum),
        maxUtf8Bytes: Number(bounds.max_utf8_bytes),
      },
      formats: strings(defaults.formats),
      example: String(family.example),
    };
    if (command.list !== runtime.projection.list) errors.push(`${prefix}.list_command`);
    if (command.get !== runtime.projection.get) errors.push(`${prefix}.get_command`);
    if (family.example !== runtime.projection.example) errors.push(`${prefix}.example.runtime_parity`);
    const exampleIssue = exampleGrammarIssue(family.example, projected, acceptedIdentity);
    if (exampleIssue) errors.push(`${prefix}.example.${exampleIssue}`);

    const entity = entityRetrieval(value, runtime.artifact, runtime.boundsBoundary ?? runtime.boundary);
    if (Object.keys(entity).length === 0) errors.push(`${prefix}.entity_retrieval`);
    if (entity.default_limit !== bounds.default) errors.push(`${prefix}.bounds.default_entity_parity`);
    if (entity.maximum_limit !== bounds.maximum) errors.push(`${prefix}.bounds.maximum_entity_parity`);
    if (entity.max_utf8_bytes !== bounds.max_utf8_bytes) errors.push(`${prefix}.bounds.bytes_entity_parity`);
  }
  return errors;
}

export function entityListFamilies(sourceRoot = resolveSourceRoot()): EntityListFamilyHelp[] {
  const authority = loadStateStorageAuthority(sourceRoot);
  if (cache?.revision === authority.revision) return cache.families;
  const errors = validateEntityListHelp(authority.document);
  if (errors.length > 0) throw new Error(`invalid entity list help authority: ${errors.join(", ")}`);
  const retrieval = mapping(mapping(authority.document.entity_target).public_retrieval);
  const commands = mapping(retrieval.commands);
  const help = mapping(retrieval.list_help);
  const defaults = mapping(help.defaults);
  const defaultSelectors = mapping(defaults.selectors);
  const defaultBounds = mapping(defaults.bounds);
  const policy = mapping(retrieval.policy);
  const projection = mapping(mapping(policy.envelope).bounded_summary_projection);
  const familyMinimumFields = mapping(projection.family_minimum_fields);
  const familyRecords = mapping(help.families);
  const families = ENTITY_LIST_RUNTIME_FAMILIES.map((runtime) => {
    const key = runtime.key as EntityListRuntimeFamilyKey;
    const family = mapping(familyRecords[key]);
    const command = mapping(commands[key]);
    const identifier = family.family_identifier === undefined ? undefined : mapping(family.family_identifier);
    const notes = Object.fromEntries(
      Object.entries(mapping(family.summary_field_notes)).map(([name, raw]) => {
        const note = mapping(raw);
        return [
          name,
          {
            description: String(note.description),
            ownership: String(note.ownership),
            persisted: note.persisted === true,
            filter: note.filter === true,
          },
        ];
      }),
    );
    const sourceHelp = {
      key,
      commandTokens: strings(family.command_tokens),
      syntax: String(command.list),
      get: String(command.get),
      bareRead: family.bare_read === "alias" ? ("alias" as const) : ("correction" as const),
      filters: (family.filters as unknown[]).map((raw) => {
        const filter = mapping(raw);
        return {
          flag: String(filter.flag),
          name: String(filter.name),
          values: Array.isArray(filter.values) ? strings(filter.values) : String(filter.values),
        };
      }),
      ...(identifier
        ? {
            familyIdentifier: {
              syntax: String(identifier.syntax),
              required: identifier.required === true,
              description: String(identifier.description),
            },
          }
        : {}),
      summaryFields: family.summary_fields === undefined ? strings(defaults.summary_fields) : strings(family.summary_fields),
      minimumFields: [...strings(projection.minimum_fields), ...strings(familyMinimumFields[key])],
      summaryFieldNotes: notes,
      selectors: {
        idsOnly: {
          flag: String(mapping(defaultSelectors.ids_only).flag),
          description: String(mapping(defaultSelectors.ids_only).description),
        },
        fields: {
          flag: String(mapping(defaultSelectors.fields).flag),
          description: String(mapping(defaultSelectors.fields).description),
        },
        mutualExclusion: defaultSelectors.mutual_exclusion === true,
      },
      bounds: {
        minimum: Number(defaultBounds.minimum),
        default: Number(defaultBounds.default),
        maximum: Number(defaultBounds.maximum),
        maxUtf8Bytes: Number(defaultBounds.max_utf8_bytes),
      },
      formats: strings(defaults.formats),
      example: String(family.example),
    } satisfies EntityListFamilyHelp;
    return {
      key,
      commandTokens: sourceHelp.commandTokens,
      syntax: projectEntityDevelopmentValue(command.list, key, "list"),
      get: projectEntityDevelopmentValue(command.get, key, "get"),
      bareRead: sourceHelp.bareRead,
      ...(typeof family.bare_recovery === "string" ? { bareRecovery: projectEntityDevelopmentValue(family.bare_recovery, key, "bareRecovery") } : {}),
      filters: sourceHelp.filters,
      ...(identifier
        ? {
            familyIdentifier: {
              syntax: String(identifier.syntax),
              required: identifier.required === true,
              description: String(identifier.description),
            },
          }
        : {}),
      summaryFields: family.summary_fields === undefined ? strings(defaults.summary_fields) : strings(family.summary_fields),
      minimumFields: [...strings(projection.minimum_fields), ...strings(familyMinimumFields[key])],
      summaryFieldNotes: notes,
      selectors: {
        idsOnly: {
          flag: String(mapping(defaultSelectors.ids_only).flag),
          description: String(mapping(defaultSelectors.ids_only).description),
        },
        fields: {
          flag: String(mapping(defaultSelectors.fields).flag),
          description: String(mapping(defaultSelectors.fields).description),
        },
        mutualExclusion: defaultSelectors.mutual_exclusion === true,
      },
      bounds: {
        minimum: Number(defaultBounds.minimum),
        default: Number(defaultBounds.default),
        maximum: Number(defaultBounds.maximum),
        maxUtf8Bytes: Number(defaultBounds.max_utf8_bytes),
      },
      formats: strings(defaults.formats),
      example: projectEntityDevelopmentValue(family.example, key, "example"),
    } satisfies EntityListFamilyHelp;
  });
  cache = { revision: authority.revision, families };
  return families;
}

export function entityListFamily(key: EntityListRuntimeFamilyKey, sourceRoot = resolveSourceRoot()): EntityListFamilyHelp {
  return entityListFamilies(sourceRoot).find((candidate) => candidate.key === key)!;
}

export function entityListFamilyForHelpArgs(args: string[], sourceRoot = resolveSourceRoot()): EntityListFamilyHelp | undefined {
  const runtime = runtimeEntityListFamilyForHelpArgs(args);
  return runtime ? entityListFamily(runtime.key as EntityListRuntimeFamilyKey, sourceRoot) : undefined;
}

export function entityRetrievalFamilyForHelpArgs(args: string[], sourceRoot = resolveSourceRoot()): { family: EntityListFamilyHelp; verb: "list" | "get" } | undefined {
  const runtime = runtimeEntityFamilyForHelpArgs(args);
  return runtime
    ? {
        family: entityListFamily(runtime.family.key as EntityListRuntimeFamilyKey, sourceRoot),
        verb: runtime.verb,
      }
    : undefined;
}

export function entityListValidValues(family: EntityListFamilyHelp): string[] {
  return [...(family.familyIdentifier ? [family.familyIdentifier.syntax] : []), ...family.filters.map(({ flag }) => flag), `--limit ${family.bounds.minimum}..${family.bounds.maximum}`, "--cursor TOKEN", family.selectors.idsOnly.flag, family.selectors.fields.flag, `--format ${family.formats.join("|")}`];
}

export function entityListAuthorityProjection(sourceRoot = resolveSourceRoot()): JsonObject {
  entityListFamilies(sourceRoot);
  return mapping(mapping(loadStateStorageAuthority(sourceRoot).document.entity_target).public_retrieval) as JsonObject;
}
