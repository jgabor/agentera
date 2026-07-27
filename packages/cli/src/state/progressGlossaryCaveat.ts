import type { JsonObject } from "../core/jsonValue.js";
import {
  glossaryCaveatContract,
  type GlossaryCaveatContract,
} from "../registries/glossaryCaveatContract.js";

export interface GlossaryCaveatEnvelope extends JsonObject {
  caveat_id: string;
  event: "current" | "resolved" | "superseded";
  capability: string;
  reason: string;
  ownership_state: string;
  transition_id: string | null;
}

export type GlossaryCaveatValidation =
  | { status: "absent"; caveat: null; violations: [] }
  | { status: "valid"; caveat: GlossaryCaveatEnvelope; violations: [] }
  | { status: "invalid"; caveat: null; violations: string[] };

interface CaveatEntity {
  record: JsonObject | null;
  classification: string;
}

interface CaveatDiscoveredEntity extends CaveatEntity {
  id: string | null;
  artifact: string | null;
  boundary: string | null;
  relativePath: string;
}

interface CaveatDiagnostic {
  code: "malformed_entity";
  path: string;
  message: string;
  recovery: string;
  id?: string;
  artifact?: string;
  boundary?: string;
}

interface CaveatDiagnosticSink {
  push(issue: CaveatDiagnostic): unknown;
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, contract: GlossaryCaveatContract): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= contract.maxStringUtf8Bytes
  );
}

export function validateProgressGlossaryCaveat(
  record: JsonObject,
  contract: GlossaryCaveatContract = glossaryCaveatContract(),
): GlossaryCaveatValidation {
  if (!Object.prototype.hasOwnProperty.call(record, "glossary_caveat")) {
    return { status: "absent", caveat: null, violations: [] };
  }
  const value = record.glossary_caveat;
  const violations: string[] = [];
  if (!mapping(value)) {
    return {
      status: "invalid",
      caveat: null,
      violations: ["glossary_caveat must be one privacy-safe mapping"],
    };
  }
  const keys = Object.keys(value);
  if (
    keys.length !== contract.fields.length ||
    keys.some((field) => !contract.fields.includes(field))
  ) {
    violations.push("glossary_caveat must contain exactly the authority-declared fields");
  }
  if (contract.fields.some((field) => !(field in value))) {
    violations.push("glossary_caveat requires every authority-declared field");
  }
  for (const field of ["caveat_id", "event", "capability", "reason", "ownership_state"])
    if (!boundedString(value[field], contract))
      violations.push("glossary_caveat string fields must be non-empty and bounded");
  if (!contract.idPattern.test(typeof value.caveat_id === "string" ? value.caveat_id : ""))
    violations.push("glossary_caveat caveat_id must be one opaque ID");
  if (!contract.events.includes(typeof value.event === "string" ? value.event : ""))
    violations.push("glossary_caveat event is outside the bounded vocabulary");
  if (!contract.capabilities.includes(typeof value.capability === "string" ? value.capability : ""))
    violations.push("glossary_caveat capability is outside the bounded vocabulary");
  if (!contract.reasons.includes(typeof value.reason === "string" ? value.reason : ""))
    violations.push("glossary_caveat reason is outside the bounded vocabulary");
  if (
    !contract.ownershipStates.includes(
      typeof value.ownership_state === "string" ? value.ownership_state : "",
    )
  )
    violations.push("glossary_caveat ownership_state is outside the bounded vocabulary");
  const transition = value.transition_id;
  if (!(transition === null || boundedString(transition, contract)))
    violations.push("glossary_caveat transition_id must be null or one bounded opaque ID");
  if (typeof transition === "string" && !contract.idPattern.test(transition))
    violations.push("glossary_caveat transition_id must be one opaque ID");
  if ((value.event === "current" || value.event === "resolved") && transition !== null)
    violations.push("current and resolved glossary_caveat events require null transition_id");
  if (
    value.event === "superseded" &&
    (typeof transition !== "string" || transition === value.caveat_id)
  )
    violations.push("superseded glossary_caveat requires one different successor ID");
  if (violations.length) return { status: "invalid", caveat: null, violations: [...new Set(violations)] };
  return { status: "valid", caveat: value as GlossaryCaveatEnvelope, violations: [] };
}

export function glossaryCaveatLifecycleInvalidEntities<T extends CaveatEntity>(
  entities: T[],
  contract: GlossaryCaveatContract = glossaryCaveatContract(),
): Set<T> {
  const rows = entities.flatMap((entity) => {
    if (entity.classification !== "valid" || !entity.record) return [];
    const result = validateProgressGlossaryCaveat(entity.record, contract);
    return result.status === "valid" ? [{ entity, caveat: result.caveat }] : [];
  });
  const invalid = new Set<T>();
  const byId = new Map<string, typeof rows>();
  for (const row of rows)
    byId.set(row.caveat.caveat_id, [...(byId.get(row.caveat.caveat_id) ?? []), row]);
  const transitions = new Map<string, string>();
  for (const [id, matches] of byId) {
    const current = matches.filter(({ caveat }) => caveat.event === "current");
    const terminal = matches.filter(({ caveat }) => caveat.event !== "current");
    if (current.length !== 1 || terminal.length > 1) matches.forEach(({ entity }) => invalid.add(entity));
    if (terminal.length && current.length === 1) {
      const base = current[0]!.caveat;
      for (const row of terminal) {
        if (
          row.caveat.capability !== base.capability ||
          row.caveat.reason !== base.reason ||
          row.caveat.ownership_state !== base.ownership_state
        ) {
          invalid.add(row.entity);
          invalid.add(current[0]!.entity);
        }
        if (row.caveat.event === "superseded") {
          const target = byId.get(row.caveat.transition_id as string) ?? [];
          if (target.filter(({ caveat }) => caveat.event === "current").length !== 1) {
            invalid.add(row.entity);
          } else transitions.set(id, row.caveat.transition_id as string);
        }
      }
    }
  }
  for (const start of transitions.keys()) {
    const seen = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = transitions.get(cursor);
    }
    if (cursor) for (const id of seen) (byId.get(id) ?? []).forEach(({ entity }) => invalid.add(entity));
  }
  return invalid;
}

export function applyGlossaryCaveatLifecycleValidation<T extends CaveatDiscoveredEntity>(
  projectRoot: string,
  entities: T[],
  issues: CaveatDiagnosticSink,
  contract: GlossaryCaveatContract,
): void {
  for (const entity of glossaryCaveatLifecycleInvalidEntities(
    entities.filter((candidate) => candidate.boundary === "progress_cycle"),
    contract,
  )) {
    entity.classification = "malformed";
    issues.push({
      code: "malformed_entity",
      path: entity.relativePath,
      id: entity.id ?? undefined,
      artifact: entity.artifact ?? undefined,
      boundary: entity.boundary ?? undefined,
      message: `entity '${entity.relativePath}' has an invalid glossary caveat lifecycle relation`,
      recovery: `repair '${entity.relativePath}' using the Build-owned progress glossary caveat lifecycle; rerun agentera check validate state --cwd ${JSON.stringify(projectRoot)}`,
    });
  }
}
