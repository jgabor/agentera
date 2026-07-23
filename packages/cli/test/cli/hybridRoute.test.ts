import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";

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
});
