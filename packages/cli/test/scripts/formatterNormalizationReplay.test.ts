import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../../..");
const verifier = path.join(root, "packages/cli/scripts/verify-formatter-normalization.mjs");
const authority = path.join(root, "packages/cli/test/evidence/formatter-normalization-replay.json");
const generatedOverlapOffline = process.env.AGENTERA_OFFLINE === "1" && Boolean(process.env.AGENTERA_ACTIVATION_SOURCE_EVIDENCE_OUTPUT);

function verify(manifest = authority) {
  return spawnSync(process.execPath, [verifier, ...(generatedOverlapOffline ? ["--static"] : []), "--manifest", manifest], { cwd: root, encoding: "utf8" });
}

function resign(manifest: Record<string, unknown>) {
  const copy = structuredClone(manifest);
  delete copy.manifestSha256;
  manifest.manifestSha256 = createHash("sha256")
    .update(`${JSON.stringify(copy, null, 2)}\n`)
    .digest("hex");
}

describe("formatter normalization replay", () => {
  it("replays the integrity-bound formatter result", () => {
    expect(verify().status).toBe(0);
  }, 120_000);

  it("tracks every substantive path with an owner and rationale", () => {
    const manifest = JSON.parse(fs.readFileSync(authority, "utf8"));
    expect(manifest.equivalence.authorizedSubstantive).toHaveLength(22);
    expect(manifest.equivalence.authorizedSubstantive.every((entry: any) => entry.path && entry.owner && entry.rationale)).toBe(true);
  });

  it.each(["input", "output", "digest", "allowlist", "closeout"])("rejects altered %s evidence", (kind) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formatter-replay-tamper-"));
    const manifest = JSON.parse(fs.readFileSync(authority, "utf8"));
    if (kind === "input") manifest.inputs[0].sha256 = "0".repeat(64);
    if (kind === "output") manifest.inputs[0].outputSha256 = "0".repeat(64);
    if (kind === "digest") manifest.manifestSha256 = "0".repeat(64);
    if (kind === "allowlist") manifest.equivalence.authorizedSubstantive[0].owner = "self-declared";
    if (kind === "closeout") manifest.closeout.gates[0].command = ["true"];
    if (kind !== "digest") resign(manifest);
    const target = path.join(directory, "manifest.json");
    fs.writeFileSync(target, JSON.stringify(manifest));
    try {
      expect(verify(target).status).not.toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
