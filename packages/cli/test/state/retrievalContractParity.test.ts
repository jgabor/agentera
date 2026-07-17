import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { capabilityContext } from "../../src/cli/capabilityContext/contract.js";
import { buildSchemaPayload } from "../../src/cli/commands/schema.js";
import { main } from "../../src/cli/dispatch.js";
import { printStateHelp } from "../../src/cli/help.js";
import { entityPublicRetrieval } from "../../src/state/retrievalAuthority.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const roots: string[] = [];

function cutoverProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retrieval-contract-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  return root;
}

function capture(root: string, argv: string[]): { rc: number; out: string; err: string } {
  const previous = process.cwd();
  let out = "";
  let err = "";
  process.chdir(root);
  try {
    const rc = main(["node", "agentera", ...argv], { out: (text) => { out += text; }, err: (text) => { err += text; } });
    return { rc, out, err };
  } finally {
    process.chdir(previous);
  }
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("final entity retrieval public-contract parity", () => {
  it("projects the authority-owned final ID grammar through schema", () => {
    const authority = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "references/artifacts/state-storage-authority.yaml"), "utf8"));
    const retrieval = entityPublicRetrieval(REPO_ROOT);
    expect(retrieval).toEqual(authority.entity_target.public_retrieval);
    expect(buildSchemaPayload("schema").state_retrieval).toEqual({
      authority: "references/artifacts/state-storage-authority.yaml",
      ...retrieval,
    });
    expect(JSON.stringify(retrieval.commands)).toContain("--id ID");
    expect(JSON.stringify(retrieval.commands)).not.toMatch(/--(?:number|task|plan)\b/);
  });

  it("keeps help and served capability instructions on bare canonical IDs", () => {
    const surfaces = [printStateHelp("plan"), printStateHelp("experiments"), ...Object.values(CAPABILITY_INSTRUCTIONS)].join("\n");
    expect(surfaces).toContain("--id ID");
    expect(surfaces).not.toMatch(/--(?:number|task)\s+[A-Z]/);
    expect(printStateHelp("plan")).toContain("Only the displayed bare-ID selectors are accepted");
  });

  it("projects only final entity retrieval commands into capability startup context", () => {
    const plan = capabilityContext("plan")?.retrieval_contract as Record<string, any>;
    const optimize = capabilityContext("optimize")?.retrieval_contract as Record<string, any>;
    expect(plan).toMatchObject({ status: "final", commands: { plans: { get: expect.stringContaining("--id ID") }, plan_tasks: { get: expect.stringContaining("--id ID") } } });
    expect(optimize).toMatchObject({ status: "final", commands: { experiments: { get: expect.stringContaining("--id ID") } } });
    expect(JSON.stringify({ plan, optimize })).not.toMatch(/--(?:number|task|plan)\b/);
  });

  it("returns bounded structured corrections after the cutover gate", () => {
    const root = cutoverProject();
    for (const argv of [
      ["state", "plan", "show", "--format", "json"],
      ["state", "experiments", "show", "--format", "json"],
      ["state", "plan", "list", "--cursor", "not-a-cursor", "--format", "json"],
    ]) {
      const result = capture(root, argv);
      expect([1, 2]).toContain(result.rc);
      expect(result.err).toBe("");
      const payload = JSON.parse(result.out);
      expect(payload).toMatchObject({ status: "fail", error: { class: expect.any(String), recovery: expect.any(String) } });
      expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(4096);
    }
  });
});
