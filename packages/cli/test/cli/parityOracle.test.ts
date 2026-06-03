import { describe, expect, it } from "vitest";

import {
  classifyDrift,
  DriftDirection,
  effectiveDriftDirection,
  expectedShapeLiteralPins,
  expectedShapeRequiredKeys,
  normalizeEnvelope,
  ParityRow,
} from "./parityOracle.js";

const RULES = {
  timestamp: {
    regex: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:?\\d{2})?$",
    shape: "YYYY-MM-DD",
  },
  hash: { regex: "^(sha256:|sha1:|md5:)?([0-9a-fA-F]{8,})$", shape: "0xXXXXXXXX" },
  path: {
    shape: "forward-slash",
    pathKeys: ["path", "file", "app_home", "managed_app_root", "user_data_root"],
  },
} as const;

describe("normalizeEnvelope() — timestamp rule", () => {
  it("reduces a UTC ISO 8601 timestamp to the date", () => {
    expect(normalizeEnvelope("2026-06-04T11:45:30.123Z", null, RULES)).toBe("2026-06-04");
    expect(normalizeEnvelope("2026-06-04T11:45:30Z", null, RULES)).toBe("2026-06-04");
  });

  it("reduces an offset ISO 8601 timestamp to the date", () => {
    expect(normalizeEnvelope("2026-06-04T11:45:30+00:00", null, RULES)).toBe("2026-06-04");
    expect(normalizeEnvelope("2026-06-04T11:45:30-05:00", null, RULES)).toBe("2026-06-04");
  });

  it("passes a date-only string through unchanged", () => {
    expect(normalizeEnvelope("2026-06-04", null, RULES)).toBe("2026-06-04");
  });

  it("passes a non-ISO string through unchanged", () => {
    expect(normalizeEnvelope("hello world", null, RULES)).toBe("hello world");
  });
});

describe("normalizeEnvelope() — hash rule", () => {
  it("reduces a 16-char hex hash to 0x + first 8 hex chars (lowercase)", () => {
    expect(normalizeEnvelope("abcdef0123456789", null, RULES)).toBe("0xabcdef01");
  });

  it("reduces an uppercase hex hash to lowercase", () => {
    expect(normalizeEnvelope("ABCDEF0123456789", null, RULES)).toBe("0xabcdef01");
  });

  it("strips algorithm prefixes before truncation", () => {
    expect(normalizeEnvelope("sha256:abcdef0123456789", null, RULES)).toBe("0xabcdef01");
    expect(normalizeEnvelope("sha1:abcdef0123456789", null, RULES)).toBe("0xabcdef01");
    expect(normalizeEnvelope("md5:abcdef0123456789", null, RULES)).toBe("0xabcdef01");
  });

  it("passes short strings through unchanged", () => {
    expect(normalizeEnvelope("abc", null, RULES)).toBe("abc");
  });
});

describe("normalizeEnvelope() — path rule", () => {
  it("normalizes backslashes to forward slashes on path-allowlisted keys", () => {
    expect((normalizeEnvelope({ path: "C:\\Users\\me\\repo" }, null, RULES) as { path: string }).path).toBe(
      "C:/Users/me/repo",
    );
  });

  it("normalizes multiple path-allowlisted keys in one envelope", () => {
    const out = normalizeEnvelope(
      { path: "a\\b", file: "c\\d\\e.md", app_home: "f\\g" },
      null,
      RULES,
    ) as { path: string; file: string; app_home: string };
    expect(out.path).toBe("a/b");
    expect(out.file).toBe("c/d/e.md");
    expect(out.app_home).toBe("f/g");
  });

  it("does NOT normalize non-allowlisted keys (e.g., 'note', 'description')", () => {
    const out = normalizeEnvelope({ note: "C:\\Users\\me" }, null, RULES) as { note: string };
    expect(out.note).toBe("C:\\Users\\me");
  });
});

describe("normalizeEnvelope() — recursion", () => {
  it("recurses through arrays of objects", () => {
    const input = {
      commands: [
        { command: "x", extracted_at: "2026-06-04T11:45:30Z", trust_hash: "sha256:deadbeefcafebabe" },
      ],
    };
    const out = normalizeEnvelope(input, null, RULES) as typeof input;
    expect(out.commands[0].extracted_at).toBe("2026-06-04");
    expect(out.commands[0].trust_hash).toBe("0xdeadbeef");
  });

  it("passes non-string scalars through unchanged", () => {
    expect(normalizeEnvelope(42, null, RULES)).toBe(42);
    expect(normalizeEnvelope(null, null, RULES)).toBe(null);
    expect(normalizeEnvelope(true, null, RULES)).toBe(true);
    expect(normalizeEnvelope(false, null, RULES)).toBe(false);
  });
});

describe("expectedShapeRequiredKeys() — nullable unions", () => {
  it("treats ['string', 'null'] markers as required envelope keys", () => {
    const keys = expectedShapeRequiredKeys({
      command: "string",
      dryRunCommand: ["string", "null"],
      statusUnion: ["up_to_date", "outdated"],
    });
    expect(keys).toEqual(["command", "dryRunCommand"]);
  });
});

describe("classifyDrift() — four-valued taxonomy", () => {
  it("classifies a perfect match as equal", () => {
    const cls = classifyDrift({ command: "validate", status: "pass" }, ["command", "status"], {}, []);
    expect(cls.direction).toBe("equal");
  });

  it("classifies a missing required key as ts_smaller", () => {
    const cls = classifyDrift({ command: "validate" }, ["command", "status"], {}, []);
    expect(cls.direction).toBe("ts_smaller");
    expect(cls.missingKeys).toEqual(["status"]);
  });

  it("classifies an extra undeclared key as python_smaller", () => {
    const cls = classifyDrift(
      { command: "validate", status: "pass", brand_new: "x" },
      ["command", "status"],
      {},
      [],
    );
    expect(cls.direction).toBe("python_smaller");
    expect(cls.extraKeys).toEqual(["brand_new"]);
  });

  it("classifies a forbidden-substring hit as python_smaller", () => {
    const cls = classifyDrift(
      { command: "validate", status: "pass", error_msg: "internal compiler error" },
      ["command", "status", "error_msg"],
      {},
      ["internal compiler error"],
    );
    expect(cls.direction).toBe("python_smaller");
    expect(cls.forbiddenHits).toEqual(["internal compiler error"]);
  });

  it("classifies a literal pin mismatch as python_smaller", () => {
    const cls = classifyDrift(
      { command: "validate_x", status: "pass" },
      ["command", "status"],
      { command: "validate" },
      [],
    );
    expect(cls.direction).toBe("python_smaller");
    expect(cls.literalMismatches.length).toBe(1);
  });

  it("prefers ts_smaller when both missing and extra keys are present", () => {
    const cls = classifyDrift(
      { command: "validate", extra: "x" },
      ["command", "status"],
      {},
      [],
    );
    expect(cls.direction).toBe("ts_smaller");
  });
});

describe("expectedShapeRequiredKeys()", () => {
  it("includes object-typed top-level keys from verify_eval expectedShape", () => {
    const keys = expectedShapeRequiredKeys({
      command: "string",
      command_value: "verify",
      status: "string",
      family: "string",
      family_value: "eval",
      target: "string",
      format: "string",
      engine: "object",
      engineRequiredKeys: ["command", "exit_code"],
      diagnostics: "object",
      safety: "object",
      safetyModeUnion: ["dry-run"],
    });
    expect(keys).toEqual(
      expect.arrayContaining(["command", "status", "family", "target", "format", "engine", "diagnostics", "safety"]),
    );
    expect(keys).not.toContain("command_value");
    expect(keys).not.toContain("engineRequiredKeys");
  });

  it("extracts literal pins from command_value and family_value", () => {
    expect(
      expectedShapeLiteralPins({ command_value: "verify", family_value: "eval", gate_value: "compaction" }),
    ).toEqual({ command: "verify", family: "eval", gate: "compaction" });
  });
});

describe("effectiveDriftDirection() — version_break lift", () => {
  const baseRow: ParityRow = {
    family: "x",
    argv: ["x"],
    exitCode: 0,
    requiredKeys: [],
    forbiddenSubstrings: [],
    python_commit: "0".repeat(40),
    version_break: false,
  };

  it("passes equal through unchanged", () => {
    const direction: DriftDirection = effectiveDriftDirection(baseRow, {
      direction: "equal",
      missingKeys: [],
      extraKeys: [],
      forbiddenHits: [],
      literalMismatches: [],
    });
    expect(direction).toBe("equal");
  });

  it("lifts ts_smaller to intentional_version_break when version_break=true", () => {
    const direction = effectiveDriftDirection(
      { ...baseRow, version_break: true },
      { direction: "ts_smaller", missingKeys: ["x"], extraKeys: [], forbiddenHits: [], literalMismatches: [] },
    );
    expect(direction).toBe("intentional_version_break");
  });

  it("lifts python_smaller to intentional_version_break when version_break=true", () => {
    const direction = effectiveDriftDirection(
      { ...baseRow, version_break: true },
      { direction: "python_smaller", missingKeys: [], extraKeys: ["x"], forbiddenHits: [], literalMismatches: [] },
    );
    expect(direction).toBe("intentional_version_break");
  });

  it("does NOT lift ts_smaller when version_break=false", () => {
    const direction = effectiveDriftDirection(
      { ...baseRow, version_break: false },
      { direction: "ts_smaller", missingKeys: ["x"], extraKeys: [], forbiddenHits: [], literalMismatches: [] },
    );
    expect(direction).toBe("ts_smaller");
  });
});
