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
  it.each([
    ["UTC with milliseconds", "2026-06-04T11:45:30.123Z", "2026-06-04"],
    ["UTC without milliseconds", "2026-06-04T11:45:30Z", "2026-06-04"],
    ["positive offset", "2026-06-04T11:45:30+00:00", "2026-06-04"],
    ["negative offset", "2026-06-04T11:45:30-05:00", "2026-06-04"],
    ["date only", "2026-06-04", "2026-06-04"],
    ["non-ISO text", "hello world", "hello world"],
  ])("normalizes %s", (_label, input, expected) => {
    expect(normalizeEnvelope(input, null, RULES)).toBe(expected);
  });
});

describe("normalizeEnvelope() — hash rule", () => {
  it.each([
    ["bare lowercase", "abcdef0123456789", "0xabcdef01"],
    ["bare uppercase", "ABCDEF0123456789", "0xabcdef01"],
    ["sha256 prefix", "sha256:abcdef0123456789", "0xabcdef01"],
    ["sha1 prefix", "sha1:abcdef0123456789", "0xabcdef01"],
    ["md5 prefix", "md5:abcdef0123456789", "0xabcdef01"],
    ["short text", "abc", "abc"],
  ])("normalizes %s", (_label, input, expected) => {
    expect(normalizeEnvelope(input, null, RULES)).toBe(expected);
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

  it.each([42, null, true, false])("passes the scalar %s through unchanged", (input) => {
    expect(normalizeEnvelope(input, null, RULES)).toBe(input);
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

  it.each<[string, boolean, DriftDirection, DriftDirection]>([
    ["equal without a version break", false, "equal", "equal"],
    ["ts_smaller with a version break", true, "ts_smaller", "intentional_version_break"],
    ["python_smaller with a version break", true, "python_smaller", "intentional_version_break"],
    ["ts_smaller without a version break", false, "ts_smaller", "ts_smaller"],
  ])("classifies %s", (_label, versionBreak, direction, expected) => {
    expect(
      effectiveDriftDirection(
        { ...baseRow, version_break: versionBreak },
        {
          direction,
          missingKeys: direction === "ts_smaller" ? ["x"] : [],
          extraKeys: direction === "python_smaller" ? ["x"] : [],
          forbiddenHits: [],
          literalMismatches: [],
        },
      ),
    ).toBe(expected);
  });
});
