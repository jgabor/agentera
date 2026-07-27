import { loadYamlMappingFile } from "../core/yaml.js";
import { glossaryEntryAuthorityPath } from "./glossaryEntryContract.js";

type Mapping = Record<string, unknown>;

export interface GlossaryCaveatContract {
  fields: string[];
  events: string[];
  capabilities: string[];
  reasons: string[];
  ownershipStates: string[];
  idAlphabet: string;
  idLength: number;
  idPattern: RegExp;
  maxStringUtf8Bytes: number;
}

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

export function glossaryCaveatContract(
  pathname: string = glossaryEntryAuthorityPath(),
): GlossaryCaveatContract {
  const authority = loadYamlMappingFile(pathname) as Mapping;
  const caveat = mapping(mapping(authority.consumer_boundary)?.autonomous_caveat);
  const identity = mapping(caveat?.identity);
  const envelope = mapping(caveat?.envelope);
  return {
    fields: strings(envelope?.fields),
    events: strings(envelope?.events),
    capabilities: strings(envelope?.capabilities),
    reasons: strings(envelope?.reasons),
    ownershipStates: strings(envelope?.ownership_states),
    idAlphabet: typeof identity?.alphabet === "string" ? identity.alphabet : "",
    idLength: typeof identity?.length === "number" ? identity.length : 0,
    idPattern: new RegExp(typeof identity?.pattern === "string" ? identity.pattern : "a^"),
    maxStringUtf8Bytes:
      typeof envelope?.max_string_utf8_bytes === "number" ? envelope.max_string_utf8_bytes : 0,
  };
}
