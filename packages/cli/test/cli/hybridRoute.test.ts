import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { runRouteRequest } from "../../src/cli/commands/route.js";

function invoke(input: string, args = ["route", "request", "--input", "-", "--format", "json"]) {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...args], {
    stdin: () => input,
    out: (text) => (out += text),
    err: (text) => (err += text),
  });
  return { rc, out, err };
}

function invokeBytes(input: Buffer, args = ["--input", "-", "--format", "json"]) {
  let out = "";
  let err = "";
  const rc = runRouteRequest(args, {
    stdin: () => input,
    out: (text) => (out += text),
    err: (text) => (err += text),
  });
  return { rc, out, err };
}

describe("route request CLI", () => {
  it("accepts a transient structured request and returns the deterministic selection on stdout", () => {
    const result = invoke("version: agentera.route_request.v1\nrequest: 'help me decide: cache or queue'\n");
    expect(result.rc).toBe(0);
    expect(result.err).toBe("");
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: "agentera.route_response.v1",
      outcome: "deterministic_selection",
      capability: "discuss",
      tier: "phrase",
      topic_span: { start: 14 },
    });
  });

  it("returns a semantic capsule without echoing a non-deterministic private request", () => {
    const privateRequest = "private customer migration 8675309";
    const result = invoke(JSON.stringify({ request: privateRequest }));
    expect(result.rc).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).not.toContain(privateRequest);
    expect(JSON.parse(result.out)).toMatchObject({ outcome: "semantic_required", request_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("rejects argv request text and malformed input without exposing the supplied request", () => {
    const secret = "private request must not be diagnosed";
    const argv = invoke("", ["route", "request", secret, "--format", "json"]);
    expect(argv.rc).toBe(2);
    expect(argv.out).not.toContain(secret);
    expect(argv.err).toBe("");

    const malformed = invoke(`request: ${secret}\nunsupported: true\n`);
    expect(malformed.rc).toBe(2);
    expect(malformed.out).not.toContain(secret);
    expect(malformed.err).toBe("");
  });

  it("rejects invalid UTF-8 from stdin and files before parsing without exposing bytes", () => {
    const invalid = Buffer.from([0x72, 0x65, 0x71, 0x75, 0x65, 0x73, 0x74, 0x3a, 0x20, 0xff]);
    const stdin = invokeBytes(invalid);
    expect(stdin.rc).toBe(2);
    expect(stdin.err).toBe("");
    expect(JSON.parse(stdin.out)).toMatchObject({ error: { class: "invalid_format" } });
    expect(stdin.out).not.toContain("�");

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentera-route-input-")), "request.yaml");
    try {
      fs.writeFileSync(file, invalid);
      const fromFile = invokeBytes(Buffer.alloc(0), ["--input", file, "--format", "json"]);
      expect(fromFile.rc).toBe(2);
      expect(fromFile.err).toBe("");
      expect(JSON.parse(fromFile.out)).toMatchObject({ error: { class: "invalid_format" } });
      expect(fromFile.out).not.toContain("�");
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});
