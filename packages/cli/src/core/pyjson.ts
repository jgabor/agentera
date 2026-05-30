/**
 * Python-faithful JSON string helpers.
 *
 * Mirrors CPython's `json` encoder for the cases the CLI/hook surfaces need:
 * ensure_ascii escaping and the default inline separators (", " / ": ") with
 * insertion-ordered object keys (no sort_keys).
 */

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
