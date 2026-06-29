import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SKILL = path.join(REPO_ROOT, "skills", "agentera", "SKILL.md");

describe("SKILL.md bootstrap contract", () => {
  it("documents agentera prime as the single bootstrap entry point", () => {
    const text = fs.readFileSync(SKILL, "utf8");
    expect(text).toContain("agentera prime");
    expect(text).toContain("Bootstrap");
  });

  it("does not require the host agent to run app-home separately", () => {
    const text = fs.readFileSync(SKILL, "utf8");
    // prime handles app-home internally; the host agent does not need
    // to resolve RESOLVED_AGENTERA_HOME or run agentera app-home as a
    // separate gate step before prime.
    expect(text).not.toContain("RESOLVED_AGENTERA_HOME");
    expect(text).not.toContain("Single-call installed CLI gate");
  });
});
