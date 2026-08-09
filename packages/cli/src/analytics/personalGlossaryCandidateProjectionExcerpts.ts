import { containsGlossaryTerm } from "../registries/glossaryTermOccurrence.js";
import { compareGlossaryUnicodeStrings } from "../registries/glossaryTermIdentity.js";

import type { PersonalGlossarySafeExcerpt } from "./personalGlossaryCandidateProjection.js";

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const TOOL_ARGUMENTS_RE = /\b(?:tool[ _-]?arguments?|argv)\b/iu;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const PRIVATE_KEY_RE = /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/u;
const ASSIGNED_SENSITIVE_VALUE_RE =
  /(?:^|[^A-Za-z0-9_])["']?(?:api[_-]?key|access[_-]?token|password|passwd|cookie|private[_-]?key|authorization(?:[_-]?header)?|session(?:[_-]?id)?|email|phone|contact)["']?\s*[:=]\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s,;}\]]+))/giu;
const BEARER_VALUE_RE = /\bbearer\s+([A-Za-z0-9._~+/=-]{6,})/giu;
const BARE_SESSION_VALUE_RE = /\bsession[-_]([A-Za-z0-9._~+/=-]{6,})\b/giu;
const API_KEY_RE = /\b(?:sk|pk)_(?:live|test)_?[A-Za-z0-9_-]{8,}\b/u;
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/u;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PHONE_RE = /(?:\+?\d[\d .()-]{7,}\d)/u;
const UNIX_PATH_RE = /(?:^|[\s("'`])(?:~\/|\/)(?:[^\s/]+\/)*[^\s/]+/u;
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/u;

const SENSITIVE_CONTENT_PATTERNS = [
  PRIVATE_KEY_RE,
  API_KEY_RE,
  AWS_KEY_RE,
  JWT_RE,
  EMAIL_RE,
  PHONE_RE,
  UNIX_PATH_RE,
  WINDOWS_PATH_RE,
] as const;

export const EXCERPT_OMISSION_REASONS = [
  "no_excerpt",
  "unrelated_context",
  "source_bound_exceeded",
  "unsafe_tool_arguments",
  "unsafe_content",
] as const;

export type ExcerptOmissionReason = (typeof EXCERPT_OMISSION_REASONS)[number];

export interface PersonalGlossaryCandidateProjectionExcerptContract {
  sourceExcerptMaxUtf8Bytes: number;
  pendingExcerptDays: number;
}

export interface ExcerptSelection {
  excerpt: PersonalGlossarySafeExcerpt | null;
  omission: ExcerptOmissionReason | null;
  provided: number;
  truncated: boolean;
}

function compareText(left: string, right: string): number {
  return compareGlossaryUnicodeStrings(left, right);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP_RE.test(value) && !Number.isNaN(Date.parse(value));
}

export function personalGlossaryCandidateProjectionExcerptExpiry(
  retainedAt: string,
  pendingExcerptDays: number,
): string {
  return new Date(Date.parse(retainedAt) + pendingExcerptDays * 24 * 60 * 60 * 1000).toISOString();
}

function truncateUtf8(value: string, maximum: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maximum) return { text: value, truncated: false };
  let bytes = 0;
  let text = "";
  for (const scalar of value) {
    const scalarBytes = Buffer.byteLength(scalar, "utf8");
    if (bytes + scalarBytes > maximum) break;
    text += scalar;
    bytes += scalarBytes;
  }
  return { text, truncated: true };
}

/** Classify secret or sensitive values without returning or transforming them. */
export function containsPersonalGlossarySensitiveContent(value: string): boolean {
  if (SENSITIVE_CONTENT_PATTERNS.some((pattern) => pattern.test(value))) return true;
  for (const match of value.matchAll(ASSIGNED_SENSITIVE_VALUE_RE)) {
    if (credentialShapedValue(match[1] ?? match[2] ?? match[3] ?? "")) return true;
  }
  for (const match of value.matchAll(BEARER_VALUE_RE)) {
    if (credentialShapedValue(match[1] ?? "")) return true;
  }
  for (const match of value.matchAll(BARE_SESSION_VALUE_RE)) {
    if (credentialShapedValue(match[1] ?? "", false)) return true;
  }
  return false;
}

function credentialShapedValue(value: string, allowLongLetters = true): boolean {
  const candidate = value.trim();
  if (candidate.length === 0 || candidate === "[REDACTED]") return false;
  const scheme = /^(?:bearer|basic)\s+(.+)$/iu.exec(candidate);
  if (scheme) return credentialShapedValue(scheme[1] ?? "");
  if (/\s/u.test(candidate)) return false;
  return (
    (candidate.length >= 6 && /[A-Za-z]/u.test(candidate) && /\d/u.test(candidate)) ||
    (candidate.length >= 8 && /[A-Za-z]/u.test(candidate) && /[-_.=+/]/u.test(candidate)) ||
    (allowLongLetters && candidate.length >= 16 && /^[A-Za-z]+$/u.test(candidate))
  );
}

export function validPersonalGlossarySafeExcerpt(
  value: unknown,
): value is PersonalGlossarySafeExcerpt {
  const excerpt =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  return (
    excerpt !== null &&
    typeof excerpt === "object" &&
    Object.keys(excerpt).length === 3 &&
    ["expires_at", "redacted", "text"].every((key) => key in excerpt) &&
    typeof excerpt.text === "string" &&
    excerpt.text.length > 0 &&
    Buffer.byteLength(excerpt.text, "utf8") <= 500 &&
    !CONTROL_RE.test(excerpt.text) &&
    !TOOL_ARGUMENTS_RE.test(excerpt.text) &&
    !containsPersonalGlossarySensitiveContent(excerpt.text) &&
    validTimestamp(excerpt.expires_at) &&
    typeof excerpt.redacted === "boolean"
  );
}

function safeExcerpt(
  source: string,
  term: string,
  retainedAt: string,
  contract: PersonalGlossaryCandidateProjectionExcerptContract,
): ExcerptSelection {
  if (Buffer.byteLength(source, "utf8") > contract.sourceExcerptMaxUtf8Bytes) {
    return { excerpt: null, omission: "source_bound_exceeded", provided: 1, truncated: false };
  }
  if (!containsGlossaryTerm(source, term)) {
    return { excerpt: null, omission: "unrelated_context", provided: 1, truncated: false };
  }
  if (CONTROL_RE.test(source) || TOOL_ARGUMENTS_RE.test(source)) {
    return { excerpt: null, omission: "unsafe_tool_arguments", provided: 1, truncated: false };
  }
  if (containsPersonalGlossarySensitiveContent(source)) {
    return { excerpt: null, omission: "unsafe_content", provided: 1, truncated: false };
  }
  const bounded = truncateUtf8(source, 500);
  if (bounded.text.length === 0) {
    return { excerpt: null, omission: "unsafe_content", provided: 1, truncated: bounded.truncated };
  }
  const excerpt = {
    text: bounded.text,
    expires_at: personalGlossaryCandidateProjectionExcerptExpiry(
      retainedAt,
      contract.pendingExcerptDays,
    ),
    redacted: false,
  };
  if (!validPersonalGlossarySafeExcerpt(excerpt)) {
    return { excerpt: null, omission: "unsafe_content", provided: 1, truncated: bounded.truncated };
  }
  return { excerpt, omission: null, provided: 1, truncated: bounded.truncated };
}

export function selectPersonalGlossarySafeExcerpt(
  excerpts: ReadonlySet<string>,
  term: string,
  retainedAt: string,
  contract: PersonalGlossaryCandidateProjectionExcerptContract,
): ExcerptSelection {
  if (excerpts.size === 0) {
    return { excerpt: null, omission: "no_excerpt", provided: 0, truncated: false };
  }
  let firstOmission: ExcerptSelection | null = null;
  for (const source of [...excerpts].sort(compareText)) {
    const selected = safeExcerpt(source, term, retainedAt, contract);
    if (selected.excerpt !== null) return selected;
    firstOmission ??= selected;
  }
  return firstOmission!;
}
