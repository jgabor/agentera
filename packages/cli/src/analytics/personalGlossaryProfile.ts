import fs from "node:fs";
import { createHash } from "node:crypto";

import { loadProfileDecayParameters } from "../capabilities/profile/instructions.js";
import { writeFileAtomic } from "../core/atomicWriter.js";
import {
  GlossaryEntryBoundError,
  validateGlossaryEntry,
  type GlossaryAdmissionContext,
} from "../registries/glossaryEntryContract.js";
import { unicodeCaselessExact } from "../registries/glossaryTermIdentity.js";

const START = "<!-- agentera:personal-glossary:start -->";
const END = "<!-- agentera:personal-glossary:end -->";
const HEADING = "## Glossary";
const SCHEMA_VERSION = "agentera.personalGlossarySection.v1";
const DECAY = loadProfileDecayParameters();

type Permanence = keyof typeof DECAY.lambdas;
type ExplicitEvidence = { source_id: string; evidence_anchor: string; signal_type: string };
type InferredEvidence = { source_id: string; evidence_anchor: string; source_kind: string };

export interface PersonalGlossaryEntry {
  term: string;
  meaning: string;
  confidence: number;
  permanence: Permanence;
  temporal: { observed_at: string; last_confirmed_at: string };
  provenance:
    | { kind: "personal_explicit_definition"; evidence: ExplicitEvidence[] }
    | { kind: "personal_inferred_usage"; evidence: InferredEvidence[] };
}

interface PersonalGlossaryDocument {
  schema_version: typeof SCHEMA_VERSION;
  as_of: string;
  confidence_basis: Record<string, number>;
  entries: PersonalGlossaryEntry[];
}

export interface UpdatePersonalGlossaryProfileInput {
  profilePath: string;
  freshEntries: PersonalGlossaryEntry[];
  retainedHistory: GlossaryAdmissionContext;
  asOf: string;
  dryRun?: boolean;
}

export interface UpdatePersonalGlossaryProfileResult {
  changed: boolean;
  profilePath: string;
  profileSectionSha256: string;
  entries: PersonalGlossaryEntry[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function calendarDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`expected ISO calendar date, received '${value}'`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`expected ISO calendar date, received '${value}'`);
  }
  return date;
}

function daysBetween(from: string, to: string): number {
  const days = (calendarDate(to).getTime() - calendarDate(from).getTime()) / 86_400_000;
  if (days < 0) throw new Error(`as_of ${to} precedes last_confirmed_at ${from}`);
  return days;
}

function count(text: string, token: string): number {
  return text.split(token).length - 1;
}

function persistedContext(entry: PersonalGlossaryEntry): GlossaryAdmissionContext {
  const retained = new Map<string, { sourceId: string; sourceKind: string; signalType: string }>();
  for (const evidence of entry.provenance.evidence) {
    retained.set(evidence.evidence_anchor, {
      sourceId: evidence.source_id,
      sourceKind: "source_kind" in evidence ? evidence.source_kind : "conversation_turn",
      signalType: "signal_type" in evidence ? evidence.signal_type : "instruction",
    });
  }
  return { retainedHistory: retained };
}

function validateEntry(entry: PersonalGlossaryEntry, context: GlossaryAdmissionContext): void {
  const errors = validateGlossaryEntry(entry as unknown as Record<string, unknown>, "personal", context);
  if (errors.length > 0) throw new Error(`invalid personal glossary entry '${String(entry.term)}': ${errors.join("; ")}`);
}

function validateUnique(entries: PersonalGlossaryEntry[], label: string): void {
  for (const [index, entry] of entries.entries()) {
    if (entries.slice(0, index).some((candidate) => unicodeCaselessExact(candidate.term, entry.term))) {
      throw new Error(`${label} contains duplicate Unicode caseless-exact term '${entry.term}'`);
    }
  }
}

function matchingIndex(entries: readonly PersonalGlossaryEntry[], term: string): number {
  return entries.findIndex((entry) => unicodeCaselessExact(entry.term, term));
}

function confidenceBasisFor(document: PersonalGlossaryDocument, term: string): number {
  const key = Object.keys(document.confidence_basis).find((candidate) => unicodeCaselessExact(candidate, term));
  return key === undefined ? Number.NaN : document.confidence_basis[key]!;
}

function parseSection(profile: string, maxEntries = Number.POSITIVE_INFINITY): { document: PersonalGlossaryDocument | null; start: number; end: number } {
  const starts = count(profile, START);
  const ends = count(profile, END);
  const headings = [...profile.matchAll(/^## Glossary\s*$/gm)].length;
  if (starts === 0 && ends === 0 && headings === 0) return { document: null, start: -1, end: -1 };
  if (starts > 1 || ends > 1 || headings > 1 || (headings > 0 && starts === 0 && ends === 0)) throw new PersonalGlossaryBoundaryError("ambiguous");
  if (starts !== 1 || ends !== 1 || headings !== 1) throw new PersonalGlossaryBoundaryError("malformed");
  const start = profile.indexOf(START);
  const end = profile.indexOf(END, start) + END.length;
  if (start < 0 || end < END.length || end <= start) throw new Error("PROFILE.md Glossary section has malformed or ambiguous owned boundaries");
  const owned = profile.slice(start, end);
  const newline = "\\r?\\n";
  const match = new RegExp(`^${START}${newline}${HEADING}${newline}${newline}\`\`\`json${newline}([\\s\\S]+)${newline}\`\`\`${newline}${END}$`).exec(owned);
  if (!match) throw new Error("PROFILE.md Glossary section is malformed");
  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch {
    throw new Error("PROFILE.md Glossary section contains invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PROFILE.md Glossary section document is malformed");
  const document = value as PersonalGlossaryDocument;
  if (JSON.stringify(Object.keys(document)) !== JSON.stringify(["schema_version", "as_of", "confidence_basis", "entries"]) || document.schema_version !== SCHEMA_VERSION || !Array.isArray(document.entries) || !document.confidence_basis || typeof document.confidence_basis !== "object" || Array.isArray(document.confidence_basis)) {
    throw new Error("PROFILE.md Glossary section document is malformed");
  }
  if (document.entries.length > maxEntries) throw new GlossaryEntryBoundError("personal glossary exceeds the consumer entry bound");
  calendarDate(document.as_of);
  validateUnique(document.entries, "existing personal glossary");
  const basisKeys = Object.keys(document.confidence_basis);
  if (basisKeys.length !== document.entries.length || basisKeys.some((key, index) => basisKeys.slice(0, index).some((candidate) => unicodeCaselessExact(candidate, key)) || matchingIndex(document.entries, key) < 0)) {
    throw new Error("PROFILE.md Glossary section confidence basis is malformed");
  }
  for (const entry of document.entries) {
    validateEntry(entry, persistedContext(entry));
    const basis = confidenceBasisFor(document, entry.term);
    if (!Number.isInteger(basis) || basis < 0 || basis > 100) throw new Error("PROFILE.md Glossary section confidence basis is malformed");
    daysBetween(entry.temporal.last_confirmed_at, document.as_of);
  }
  return { document, start, end };
}

export class PersonalGlossaryBoundaryError extends Error {
  constructor(readonly availability: "malformed" | "ambiguous") {
    super("PROFILE.md Glossary section has malformed or ambiguous owned boundaries");
  }
}

/** Parse only the owned glossary range and project only consumer-safe fields. */
export function personalGlossaryConsumerEntries(profile: string, maxEntries: number): Array<{ term: string; meaning: string }> | null {
  const document = parseSection(profile, maxEntries).document;
  return document?.entries.map(({ term, meaning }) => ({ term, meaning })) ?? null;
}

/** Return profile grounding with the validated owned glossary range excluded byte-for-byte. */
export function personalProfileGrounding(profile: string): string {
  const section = parseSection(profile);
  return section.document === null
    ? profile
    : `${profile.slice(0, section.start)}${profile.slice(section.end)}`;
}

function orderedEntry(entry: PersonalGlossaryEntry): PersonalGlossaryEntry {
  return {
    term: entry.term,
    meaning: entry.meaning,
    confidence: entry.confidence,
    permanence: entry.permanence,
    temporal: {
      observed_at: entry.temporal.observed_at,
      last_confirmed_at: entry.temporal.last_confirmed_at,
    },
    provenance: {
      kind: entry.provenance.kind,
      evidence: entry.provenance.evidence.map((item) => ({ ...item })),
    } as PersonalGlossaryEntry["provenance"],
  };
}

function render(document: PersonalGlossaryDocument): string {
  return `${START}\n${HEADING}\n\n\`\`\`json\n${JSON.stringify(document, null, 2)}\n\`\`\`\n${END}`;
}

function sectionSha256(section: string): string {
  return createHash("sha256").update(section, "utf8").digest("hex");
}

export function updatePersonalGlossaryProfile(input: UpdatePersonalGlossaryProfileInput): UpdatePersonalGlossaryProfileResult {
  calendarDate(input.asOf);
  const original = fs.readFileSync(input.profilePath, "utf8");
  const section = parseSection(original);
  if (section.document && calendarDate(input.asOf).getTime() < calendarDate(section.document.as_of).getTime()) {
    throw new Error("personal glossary as_of cannot move backward");
  }
  validateUnique(input.freshEntries, "fresh personal glossary evidence");
  for (const entry of input.freshEntries) validateEntry(entry, input.retainedHistory);

  const fresh = input.freshEntries;
  const established = section.document?.entries ?? [];
  const merged: PersonalGlossaryEntry[] = [];
  const confidenceBasis = new Map<string, number>();
  const usedFresh = new Set<number>();

  for (const previous of established) {
    const freshIndex = matchingIndex(fresh, previous.term);
    const current = freshIndex >= 0 ? fresh[freshIndex] : undefined;
    if (freshIndex >= 0) usedFresh.add(freshIndex);
    let entry: PersonalGlossaryEntry;
    let entryBasis: number;
    if (current) {
      if (previous.meaning !== current.meaning || previous.provenance.kind !== current.provenance.kind) {
        throw new Error(`personal glossary conflict for established term '${previous.term}'`);
      }
      daysBetween(previous.temporal.last_confirmed_at, input.asOf);
      entryBasis = current.confidence;
      entry = orderedEntry({
        ...current,
        term: previous.term,
        permanence: previous.permanence,
        temporal: { observed_at: previous.temporal.observed_at, last_confirmed_at: input.asOf },
      });
    } else {
      entryBasis = confidenceBasisFor(section.document!, previous.term);
      const days = daysBetween(previous.temporal.last_confirmed_at, input.asOf);
      entry = orderedEntry({
        ...previous,
        confidence: Math.max(DECAY.floor, Math.round(entryBasis * Math.exp(-DECAY.lambdas[previous.permanence] * days))),
      });
    }
    merged.push(entry);
    confidenceBasis.set(entry.term, entryBasis);
  }
  for (const [index, current] of fresh.entries()) {
    if (usedFresh.has(index)) continue;
    const entryBasis = current.confidence;
    if (calendarDate(current.temporal.observed_at).getTime() > calendarDate(input.asOf).getTime()) throw new Error(`observed_at for '${current.term}' is after as_of`);
    const entry = orderedEntry({
      ...current,
      temporal: { observed_at: current.temporal.observed_at, last_confirmed_at: input.asOf },
    });
    merged.push(entry);
    confidenceBasis.set(entry.term, entryBasis);
  }

  merged.sort((left, right) => compareText(left.term, right.term));
  const orderedBasis = Object.fromEntries(merged.map((entry) => [entry.term, confidenceBasis.get(entry.term)!]));
  const document: PersonalGlossaryDocument = { schema_version: SCHEMA_VERSION, as_of: input.asOf, confidence_basis: orderedBasis, entries: merged };
  const rendered = render(document);
  const candidate = section.document
    ? `${original.slice(0, section.start)}${rendered}${original.slice(section.end)}`
    : `${original}${original.endsWith("\n") ? "\n" : "\n\n"}${rendered}\n`;
  const changed = candidate !== original;
  if (changed && !input.dryRun) {
    writeFileAtomic(input.profilePath, candidate, "utf8", { preserveTargetMode: true });
  }
  return {
    changed,
    profilePath: input.profilePath,
    profileSectionSha256: sectionSha256(rendered),
    entries: merged,
  };
}
