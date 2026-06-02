import { describe, expect, it } from "vitest";

import { buildSchemaPayload, cmdSchema } from "../../src/cli/commands/schema.js";
import { main } from "../../src/cli/dispatch.js";

function capture(fn: (io: { out: (t: string) => void; err: (t: string) => void }) => number): {
  rc: number;
  out: string;
  err: string;
} {
  let out = "";
  let err = "";
  const rc = fn({ out: (t) => (out += t), err: (t) => (err += t) });
  return { rc, out, err };
}

describe("cli schema", () => {
  it("builds a schema payload against the repo", () => {
    const payload = buildSchemaPayload("schema");
    expect(payload.schemaVersion).toBe("agentera.schema.v1");
    expect(payload.command).toBe("schema");
    expect(["ok", "incomplete"]).toContain(payload.status);
    expect(Array.isArray(payload.commands)).toBe(true);
    expect(payload.routine_state_commands).toContain("plan");
    expect(payload.doctor.signal_kinds).toContain("cli_probe_failed");
    expect(Array.isArray(payload.artifact_schemas)).toBe(true);
    expect(payload.artifact_locations.schemaVersion).toBe("agentera.artifact_locations.v1");
  });

  it("emits JSON by default and returns 0", () => {
    const { rc, out } = capture((io) => cmdSchema({}, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.schemaVersion).toBe("agentera.schema.v1");
  });

  it("describes the prime/hej commands with their structured fields", () => {
    const payload = buildSchemaPayload("schema");
    const prime = (payload.commands as Array<{ name: string; structured_fields: string[] }>).find(
      (c) => c.name === "prime",
    );
    expect(prime?.structured_fields).toContain("capability_context");
    const lint = (payload.commands as Array<{ name: string; output_formats: string[] }>).find((c) => c.name === "lint");
    expect(lint?.output_formats).toEqual(["text", "json"]);
  });
});

describe("cli dispatch: schema/describe routing", () => {
  it("routes schema", () => {
    const { rc } = capture((io) => main(["node", "agentera", "schema", "--format", "json"], io));
    expect(rc).toBe(0);
  });

  it("emits a deprecation alias for describe", () => {
    const { err } = capture((io) => main(["node", "agentera", "describe", "--format", "json"], io));
    expect(err).toContain("Deprecation: agentera describe is deprecated; use agentera schema");
  });

  it("rejects an invalid --format choice", () => {
    const { rc, out, err } = capture((io) => main(["node", "agentera", "schema", "--format", "text"], io));
    expect(rc).toBe(2);
    // runSchema defaults format to "json", so the invalid --format rejection
    // emits the canonical JSON envelope to stdout and the four-question text
    // template would not appear on stderr in this default mode.
    expect(err).toBe("");
    const envelope = JSON.parse(out);
    expect(envelope.status).toBe("fail");
    expect(envelope.error.class).toBe("invalid_choice");
    expect(envelope.error.message).toContain("invalid choice");
  });
});
