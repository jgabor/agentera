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
