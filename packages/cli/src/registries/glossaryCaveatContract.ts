import { loadYamlMappingFile } from "../core/yaml.js";
import { glossaryEntryAuthorityPath } from "./glossaryEntryContract.js";

type Mapping = Record<string, unknown>;

export interface GlossaryCaveatContract {
  fields: string[];
  currentAppendCallerFields: string[];
  currentAppendCallerFixedValues: Record<string, string>;
  currentAppendWriterFields: string[];
  currentAppendWriterFixedValues: Record<string, string | null>;
  events: string[];
  capabilities: string[];
  reasons: string[];
  ownershipStates: string[];
  allowedCurrentPairs: Array<{ reason: string; ownershipState: string }>;
  idAlphabet: string;
  idLength: number;
  idPattern: RegExp;
  maxStringUtf8Bytes: number;
  primeAttentionText: string;
  primeSourceArtifact: string;
  primeSourceBoundary: string;
  primeSourceCapability: string;
  primePublicAttentionLimit: number;
  primeReservedGlossarySlots: number;
}

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function fixedValues(value: unknown): Record<string, string | null> {
  const source = mapping(value);
  if (!source) return {};
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string | null] =>
        typeof entry[1] === "string" || entry[1] === null,
    ),
  );
}

function allowedPairs(value: unknown): Array<{ reason: string; ownershipState: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const pair = mapping(candidate);
    return typeof pair?.reason === "string" && typeof pair.ownership_state === "string"
      ? [{ reason: pair.reason, ownershipState: pair.ownership_state }]
      : [];
  });
}

export function glossaryCaveatPairAllowed(
  contract: GlossaryCaveatContract,
  reason: string,
  ownershipState: string,
): boolean {
  return contract.allowedCurrentPairs.some(
    (pair) => pair.reason === reason && pair.ownershipState === ownershipState,
  );
}

export function glossaryCaveatContract(
  pathname: string = glossaryEntryAuthorityPath(),
): GlossaryCaveatContract {
  return glossaryCaveatContractFromDocument(loadYamlMappingFile(pathname));
}

export function glossaryCaveatContractFromDocument(
  authority: Record<string, unknown>,
): GlossaryCaveatContract {
  const caveat = mapping(mapping(authority.consumer_boundary)?.autonomous_caveat);
  const identity = mapping(caveat?.identity);
  const envelope = mapping(caveat?.envelope);
  const currentAppend = mapping(envelope?.current_append);
  const primeProjection = mapping(caveat?.prime_projection);
  const primeSource = mapping(primeProjection?.source);
  const primeCapacity = mapping(primeProjection?.capacity);
  return {
    fields: strings(envelope?.fields),
    currentAppendCallerFields: strings(currentAppend?.caller_fields),
    currentAppendCallerFixedValues: Object.fromEntries(
      Object.entries(fixedValues(currentAppend?.caller_fixed_values)).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    currentAppendWriterFields: strings(currentAppend?.writer_fields),
    currentAppendWriterFixedValues: fixedValues(currentAppend?.writer_fixed_values),
    events: strings(envelope?.events),
    capabilities: strings(envelope?.capabilities),
    reasons: strings(envelope?.reasons),
    ownershipStates: strings(envelope?.ownership_states),
    allowedCurrentPairs: allowedPairs(caveat?.allowed_current_pairs),
    idAlphabet: typeof identity?.alphabet === "string" ? identity.alphabet : "",
    idLength: typeof identity?.length === "number" ? identity.length : 0,
    idPattern: new RegExp(typeof identity?.pattern === "string" ? identity.pattern : "a^"),
    maxStringUtf8Bytes:
      typeof envelope?.max_string_utf8_bytes === "number" ? envelope.max_string_utf8_bytes : 0,
    primeAttentionText:
      typeof primeProjection?.attention_text === "string" ? primeProjection.attention_text : "",
    primeSourceArtifact: typeof primeSource?.artifact === "string" ? primeSource.artifact : "",
    primeSourceBoundary: typeof primeSource?.boundary === "string" ? primeSource.boundary : "",
    primeSourceCapability: typeof primeSource?.capability === "string" ? primeSource.capability : "",
    primePublicAttentionLimit:
      typeof primeCapacity?.public_attention_limit === "number"
        ? primeCapacity.public_attention_limit
        : 0,
    primeReservedGlossarySlots:
      typeof primeCapacity?.reserved_glossary_slots === "number"
        ? primeCapacity.reserved_glossary_slots
        : 0,
  };
}
