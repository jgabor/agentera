import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SKILL = path.join(REPO_ROOT, "skills", "agentera", "SKILL.md");

describe("SKILL.md installed CLI gate", () => {
  it("documents the two-step app-home and prime gate", () => {
    const text = fs.readFileSync(SKILL, "utf8");
    expect(text).toContain("Single-call installed CLI gate");
    expect(text).toContain("Resolve `RESOLVED_AGENTERA_HOME` with the app-home precedence");
    expect(text).toContain("agentera app-home");
    expect(text).toContain("Do not substitute");
    expect(text).toContain("Linux-only");
    expect(text).toContain("macOS or");
    expect(text).toContain("Windows");
    expect(text).toContain("Never combine the app-home assignment");
    expect(text).toContain('RESOLVED_AGENTERA_HOME="$(npx -y agentera app-home)"');
  });
});
