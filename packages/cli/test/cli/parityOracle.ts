/**
 * Parity oracle helpers for the npm @next parity matrix.
 *
 * The matrix at `packages/cli/test/cli/npmParityMatrix.test.ts` compares the
 * live TypeScript CLI envelopes to the Python `agentera` stable CLI pinned at
 * `python_commit` in `fixtures/oracle/parity-remaining-families.json`. The
 * helpers in this module centralize the normalization and drift classification
 * so the matrix and its future siblings (T2-T7 close the per-family rows) stay
 * in lockstep with the fixture.
 *
 * Rules (mirrored from `parity-remaining-families.json`):
 *   - timestamp: ISO 8601 with time → YYYY-MM-DD
 *   - hash:      any hex hash → 0x + first 8 hex chars (case-insensitive)
 *   - path:      any path-allowlisted string → forward-slash form
 *
 * The four-valued drift taxonomy applied to every row:
 *   - `equal`                        — normalized TS envelope matches the pin
 *   - `ts_smaller`                   — TS envelope is missing keys the pin has
 *   - `python_smaller`               — TS envelope has extra keys / forbidden
 *                                      substrings / literal mismatches
 *   - `intentional_version_break`    — the row has `version_break: true`,
 *                                      which lifts `ts_smaller` and
 *                                      `python_smaller` to a pass
 */

export type DriftDirection =
  | "equal"
  | "ts_smaller"
  | "python_smaller"
  | "intentional_version_break";

export interface NormalizeRules {
  timestamp: { regex: string; shape: string };
  hash: { regex: string; shape: string };
  path: { shape: string; pathKeys: string[] };
}

const DEFAULT_RULES: NormalizeRules = {
  timestamp: { regex: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:?\\d{2})?$", shape: "YYYY-MM-DD" },
  hash: { regex: "^(sha256:|sha1:|md5:)?([0-9a-fA-F]{8,})$", shape: "0xXXXXXXXX" },
  path: { shape: "forward-slash", pathKeys: [] },
};

/**
 * Recursively normalize a JSON envelope.
 *
 * @param value - the value to normalize (object, array, or scalar)
 * @param key - the key under which `value` sits (null at the root)
 * @param rules - the normalization rules (defaults to the rules pinned in
 *                `parity-remaining-families.json`)
 */
export function normalizeEnvelope(
  value: unknown,
  key: string | null = null,
  rules: NormalizeRules = DEFAULT_RULES,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeEnvelope(entry, key, rules));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeEnvelope(v, k, rules);
    }
    return out;
  }
  if (typeof value !== "string") return value;

  // Path normalization: only apply to keys in the path allowlist.
  if (key !== null && rules.path.pathKeys.includes(key)) {
    return value.replace(/\\/g, "/");
  }
  // Timestamp normalization.
  if (new RegExp(rules.timestamp.regex).test(value)) {
    return value.slice(0, 10);
  }
  // Hash normalization.
  const hashMatch = new RegExp(rules.hash.regex).exec(value);
  if (hashMatch) {
    const hex = hashMatch[2];
    if (hex.length >= 8) {
      return `0x${hex.slice(0, 8).toLowerCase()}`;
    }
    return value;
  }
  return value;
}

export interface ParityRow {
  family: string;
  argv: string[];
  exitCode: number;
  requiredKeys: string[];
  commandValue?: string;
  literalPins?: Record<string, unknown>;
  forbiddenSubstrings: string[];
  python_commit: string;
  version_break: boolean;
}

const EXPECTED_SHAPE_TYPE_MARKERS = new Set(["string", "object", "array", "boolean", "number"]);
const EXPECTED_SHAPE_LITERAL_PIN_KEYS = new Set([
  "command_value",
  "target_family_value",
  "family_value",
  "gate_value",
  "target_value",
]);

const EXPECTED_SHAPE_LITERAL_PIN_MAP: Record<string, string> = {
  command_value: "command",
  target_family_value: "target_family",
  family_value: "family",
  gate_value: "gate",
  target_value: "target",
};

/**
 * Derive top-level required keys from a parity fixture `expectedShape` block.
 * Includes object/array markers (not only `string`) so nested envelopes like
 * verify `engine`/`diagnostics`/`safety` classify as `equal` when present.
 */
function isExpectedShapeRequiredKey(key: string, value: unknown): boolean {
  if (
    key.endsWith("Union") ||
    key.endsWith("_union") ||
    key.endsWith("RequiredKeys") ||
    key.endsWith("Length") ||
    key.endsWith("_value") ||
    key.includes("_value_") ||
    EXPECTED_SHAPE_LITERAL_PIN_KEYS.has(key)
  ) {
    return false;
  }
  if (EXPECTED_SHAPE_TYPE_MARKERS.has(value as string)) {
    return true;
  }
  // Nullable unions such as `["string", "null"]` still pin a required envelope key.
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string");
}

export function expectedShapeRequiredKeys(expectedShape: Record<string, unknown>): string[] {
  return Object.keys(expectedShape).filter((k) => isExpectedShapeRequiredKey(k, expectedShape[k]));
}

/** Literal pins (`command_value` → `command`, etc.) from `expectedShape`. */
export function expectedShapeLiteralPins(expectedShape: Record<string, unknown>): Record<string, unknown> {
  const pins: Record<string, unknown> = {};
  for (const [shapeKey, envelopeKey] of Object.entries(EXPECTED_SHAPE_LITERAL_PIN_MAP)) {
    const value = expectedShape[shapeKey];
    if (typeof value === "string") {
      pins[envelopeKey] = value;
    }
  }
  return pins;
}

export interface DriftClassification {
  direction: DriftDirection;
  missingKeys: string[];
  extraKeys: string[];
  forbiddenHits: string[];
  literalMismatches: string[];
}

/**
 * Classify the drift between a normalized TS envelope and the Python oracle
 * pin. The four directions are mutually exclusive: a row with both missing
 * keys and extra keys is reported as `ts_smaller` (the more severe drift).
 */
export function classifyDrift(
  normalized: Record<string, unknown>,
  expectedKeys: string[],
  expectedLiteralPins: Record<string, unknown> = {},
  forbiddenSubstrings: string[] = [],
): DriftClassification {
  const actual = new Set(Object.keys(normalized));
  const expected = new Set(expectedKeys);
  const missingKeys = [...expected].filter((k) => !actual.has(k)).sort();
  const extraKeys = [...actual].filter((k) => !expected.has(k)).sort();
  const serialized = JSON.stringify(normalized);
  const forbiddenHits = forbiddenSubstrings.filter((needle) => serialized.includes(needle));
  const literalMismatches: string[] = [];
  for (const [key, pin] of Object.entries(expectedLiteralPins)) {
    if (key in normalized && normalized[key] !== pin) {
      literalMismatches.push(
        `${key}: expected ${JSON.stringify(pin)}, got ${JSON.stringify(normalized[key])}`,
      );
    }
  }
  let direction: DriftDirection;
  if (
    missingKeys.length === 0 &&
    extraKeys.length === 0 &&
    forbiddenHits.length === 0 &&
    literalMismatches.length === 0
  ) {
    direction = "equal";
  } else if (missingKeys.length > 0) {
    direction = "ts_smaller";
  } else if (extraKeys.length > 0 || forbiddenHits.length > 0 || literalMismatches.length > 0) {
    direction = "python_smaller";
  } else {
    direction = "equal";
  }
  return { direction, missingKeys, extraKeys, forbiddenHits, literalMismatches };
}

/**
 * Resolve the effective drift direction for a row, given its
 * `version_break` flag. `version_break=true` lifts any non-equal
 * classification to `intentional_version_break`.
 */
export function effectiveDriftDirection(
  row: ParityRow,
  classification: DriftClassification,
): DriftDirection {
  if (row.version_break && classification.direction !== "equal") {
    return "intentional_version_break";
  }
  return classification.direction;
}
