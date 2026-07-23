import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { runRouteReceipt, runRouteRequest } from "../../src/cli/commands/route.js";
import { BOOTSTRAP_SOURCE_ROOT_ENV } from "../../src/core/sourceRoot.js";

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

function invokeReceipt(input: string) {
  let out = "";
  let err = "";
  const rc = runRouteReceipt(["--input", "-", "--format", "json"], {
    stdin: () => input,
    out: (text) => (out += text),
    err: (text) => (err += text),
  });
  return { rc, out, err };
}

function semanticCapsuleDigest(request: string): string {
  const result = invoke(JSON.stringify({ request }));
  expect(result.rc).toBe(0);
  const response = JSON.parse(result.out);
  expect(response.outcome).toBe("semantic_required");
  return response.semantic_capsule_sha256;
}

function withWrongCorpusExpectation<T>(run: () => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-route-cli-evaluation-"));
  const previousSourceRoot = process.env[BOOTSTRAP_SOURCE_ROOT_ENV];
  try {
    for (const directory of ["fixtures", "references", "skills"]) {
      fs.cpSync(path.join(path.resolve(import.meta.dirname, "../../../.."), directory), path.join(root, directory), { recursive: true });
    }
    const corpusPath = path.join(root, "fixtures/routing/hybrid-corpus.yaml");
    fs.writeFileSync(corpusPath, fs.readFileSync(corpusPath, "utf8").replace(
      "id: DEV-PHRASE-STATUS, partition: development, request: \"show project briefing for the checkout\", expected: { phase1: deterministic_selection, tier: phrase, capability: status }",
      "id: DEV-PHRASE-STATUS, partition: development, request: \"show project briefing for the checkout\", expected: { phase1: deterministic_selection, tier: phrase, capability: vision }",
    ));
    process.env[BOOTSTRAP_SOURCE_ROOT_ENV] = root;
    return run();
  } finally {
    if (previousSourceRoot === undefined) delete process.env[BOOTSTRAP_SOURCE_ROOT_ENV];
    else process.env[BOOTSTRAP_SOURCE_ROOT_ENV] = previousSourceRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
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
    expect(JSON.parse(result.out)).toMatchObject({
      outcome: "semantic_required",
      request_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      semantic_capsule_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
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

describe("route receipt CLI", () => {
  it("returns selected startup authorization and rejects a malformed receipt without exposing request text", () => {
    const request = "private plan the import 8675309";
    const digest = crypto.createHash("sha256").update(request, "utf8").digest("hex");
    const capsuleDigest = semanticCapsuleDigest(request);
    const selected = invokeReceipt(JSON.stringify({
      request,
      receipt: { version: "agentera.route_receipt.v1", request_sha256: digest, semantic_capsule_sha256: capsuleDigest, outcome: "select", capability: "plan", compound: "none", question: null, remainder_span: null },
    }));
    expect(selected.rc).toBe(0);
    expect(selected.err).toBe("");
    expect(JSON.parse(selected.out)).toMatchObject({ outcome: "selected", capability: "plan", route_provenance: { startup_command: "agentera prime --context plan --format json" } });
    expect(selected.out).not.toContain(request);

    const malformed = invokeReceipt(JSON.stringify({ request, receipt: { outcome: "select", instructions: request } }));
    expect(malformed.rc).toBe(64);
    expect(malformed.err).toBe("");
    expect(JSON.parse(malformed.out)).toMatchObject({ error: { class: "invalid_receipt", recovery: expect.stringContaining("no capability was started") } });
    expect(malformed.out).not.toContain(request);
  });

  it("counts clarification question length in Unicode code points", () => {
    const request = "Which capability should handle this?";
    const digest = crypto.createHash("sha256").update(request, "utf8").digest("hex");
    const capsuleDigest = semanticCapsuleDigest(request);
    const receipt = (question: string) => JSON.stringify({
      request,
      receipt: { version: "agentera.route_receipt.v1", request_sha256: digest, semantic_capsule_sha256: capsuleDigest, outcome: "clarify", capability: null, compound: null, question, remainder_span: null },
    });

    expect(invokeReceipt(receipt("😀".repeat(280))).rc).toBe(0);
    expect(invokeReceipt(receipt("😀".repeat(281))).rc).toBe(64);
  });
});

describe("route evaluation CLI", () => {
  it("emits only the contract-owned visible corpus report", () => {
    const result = invoke("", ["route", "evaluate", "--format", "json"]);
    expect(result.rc).toBe(0);
    expect(result.err).toBe("");
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: "agentera.hybrid_route_evaluation.v1",
      status: "pass",
      latency: { deterministic_phase1: expect.any(Object), receipt_validation: expect.any(Object) },
    });
    expect(result.out).not.toContain("help me decide: cache or queue");
  });

  it("rejects corpus overrides before evaluation", () => {
    const result = invoke("", ["route", "evaluate", "--input", "private-corpus", "--format", "json"]);
    expect(result.rc).toBe(2);
    expect(result.out).not.toContain("private-corpus");
  });

  it("returns the failed report once and exits nonzero for a disposable wrong corpus expectation", () => {
    const result = withWrongCorpusExpectation(() => invoke("", ["route", "evaluate", "--format", "json"]));
    const report = JSON.parse(result.out);

    expect(result.rc).toBe(1);
    expect(result.err).toBe("");
    expect(result.out.match(/agentera\.hybrid_route_evaluation\.v1/g)).toHaveLength(1);
    expect(report).toMatchObject({ status: "fail", aggregate_metrics: { harmful_misroutes: { observed: 1, status: "fail" } } });
    expect(report.results.find((entry: { case_id: string }) => entry.case_id === "DEV-PHRASE-STATUS")).toMatchObject({
      evaluation_tier: "deterministic",
      failure_tier: "deterministic",
      harmful_misroute: true,
    });
  });

  it("makes verify eval routing fail from the same failed evaluation report", () => {
    const result = withWrongCorpusExpectation(() => invoke("", ["check", "verify", "eval", "routing", "--format", "json"]));
    const wrapper = JSON.parse(result.out);

    expect(result.rc).toBe(1);
    expect(result.err).toBe("");
    expect(wrapper).toMatchObject({ status: "fail", target: "routing", engine: { exit_code: 1 } });
    expect(wrapper.diagnostics.stdout.join("\n")).toContain('"status": "fail"');
  });
});
