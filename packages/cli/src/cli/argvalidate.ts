import path from "node:path";

/** Argument validation mirroring scripts/agentera's `_validate_*` guards. */

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const ENCODED_TRAVERSAL_RE = /%(?:2e|2f|5c)/i;
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function hasControlChars(value: string): boolean {
  return CONTROL_CHAR_RE.test(value);
}

export function validateAgentString(value: string, label: string): void {
  if (hasControlChars(value)) {
    throw new Error(`${label} contains control characters`);
  }
}

export function validatePathValue(value: string, label: string): void {
  validateAgentString(value, label);
  if (ENCODED_TRAVERSAL_RE.test(value)) {
    throw new Error(`unsafe ${label}: encoded traversal or path separator is not supported`);
  }
  if (URI_SCHEME_RE.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(`unsupported ${label}: URI-style paths are not supported`);
  }
  if (value.split(/[\\/]/).some((part) => part === "..")) {
    throw new Error(`unsafe ${label}: traversal segments are not supported`);
  }
}

/** Python pathlib stem: filename without the final suffix. */
export function pathStem(p: string): string {
  const base = path.basename(p);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base;
  return base.slice(0, dot);
}
