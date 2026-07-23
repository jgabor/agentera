import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadCapabilitySchemaContract, type CapabilitySchemaContract } from "./capabilityContract.js";
import { loadTriggerModel, type TriggerModel } from "./triggerLoader.js";

export type Utf8Span = { start: number; end: number };

export type DeterministicRoute = {
  schemaVersion: "agentera.route_response.v1";
  outcome: "deterministic_selection";
  capability: string;
  tier: "bare" | "direct" | "phrase";
  recognized_span: Utf8Span;
  topic_span: Utf8Span;
  provenance: Record<string, string>;
};

export type SemanticRequiredRoute = {
  schemaVersion: "agentera.route_response.v1";
  outcome: "semantic_required";
  request_sha256: string;
  semantic_capsule: {
    contract_version: string;
    capabilities: Array<{
      capability: string;
      triggers: Array<{
        id: string;
        description: string;
        priority: "high" | "medium" | "low";
        disambiguates_against: Array<{ capability: string; hint: string }>;
      }>;
    }>;
  };
  provenance: Record<string, string>;
};

export type RouteResponse = DeterministicRoute | SemanticRequiredRoute;

type Phrase = { id: string; capability: string; phrase: string; status: string };

export class HybridRouteRegistryError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join("; "));
  }
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
}

function byteOffset(value: string, utf16Offset: number): number {
  return Buffer.byteLength(value.slice(0, utf16Offset), "utf8");
}

function sourceSeparatorOffset(value: string): number | undefined {
  let offset = 0;
  for (const character of value) {
    if ([":", "-", "—"].includes(character.normalize("NFKC"))) return offset;
    offset += character.length;
  }
  return undefined;
}

function sourcePath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

function readMapping(root: string, relativePath: string): Record<string, unknown> {
  try {
    return loadYamlMapping(fs.readFileSync(sourcePath(root, relativePath), "utf8"));
  } catch (error) {
    throw new HybridRouteRegistryError([`${relativePath} is not readable or valid: ${(error as Error).message}`]);
  }
}

function phrasesFrom(root: string, contract: CapabilitySchemaContract): Phrase[] {
  const raw = readMapping(root, "skills/agentera/route-phrases.yaml");
  const entries = raw.phrases;
  if (!Array.isArray(entries)) throw new HybridRouteRegistryError(["route phrase registry phrases must be a list"]);

  const capabilities = new Set(contract.routeAliases.primaryAliases.map(({ capability }) => capability));
  const errors: string[] = [];
  const seen = new Set<string>();
  const directNames = new Set([
    ...capabilities,
    ...contract.routeAliases.primaryAliases.map(({ alias }) => alias),
  ].map(normalized));
  const phrases: Phrase[] = [];
  for (const [index, value] of entries.entries()) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`phrases[${index}] must be a mapping`);
      continue;
    }
    const entry = value as Record<string, unknown>;
    const { id, capability, phrase, status } = entry;
    if (![id, capability, phrase, status].every((field) => typeof field === "string" && field)) {
      errors.push(`phrases[${index}] requires non-empty id, capability, phrase, and status`);
      continue;
    }
    const normalizedPhrase = normalized(phrase as string);
    if (!normalizedPhrase) {
      errors.push(`phrases[${index}] phrase must contain text`);
      continue;
    }
    if (seen.has(normalizedPhrase)) errors.push(`phrase collision: ${id}`);
    seen.add(normalizedPhrase);
    if (!capabilities.has(capability as string)) errors.push(`phrases[${index}] capability does not resolve`);
    if (directNames.has(normalizedPhrase) || directNames.has(normalizedPhrase.split(" ")[0])) {
      errors.push(`phrases[${index}] conflicts with direct-route grammar`);
    }
    phrases.push({ id: id as string, capability: capability as string, phrase: phrase as string, status: status as string });
  }
  if (errors.length > 0) throw new HybridRouteRegistryError(errors);
  return phrases;
}

function phraseMatch(request: string, phrase: Phrase): Utf8Span | undefined {
  const phraseTokens = normalized(phrase.phrase).split(" ");
  const sourceTokens = [...request.matchAll(/\S+/gu)];
  if (sourceTokens.length < phraseTokens.length) return undefined;

  for (let index = 0; index < phraseTokens.length - 1; index += 1) {
    if (normalized(sourceTokens[index][0]) !== phraseTokens[index]) return undefined;
  }
  const finalToken = sourceTokens[phraseTokens.length - 1];
  const separator = sourceSeparatorOffset(finalToken[0]);
  const finalEnd = separator ?? finalToken[0].length;
  if (normalized(finalToken[0].slice(0, finalEnd)) !== phraseTokens.at(-1)) return undefined;

  return {
    start: byteOffset(request, sourceTokens[0].index!),
    end: byteOffset(request, finalToken.index! + finalEnd),
  };
}

function deterministic(
  capability: string,
  tier: DeterministicRoute["tier"],
  recognizedSpan: Utf8Span,
  request: string,
  provenance: Record<string, string>,
): DeterministicRoute {
  return {
    schemaVersion: "agentera.route_response.v1",
    outcome: "deterministic_selection",
    capability,
    tier,
    recognized_span: recognizedSpan,
    topic_span: { start: recognizedSpan.end, end: Buffer.byteLength(request, "utf8") },
    provenance,
  };
}

function directRoute(request: string, contract: CapabilitySchemaContract): DeterministicRoute | undefined {
  const match = /^(\s*\/agentera)(?:\s+([^\s]+))?/u.exec(request);
  if (!match) return undefined;
  const prefixEnd = match[1].length;
  const name = match[2];
  if (!name) {
    if (request.slice(prefixEnd).trim()) return undefined;
    const start = request.search(/\S/u);
    return deterministic("status", "bare", { start: byteOffset(request, start), end: byteOffset(request, prefixEnd) }, request, { tier: "bare" });
  }
  const normalizedName = normalized(name);
  const alias = contract.routeAliases.primaryAliases.find(({ alias: value, capability }) =>
    normalized(value) === normalizedName || normalized(capability) === normalizedName,
  );
  if (!alias) return undefined;
  const nameStart = request.indexOf(name, prefixEnd);
  return deterministic(alias.capability, "direct", {
    start: byteOffset(request, request.search(/\S/u)),
    end: byteOffset(request, nameStart + name.length),
  }, request, { tier: "direct", route_alias: alias.alias });
}

function semanticCapsule(model: TriggerModel, contractVersion: string): SemanticRequiredRoute["semantic_capsule"] {
  return {
    contract_version: contractVersion,
    capabilities: [...model.capabilities.values()].map(({ capability, triggers }) => ({
      capability,
      triggers: triggers.map((trigger) => ({
        id: trigger.id,
        description: trigger.description,
        priority: trigger.priority,
        disambiguates_against: trigger.disambiguatesAgainst.map(({ capability: target, hint }) => ({ capability: target, hint })),
      })),
    })),
  };
}

/** Resolve only the contract's deterministic request phase; semantic selection remains host-owned. */
export function resolveRouteRequest(request: string, sourceRoot: string = resolveSourceRoot()): RouteResponse {
  if (typeof request !== "string") throw new TypeError("request must be a string");
  const contractRaw = readMapping(sourceRoot, "references/cli/hybrid-route-contract.yaml");
  const contractVersion = contractRaw.schema_version;
  if (typeof contractVersion !== "string" || !contractVersion) {
    throw new HybridRouteRegistryError(["hybrid route contract schema_version must be a non-empty string"]);
  }
  let capabilityContract: CapabilitySchemaContract;
  try {
    capabilityContract = loadCapabilitySchemaContract(sourcePath(sourceRoot, "skills/agentera/capability_schema_contract.yaml"));
  } catch (error) {
    throw new HybridRouteRegistryError([`capability route authority is invalid: ${(error as Error).message}`]);
  }
  const phrases = phrasesFrom(sourceRoot, capabilityContract);

  const direct = directRoute(request, capabilityContract);
  if (direct) return direct;

  for (const phrase of phrases) {
    if (phrase.status !== "active") continue;
    const recognizedSpan = phraseMatch(request, phrase);
    if (recognizedSpan) {
      return deterministic(phrase.capability, "phrase", recognizedSpan, request, {
        tier: "phrase",
        phrase_id: phrase.id,
      });
    }
  }

  let triggerModel: TriggerModel;
  try {
    triggerModel = loadTriggerModel(capabilityContract, { sourceRoot });
  } catch (error) {
    throw new HybridRouteRegistryError([`semantic intent authority is invalid: ${(error as Error).message}`]);
  }
  return {
    schemaVersion: "agentera.route_response.v1",
    outcome: "semantic_required",
    request_sha256: crypto.createHash("sha256").update(request, "utf8").digest("hex"),
    semantic_capsule: semanticCapsule(triggerModel, contractVersion),
    provenance: { tier: "deterministic_abstention", contract: contractVersion },
  };
}
