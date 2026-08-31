import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { JsonObject } from "../core/jsonValue.js";
import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { assertRealpathBoundary } from "../registries/artifactRegistry.js";
import {
  decisionOverlayContract,
  type DecisionOverlayContract,
} from "./archiveDiscovery.js";
import type { StateMutationTransaction } from "./write/mutation.js";
import { reject } from "./write/errors.js";

export type DecisionOverlayDocument = Record<string, JsonObject>;

export interface DecisionOverlayUpdate {
  path: string;
  satisfaction: JsonObject;
  replay: boolean;
  before: DecisionOverlayDocument;
  after: DecisionOverlayDocument;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mapping(value: unknown): Record<string, unknown> {
  return isMapping(value) ? value : {};
}

function valueAt(value: unknown, field: string): unknown {
  let current = value;
  for (const part of field.split(".")) {
    if (!isMapping(current)) return undefined;
    current = current[part];
  }
  return current;
}

function setAt(target: Record<string, unknown>, field: string, value: unknown): void {
  const parts = field.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!isMapping(next)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1) as string] = structuredClone(value);
}

function pathAllowed(field: string, contract: DecisionOverlayContract): boolean {
  return contract.mutablePaths.some(
    (mutable) => mutable === field || mutable.startsWith(`${field}.`),
  );
}

function validateValueTypes(
  field: string,
  value: unknown,
  contract: DecisionOverlayContract,
  violations: string[],
): void {
  if (field.endsWith(".state")) {
    if (typeof value !== "string" || !contract.stateValues.includes(value)) {
      violations.push(`${field} must be one of: ${contract.stateValues.join(", ")}`);
    }
    return;
  }
  if (field.endsWith(".evidence") || field.endsWith(".confirmed_by") || field.endsWith(".confirmed_at")) {
    if (typeof value !== "string") violations.push(`${field} must be a string`);
  }
}

function validateOverlayValue(
  value: unknown,
  contract: DecisionOverlayContract,
  prefix = "",
  violations: string[] = [],
): string[] {
  if (!isMapping(value)) {
    violations.push(`${prefix || "overlay entry"} must be a mapping`);
    return violations;
  }
  for (const [key, child] of Object.entries(value)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (!pathAllowed(field, contract)) {
      violations.push(`${field} is not an authority-declared mutable overlay field`);
      continue;
    }
    if (isMapping(child)) validateOverlayValue(child, contract, field, violations);
    else validateValueTypes(field, child, contract, violations);
  }
  return violations;
}

function decisionNumberFromId(id: string, contract: DecisionOverlayContract): number | null {
  const prefix = `${contract.identityPrefix}:`;
  if (!id.startsWith(prefix)) return null;
  const number = id.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(number)) return null;
  const parsed = Number(number);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function decisionOverlayPath(
  projectRoot: string,
  sourceRoot: string = resolveSourceRoot(),
): string {
  const contract = decisionOverlayContract(sourceRoot);
  const target = path.resolve(projectRoot, contract.location);
  assertRealpathBoundary(projectRoot, target, "decision overlay");
  return target;
}

export function decisionOverlayViolations(
  document: unknown,
  contract: DecisionOverlayContract = decisionOverlayContract(),
): string[] {
  if (!isMapping(document)) return ["decision overlay root must be a mapping keyed by stable decision ID"];
  const violations: string[] = [];
  for (const [stableId, value] of Object.entries(document)) {
    if (decisionNumberFromId(stableId, contract) === null) {
      violations.push(`${stableId} is not a valid ${contract.identityKey} key`);
      continue;
    }
    validateOverlayValue(value, contract, "", violations);
  }
  return violations;
}

function readOverlayDocument(
  projectRoot: string,
  sourceRoot: string = resolveSourceRoot(),
): { path: string; document: DecisionOverlayDocument; contract: DecisionOverlayContract } {
  const contract = decisionOverlayContract(sourceRoot);
  const target = decisionOverlayPath(projectRoot, sourceRoot);
  if (!fs.existsSync(target)) return { path: target, document: {}, contract };
  const bytes = fs.readFileSync(target, "utf8");
  let document: Record<string, unknown>;
  try {
    document = loadYamlMapping(bytes);
  } catch (error) {
    throw new Error(`cannot parse decision overlay '${target}': ${(error as Error).message}`);
  }
  const violations = decisionOverlayViolations(document, contract);
  if (violations.length > 0)
    throw new Error(`decision overlay '${target}' is invalid: ${violations.join("; ")}`);
  return { path: target, document: document as DecisionOverlayDocument, contract };
}

export function loadDecisionOverlay(
  projectRoot: string = process.cwd(),
  sourceRoot: string = resolveSourceRoot(),
): DecisionOverlayDocument {
  return readOverlayDocument(projectRoot, sourceRoot).document;
}

export function hydrateDecisionRecords(
  entries: JsonObject[],
  source: string | DecisionOverlayDocument = process.cwd(),
): JsonObject[] {
  const overlay = typeof source === "string" ? loadDecisionOverlay(source) : source;
  const contract = decisionOverlayContract();
  return entries.map((entry) => {
    const number = entry.number;
    const stableId =
      typeof number === "number" || typeof number === "string" ? `decisions:${number}` : null;
    return composeDecisionOverlay(entry, stableId ? overlay[stableId] : undefined, contract);
  });
}

export function composeDecisionOverlay(
  entry: JsonObject,
  overlay: JsonObject | undefined,
  contract: DecisionOverlayContract = decisionOverlayContract(),
): JsonObject {
  if (!overlay) return structuredClone(entry);
  const hydrated = structuredClone(entry);
  const historicalSatisfaction = mapping(hydrated.satisfaction);
  const overlaySatisfaction = mapping(overlay.satisfaction);
  const composedSatisfaction: Record<string, unknown> = { ...historicalSatisfaction };
  for (const field of contract.mutablePaths) {
    const relative = field.startsWith("satisfaction.") ? field.slice("satisfaction.".length) : field;
    const value = valueAt(overlaySatisfaction, relative);
    if (value !== undefined) setAt(composedSatisfaction, relative, value);
  }
  hydrated.satisfaction = composedSatisfaction as unknown as JsonObject;
  return hydrated;
}

export function requestedSatisfaction(
  requested: unknown,
  contract: DecisionOverlayContract,
): JsonObject {
  const violations = validateOverlayValue({ satisfaction: requested }, contract);
  if (violations.length > 0) {
    reject({
      class: "schema_violation",
      message: "decision satisfaction update contains invalid overlay fields",
      violations,
      syntax: "agentera state decisions update --id ID --satisfaction-state STATE",
      example:
        "agentera state decisions update --id qjtrmnpvka --satisfaction-state provisionally_satisfied --satisfaction-evidence 'verified'",
    });
  }
  const result: Record<string, unknown> = {};
  for (const field of contract.mutablePaths) {
    const relative = field.startsWith("satisfaction.") ? field.slice("satisfaction.".length) : field;
    const value = valueAt(requested, relative);
    if (value !== undefined) setAt(result, relative, value);
  }
  return result as unknown as JsonObject;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function statePath(contract: DecisionOverlayContract): string {
  return contract.mutablePaths.find((field) => field.endsWith(".state"))?.slice("satisfaction.".length) ?? "state";
}

function evidencePath(contract: DecisionOverlayContract): string {
  return contract.mutablePaths.find((field) => field.endsWith(".evidence"))?.slice("satisfaction.".length) ?? "evidence";
}

function confirmationPaths(contract: DecisionOverlayContract): string[] {
  return contract.mutablePaths
    .filter((field) => field.includes("user_confirmation."))
    .map((field) => field.slice("satisfaction.".length));
}

function effectiveState(
  overlay: JsonObject | undefined,
  historicalSatisfaction: unknown,
): unknown {
  return valueAt(overlay?.satisfaction, "state") ?? valueAt(historicalSatisfaction, "state");
}

export function validateTransition(
  requested: JsonObject,
  currentOverlay: JsonObject | undefined,
  historicalSatisfaction: unknown,
  contract: DecisionOverlayContract,
): void {
  const nextState = valueAt(requested, statePath(contract));
  const evidence = valueAt(requested, evidencePath(contract));
  const confirmation = mapping(requested.user_confirmation);
  if (nextState === "provisionally_satisfied" && !nonEmptyString(evidence)) {
    reject({
      class: "schema_violation",
      message: "provisionally_satisfied requires non-empty --satisfaction-evidence",
      syntax: "agentera state decisions update --id ID --satisfaction-state STATE --satisfaction-evidence TEXT",
      example:
        "agentera state decisions update --id qjtrmnpvka --satisfaction-state provisionally_satisfied --satisfaction-evidence 'verified'",
    });
  }
  if (nextState === "user_confirmed_satisfied") {
    const paths = confirmationPaths(contract);
    if (paths.some((field) => !nonEmptyString(valueAt(confirmation, field.split(".").at(-1) as string)))) {
      reject({
        class: "schema_violation",
        message: "user_confirmed_satisfied requires explicit current user confirmation metadata",
        syntax: "agentera state decisions update --id ID --satisfaction-state user_confirmed_satisfied --confirmed-by USER --confirmed-at TIME",
        example:
          "agentera state decisions update --id qjtrmnpvka --satisfaction-state user_confirmed_satisfied --confirmed-by user --confirmed-at 2026-07-13T12:00:00Z",
      });
    }
  }
  const currentState = effectiveState(currentOverlay, historicalSatisfaction);
  if (typeof currentState === "string" && contract.stateValues.includes(currentState)) {
    if (!contract.allowedNext[currentState]?.includes(String(nextState))) {
      const downgradeConfirmation = confirmationPaths(contract).every((field) =>
        nonEmptyString(valueAt(confirmation, field.split(".").at(-1) as string)),
      );
      if (!(currentState === "user_confirmed_satisfied" && downgradeConfirmation)) {
        reject({
          class: "conflict",
          message: `decision satisfaction cannot transition from ${currentState} to ${String(nextState)} without explicit current user confirmation`,
          syntax: "agentera state decisions update --id ID --satisfaction-state STATE",
          example:
            "agentera state decisions update --id qjtrmnpvka --satisfaction-state user_confirmed_satisfied --confirmed-by user --confirmed-at 2026-07-13T12:00:00Z",
        });
      }
    }
  }
}

export function updateDecisionOverlay(
  projectRoot: string,
  decisionNumber: number,
  requested: unknown,
  historicalSatisfaction: unknown,
  transaction: StateMutationTransaction,
  publish = true,
  sourceRoot: string = resolveSourceRoot(),
): DecisionOverlayUpdate {
  const current = readOverlayDocument(projectRoot, sourceRoot);
  const stableId = `${current.contract.identityPrefix}:${decisionNumber}`;
  const currentEntry = current.document[stableId];
  const satisfaction = requestedSatisfaction(requested, current.contract);
  validateTransition(satisfaction, currentEntry, historicalSatisfaction, current.contract);
  const nextDocument: DecisionOverlayDocument = structuredClone(current.document);
  const replay = Boolean(currentEntry && isDeepStrictEqual(currentEntry.satisfaction, satisfaction));
  if (!replay) nextDocument[stableId] = { satisfaction };
  if (!replay && publish) {
    const bytes = dumpYamlMapping(nextDocument);
    const violations = decisionOverlayViolations(nextDocument, current.contract);
    if (violations.length > 0) {
      reject({
        class: "schema_violation",
        message: "decision overlay publication failed validation",
        violations,
      });
    }
    const stage = transaction.stageProjection(current.path, bytes);
    try {
      transaction.syncStaged(stage);
      transaction.publishProjection(stage, current.path);
    } finally {
      transaction.removeStage(stage);
    }
  }
  return {
    path: current.path,
    satisfaction,
    replay,
    before: current.document,
    after: nextDocument,
  };
}
