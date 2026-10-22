import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SKILL = path.join(REPO_ROOT, "skills", "agentera", "SKILL.md");
const SKILL_TEXT = fs.readFileSync(SKILL, "utf8");
const BOOTSTRAP = SKILL_TEXT.slice(SKILL_TEXT.indexOf("\n# agentera\n"));

describe("SKILL.md bootstrap contract", () => {
  it("documents agentera prime as the single bootstrap entry point", () => {
    expect(SKILL_TEXT.indexOf("\n# agentera\n")).toBeGreaterThan(0);
    expect(BOOTSTRAP).toContain("npx -y agentera@next prime --input -");
    expect(BOOTSTRAP).toContain("npx -y agentera@next prime` before you continue");
  });

  it("does not require a separate app-home preflight", () => {
    expect(BOOTSTRAP).not.toContain("agentera app-home");
  });

  it("uses the development channel for every executable v3 CLI example", () => {
    expect(SKILL_TEXT).not.toMatch(/\bagentera (?:prime|route|state|schema|check|upgrade|doctor)\b/);
  });
});
