import { projectGlossaryDevelopmentValue } from "../core/developmentInvocation.js";
import { loadYamlMappingFile } from "../core/yaml.js";
import { glossaryEntryAuthorityPath } from "./glossaryEntryContract.js";

type Mapping = Record<string, unknown>;

export interface GlossaryAdviceRow {
  name: string;
  match: Record<string, string[]>;
  selectedOwner: string;
  selectedMeaning: string;
  review: string;
  tension: string;
}

export interface GlossaryAdviceAdvisory {
  name: string;
  primaryOutcome: string;
  match: Record<string, string[]>;
  caveatReason: string;
  ownershipState: string;
  review: string | null;
}

export interface GlossaryAdviceContract {
  implementation: string;
  runtime: string;
  command: string;
  requestSchemaVersion: string;
  requestFields: string[];
  maxRequestUtf8Bytes: number;
  maxRequestedTermUtf8Bytes: number;
  maxEntries: number;
  availabilityStates: string[];
  hostReviewRelations: string[];
  hostReviewCandidateOwners: string[];
  hostReviewFields: string[];
  schemaVersion: string;
  outputFields: string[];
  advisoryFields: string[];
  failureClasses: string[];
  dimensions: Record<string, string[]>;
  rows: GlossaryAdviceRow[];
  advisories: GlossaryAdviceAdvisory[];
}

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Mapping) : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

export function glossaryAdviceContract(pathname: string = glossaryEntryAuthorityPath()): GlossaryAdviceContract {
  const authority = loadYamlMappingFile(pathname) as Mapping;
  const consumer = mapping(authority.consumer_boundary);
  const acquisition = mapping(consumer?.acquisition);
  const acquisitionBounds = mapping(acquisition?.bounds);
  const availability = mapping(acquisition?.availability);
  const advice = mapping(consumer?.advice_resolution);
  const input = mapping(advice?.input);
  const invocation = mapping(advice?.invocation);
  const hostReview = mapping(input?.host_review);
  const output = mapping(advice?.output);
  const failure = mapping(advice?.failure);
  const selection = mapping(consumer?.primary_selection);
  const matrix = mapping(consumer?.outcome_matrix);
  const advisories = mapping(consumer?.orthogonal_advisories);
  return {
    implementation: typeof advice?.implementation === "string" ? advice.implementation : "",
    runtime: typeof advice?.runtime === "string" ? advice.runtime : "",
    command: projectGlossaryDevelopmentValue(invocation?.command, "advice.command"),
    requestSchemaVersion: typeof invocation?.request_schema_version === "string" ? invocation.request_schema_version : "",
    requestFields: strings(invocation?.request_fields),
    maxRequestUtf8Bytes: typeof invocation?.max_request_utf8_bytes === "number" ? invocation.max_request_utf8_bytes : 0,
    maxRequestedTermUtf8Bytes: typeof acquisitionBounds?.max_source_utf8_bytes === "number" ? acquisitionBounds.max_source_utf8_bytes : 0,
    maxEntries: typeof acquisitionBounds?.max_entries === "number" ? acquisitionBounds.max_entries : 0,
    availabilityStates: strings(availability?.states),
    hostReviewRelations: strings(hostReview?.relations),
    hostReviewCandidateOwners: strings(hostReview?.candidate_owners),
    hostReviewFields: strings(hostReview?.fields),
    schemaVersion: typeof output?.schema_version === "string" ? output.schema_version : "",
    outputFields: strings(output?.fields),
    advisoryFields: strings(output?.advisory_fields),
    failureClasses: strings(failure?.classes),
    dimensions: Object.fromEntries(Object.entries(mapping(selection?.dimensions) ?? {}).map(([name, values]) => [name, strings(values)])),
    rows: strings(selection?.order).map((name) => {
      const row = mapping(matrix?.[name]);
      return {
        name,
        match: Object.fromEntries(Object.entries(mapping(row?.match) ?? {}).map(([dimension, values]) => [dimension, strings(values)])),
        selectedOwner: typeof row?.selected_owner === "string" ? row.selected_owner : "",
        selectedMeaning: typeof row?.selected_meaning === "string" ? row.selected_meaning : "",
        review: typeof row?.review === "string" ? row.review : "",
        tension: typeof row?.tension === "string" ? row.tension : "",
      };
    }),
    advisories: Object.entries(advisories ?? {}).map(([name, value]) => {
      const advisory = mapping(value);
      return {
        name,
        primaryOutcome: typeof advisory?.primary_outcome === "string" ? advisory.primary_outcome : "",
        match: Object.fromEntries(Object.entries(mapping(advisory?.match) ?? {}).map(([dimension, values]) => [dimension, strings(values)])),
        caveatReason: typeof advisory?.caveat_reason === "string" ? advisory.caveat_reason : "",
        ownershipState: typeof advisory?.ownership_state === "string" ? advisory.ownership_state : "",
        review: typeof advisory?.review === "string" ? advisory.review : null,
      };
    }),
  };
}
