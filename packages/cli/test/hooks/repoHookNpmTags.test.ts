import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** Bare `npx -y agentera` without an npm dist-tag resolves to v2 @latest, not v3 @next. */
const BARE_NPX_AGENTERA = /npx -y agentera(?![@])/;

function listRepoHookFiles(): string[] {
  const roots = [
    path.join(REPO_ROOT, "hooks"),
    path.join(REPO_ROOT, ".cursor"),
    path.join(REPO_ROOT, ".github", "hooks"),
  ];
  const files: string[] = [];
  for (const root of roots) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(path.join(root, entry.name));
      }
    }
  }
  return files.sort();
}

/** v3 hook commands use `npx -y agentera@next` or bare `npx -y agentera` (after tag unification). */
const V3_HOOK_ENTRYPOINT = /npx -y agentera(?:@next)?\s+hook\b/;

describe("repo hook npm tags (B5 task 1, defect #23)", () => {
  it("uses npx -y agentera@next in every repo hook file (no bare npx -y agentera)", () => {
    const violations: string[] = [];
    for (const file of listRepoHookFiles()) {
      const text = fs.readFileSync(file, "utf8");
      if (BARE_NPX_AGENTERA.test(text)) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("repo hook descriptions (B5 task 3, defect #26)", () => {
  it('does not claim "v2" in description when commands invoke the v3 agentera hook entrypoint', () => {
    const violations: string[] = [];
    for (const file of listRepoHookFiles()) {
      const text = fs.readFileSync(file, "utf8");
      if (!V3_HOOK_ENTRYPOINT.test(text)) {
        continue;
      }
      const parsed = JSON.parse(text) as { description?: unknown };
      const description =
        typeof parsed.description === "string" ? parsed.description : "";
      if (/\bv2\b/i.test(description)) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });
});
