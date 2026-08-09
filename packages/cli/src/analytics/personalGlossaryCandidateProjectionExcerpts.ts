import { containsGlossaryTerm } from "../registries/glossaryTermOccurrence.js";
import { compareGlossaryUnicodeStrings } from "../registries/glossaryTermIdentity.js";

import type { PersonalGlossarySafeExcerpt } from "./personalGlossaryCandidateProjection.js";

const REDACTED = "[REDACTED]";
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const TOOL_ARGUMENTS_RE = /\b(?:tool[ _-]?arguments?|argv)\b/iu;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const PRIVATE_KEY_RE =
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/gu;
const NAMED_SECRET_RE =
  /\b((?:api[_-]?key|access[_-]?token|password|passwd|cookie)\s*[:=]\s*)([^\s,;]+)/giu;
const QUOTED_SENSITIVE_VALUE_RE =
  /((?:["'])(?:api[_-]?key|access[_-]?token|password|passwd|cookie|private[_-]?key|authorization(?:[_-]?header)?|session(?:[_-]?id)?|email|phone|contact)(?:["'])\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/giu;
const UNREDACTED_QUOTED_SENSITIVE_RE =
  /(?:["'])(?:api[_-]?key|access[_-]?token|password|passwd|cookie|private[_-]?key|authorization(?:[_-]?header)?|session(?:[_-]?id)?|email|phone|contact)(?:["'])\s*:\s*(?!["']\[REDACTED\]["'])/iu;
const AUTHORIZATION_RE = /\b(authorization\s*:\s*)(?:bearer\s+)?[^\s,;]+/giu;
const BEARER_RE = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu;
const API_KEY_RE = /\b(?:sk|pk)_(?:live|test)_?[A-Za-z0-9_-]{8,}\b/gu;
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/gu;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE_RE = /(?:\+?\d[\d .()-]{7,}\d)/gu;
const NAMED_SESSION_RE = /\b(session(?:[_-]?id)?\s*[:=]\s*)([^\s,;]+)/giu;
const BARE_SESSION_RE = /\bsession[-_][A-Za-z0-9._-]+\b/giu;
const UNIX_PATH_RE = /(^|[\s("'`])(?:~\/|\/)(?:[^\s/]+\/)*[^\s/]+/gu;
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/gu;

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

function redactExcerpt(value: string): { text: string; redacted: boolean } {
  let text = value;
  let redacted = false;
  const replace = (pattern: RegExp, replacement: string): void => {
    const next = text.replace(pattern, replacement);
    if (next !== text) redacted = true;
    text = next;
  };
  replace(PRIVATE_KEY_RE, REDACTED);
  replace(QUOTED_SENSITIVE_VALUE_RE, `$1"${REDACTED}"`);
  replace(NAMED_SECRET_RE, `$1${REDACTED}`);
  replace(AUTHORIZATION_RE, `$1${REDACTED}`);
  replace(BEARER_RE, `$1${REDACTED}`);
  replace(API_KEY_RE, REDACTED);
  replace(AWS_KEY_RE, REDACTED);
  replace(JWT_RE, REDACTED);
  replace(EMAIL_RE, REDACTED);
  replace(PHONE_RE, REDACTED);
  replace(NAMED_SESSION_RE, `$1${REDACTED}`);
  replace(BARE_SESSION_RE, REDACTED);
  replace(UNIX_PATH_RE, `$1${REDACTED}`);
  replace(WINDOWS_PATH_RE, REDACTED);
  return { text, redacted };
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
    !/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/iu.test(excerpt.text) &&
    !/\b(?:api[_-]?key|access[_-]?token|password|passwd|cookie)\s*[:=]\s*(?!\[REDACTED\])/iu.test(
      excerpt.text,
    ) &&
    !UNREDACTED_QUOTED_SENSITIVE_RE.test(excerpt.text) &&
    !/\bauthorization\s*:\s*(?!\[REDACTED\])/iu.test(excerpt.text) &&
    !/\bbearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{8,}/iu.test(excerpt.text) &&
    !/\b(?:sk|pk)_(?:live|test)_?[A-Za-z0-9_-]{8,}\b/u.test(excerpt.text) &&
    !/\bAKIA[0-9A-Z]{16}\b/u.test(excerpt.text) &&
    !/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u.test(excerpt.text) &&
    !/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(excerpt.text) &&
    !/(?:\+?\d[\d .()-]{7,}\d)/u.test(excerpt.text) &&
    !/\bsession[-_][A-Za-z0-9._-]+\b/iu.test(excerpt.text) &&
    !/(?:^|[\s("'`])(?:~\/|\/)(?:[^\s/]+\/)*[^\s/]+/u.test(excerpt.text) &&
    !/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/u.test(excerpt.text) &&
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
  const redacted = redactExcerpt(source);
  if (
    CONTROL_RE.test(redacted.text) ||
    TOOL_ARGUMENTS_RE.test(redacted.text) ||
    /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/iu.test(redacted.text) ||
    /\b(?:api[_-]?key|access[_-]?token|password|passwd|cookie)\s*[:=]\s*(?!\[REDACTED\])/iu.test(
      redacted.text,
    )
  ) {
    return { excerpt: null, omission: "unsafe_content", provided: 1, truncated: false };
  }
  const bounded = truncateUtf8(redacted.text, 500);
  if (bounded.text.length === 0) {
    return { excerpt: null, omission: "unsafe_content", provided: 1, truncated: bounded.truncated };
  }
  const excerpt = {
    text: bounded.text,
    expires_at: personalGlossaryCandidateProjectionExcerptExpiry(
      retainedAt,
      contract.pendingExcerptDays,
    ),
    redacted: redacted.redacted,
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
