import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import {
  emitInvalidInput,
  INVALID_INPUT_EXIT_CODE,
  type InvalidInputErrorClass,
  type InvalidInputEnvelope,
} from "../../src/cli/errors.js";

const ORACLE_PATH = path.join(
  __dirname,
  "fixtures",
  "oracle",
  "invalid-input-envelope.json",
);
const ORACLE = JSON.parse(fs.readFileSync(ORACLE_PATH, "utf8")) as {
  format: "json" | "text";
  exitCode: number;
  requiredTopLevelKeys: string[];
  requiredErrorKeys: string[];
  optionalErrorKeys: string[];
  statusValue: "fail";
  errorClassUnion: string[];
  textMode: {
    stream: "stderr";
    exitCode: number;
    headerLines: string[];
    optionalSectionOrder: string[];
  };
};

function capture(
  fn: (io: { out: (t: string) => void; err: (t: string) => void }) => number,
): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = fn({ out: (t) => (out += t), err: (t) => (err += t) });
  return { rc, out, err };
}

function readEnvelope(out: string): InvalidInputEnvelope {
  return JSON.parse(out) as InvalidInputEnvelope;
}

describe("invalid-input envelope (oracle parity)", () => {
  describe("emitInvalidInput helper", () => {
    it("writes the canonical JSON envelope to stdout in json mode and returns rc 2", () => {
      const { rc, out, err } = capture((io) =>
        emitInvalidInput(io, {
          format: "json",
          body: { class: "missing_argument", message: "validate_family" },
        }),
      );
      expect(rc).toBe(INVALID_INPUT_EXIT_CODE);
      expect(rc).toBe(2);
      expect(err).toBe("");
      const envelope = readEnvelope(out);
      expect(envelope.status).toBe("fail");
      expect(envelope.error.class).toBe("missing_argument");
      expect(envelope.error.message).toBe("validate_family");
      expect(envelope.error.recovery).toBeTruthy();
    });

    it("writes the four-question template to stderr in text mode and returns rc 2", () => {
      const { rc, out, err } = capture((io) =>
        emitInvalidInput(io, {
          format: "text",
          body: {
            class: "invalid_choice",
            message: "--format: bogus",
            valid_values: ["text", "json"],
            syntax: "--format {text|json}",
            example: "agentera state plan",
          },
        }),
      );
      expect(rc).toBe(2);
      expect(out).toBe("");
      for (const header of ORACLE.textMode.headerLines) {
        const expected = header.replace("{message}", "--format: bogus");
        expect(err).toContain(expected);
      }
      expect(err).toContain("Valid values:");
      expect(err).toContain("text");
      expect(err).toContain("json");
      expect(err).toContain("Syntax: --format {text|json}");
      expect(err).toContain("Example:");
      expect(err).toContain("agentera state plan");
      expect(err).toContain("Recovery:");
    });

    it("keeps recovery guidance in text mode when the body omits optional fields", () => {
      const { err } = capture((io) =>
        emitInvalidInput(io, {
          format: "text",
          body: { class: "unrecognized_argument", message: "--bogus" },
        }),
      );
      expect(err).not.toContain("Valid values:");
      expect(err).not.toContain("Syntax:");
      expect(err).not.toContain("Example:");
      expect(err).toContain("Recovery:");
    });
  });

  describe("check validate (the wired exemplar)", () => {
    it("emits the envelope in json mode when no family is given and returns rc 2", () => {
      const { rc, out, err } = capture((io) =>
        main(["node", "agentera", "check", "validate", "--format", "json"], io),
      );
      expect(rc).toBe(2);
      expect(err).toBe("");
      const envelope = readEnvelope(out);
      expect(envelope.status).toBe("fail");
      expect(envelope.error.class).toBe("missing_argument");
      expect(envelope.error.message).toContain("validate_family");
      expect(envelope.error.valid_values).toBeDefined();
      expect(envelope.error.example).toBeDefined();
    });

    it("emits JSON when no family is given and returns rc 2", () => {
      const { rc, out, err } = capture((io) =>
        main(["node", "agentera", "check", "validate"], io),
      );
      expect(rc).toBe(2);
      expect(err).toBe("");
      expect(readEnvelope(out).error).toMatchObject({ class: "missing_argument" });
    });

    it("emits the envelope in json mode for an unsupported family and returns rc 2", () => {
      const { rc, out, err } = capture((io) =>
        main(
          ["node", "agentera", "check", "validate", "bogus", "--format", "json"],
          io,
        ),
      );
      expect(rc).toBe(2);
      expect(err).toBe("");
      const envelope = readEnvelope(out);
      expect(envelope.status).toBe("fail");
      expect(envelope.error.class).toBe("unsupported_target");
      expect(envelope.error.message).toContain("bogus");
    });

    it("emits JSON for an invalid --format choice and returns rc 2", () => {
      const { rc, out, err } = capture((io) =>
        main(
          ["node", "agentera", "check", "validate", "--format", "xml"],
          io,
        ),
      );
      expect(rc).toBe(2);
      expect(err).toBe("");
      expect(readEnvelope(out).error).toMatchObject({ class: "invalid_choice", valid_values: ["json"] });
    });
  });

  describe("oracle contract pinning", () => {
    it("matches the helper's emitted shape for a minimal body", () => {
      const sample: InvalidInputEnvelope = {
        schemaVersion: "agentera.invalidInputEnvelope.v2",
        status: "fail",
        error: {
          class: "missing_argument",
          message: "x",
          recovery: "Correct the input and retry; no state was changed.",
        },
      };
      for (const k of ORACLE.requiredTopLevelKeys) {
        expect(sample).toHaveProperty(k);
      }
      for (const k of ORACLE.requiredErrorKeys) {
        expect(sample.error).toHaveProperty(k);
      }
    });

    it("declares a fixed set of error classes", () => {
      const liveClasses = {
        missing_argument: true,
        invalid_choice: true,
        unrecognized_argument: true,
        mutually_exclusive: true,
        invalid_int: true,
        invalid_format: true,
        unsupported_target: true,
        schema_violation: true,
      conflict: true,
      invalid_receipt: true,
      } satisfies Record<InvalidInputErrorClass, true>;
      expect(new Set(ORACLE.errorClassUnion)).toEqual(new Set(Object.keys(liveClasses)));
    });

    it("pins the text-mode header order", () => {
      expect(ORACLE.textMode.headerLines[0]).toMatch(/^What happened:/);
      expect(ORACLE.textMode.headerLines[1]).toMatch(/^What the preview did:/);
      expect(ORACLE.textMode.headerLines[2]).toMatch(/^What the recommended fix will do:/);
      expect(ORACLE.textMode.headerLines[3]).toMatch(/^What it will not do:/);
    });

    it("declares the exit code as 2", () => {
      expect(ORACLE.exitCode).toBe(2);
      expect(ORACLE.textMode.exitCode).toBe(2);
    });

    it("declares the format as json", () => {
      expect(ORACLE.format).toBe("json");
      expect(ORACLE.statusValue).toBe("fail");
    });
  });
});
