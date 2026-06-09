/**
 * Python-faithful JSON string helpers.
 *
 * Mirrors CPython's `json` encoder for the cases the CLI/hook surfaces need:
 * ensure_ascii escaping and the default inline separators (", " / ": ").
 * `pyJsonInline` / `pyJsonIndent` keep insertion-ordered object keys; sorted
 * variants match `json.dumps(..., sort_keys=True)` for doctor parity.
 */

export type PyJsonScalarHook = (value: unknown) => string | undefined;

function formatScalar(value: unknown, hook?: PyJsonScalarHook): string | null {
  const hooked = hook?.(value);
  if (hooked !== undefined) return hooked;
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return pyJsonString(value);
  return null;
}

/** Mirror Python json encoder string escaping with ensure_ascii=True. */
export function pyJsonString(str: string): string {
  let out = '"';
  for (const ch of str) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (cp === 0x08) out += "\\b";
    else if (cp === 0x09) out += "\\t";
    else if (cp === 0x0a) out += "\\n";
    else if (cp === 0x0c) out += "\\f";
    else if (cp === 0x0d) out += "\\r";
    else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
    else if (cp < 0x80) out += ch;
    else if (cp > 0xffff) {
      const v = cp - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      out += "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
    } else {
      out += "\\u" + cp.toString(16).padStart(4, "0");
    }
  }
  return out + '"';
}

/**
 * Mirror Python `json.dumps(value)` with default options: insertion-ordered
 * object keys, separators (", ", ": "), ensure_ascii=True. Integers render
 * without a decimal point; this helper does not model floats.
 */
export function pyJsonInline(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return pyJsonString(value);
  if (Array.isArray(value)) return "[" + value.map((v) => pyJsonInline(v)).join(", ") + "]";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return "{" + entries.map(([k, v]) => `${pyJsonString(k)}: ${pyJsonInline(v)}`).join(", ") + "}";
  }
  return "null";
}

/**
 * Mirror Python `json.dumps(value, indent=indent)` with default options:
 * insertion-ordered object keys, ensure_ascii=True, item separator "," and key
 * separator ": ", newline + indentation between items, and "{}"/"[]" for empty
 * containers. Models ints/strings/bools/null/arrays/objects (no float formatting).
 */
export function pyJsonIndent(value: unknown, indent = 2, level = 0): string {
  const pad = " ".repeat(indent * (level + 1));
  const closePad = " ".repeat(indent * level);
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return pyJsonString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => pad + pyJsonIndent(v, indent, level + 1));
    return "[\n" + items.join(",\n") + "\n" + closePad + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const items = entries.map(
      ([k, v]) => pad + pyJsonString(k) + ": " + pyJsonIndent(v, indent, level + 1),
    );
    return "{\n" + items.join(",\n") + "\n" + closePad + "}";
  }
  return "null";
}

/**
 * Mirror Python `json.dumps(value, sort_keys=True)` with default options:
 * sorted object keys, separators (", " / ": "), ensure_ascii=True.
 */
export function pyJsonDumps(value: unknown, hook?: PyJsonScalarHook): string {
  const scalar = formatScalar(value, hook);
  if (scalar !== null) return scalar;
  if (Array.isArray(value)) return "[" + value.map((v) => pyJsonDumps(v, hook)).join(", ") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return (
      "{" +
      keys
        .map((k) => `${pyJsonString(k)}: ${pyJsonDumps((value as Record<string, unknown>)[k], hook)}`)
        .join(", ") +
      "}"
    );
  }
  return "null";
}

/**
 * Mirror Python `json.dumps(value, indent=2, sort_keys=True)` with default
 * options: sorted object keys, ensure_ascii=True, 2-space indentation.
 */
export function pyJsonIndentSorted(
  value: unknown,
  indent = 2,
  level = 0,
  hook?: PyJsonScalarHook,
): string {
  const pad = " ".repeat(indent * (level + 1));
  const closePad = " ".repeat(indent * level);
  const scalar = formatScalar(value, hook);
  if (scalar !== null) return scalar;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => pad + pyJsonIndentSorted(v, indent, level + 1, hook));
    return "[\n" + items.join(",\n") + "\n" + closePad + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    if (keys.length === 0) return "{}";
    const items = keys.map(
      (k) =>
        pad +
        pyJsonString(k) +
        ": " +
        pyJsonIndentSorted((value as Record<string, unknown>)[k], indent, level + 1, hook),
    );
    return "{\n" + items.join(",\n") + "\n" + closePad + "}";
  }
  return "null";
}
