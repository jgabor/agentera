import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

const VOLATILE_TODO_LINE = /TODO line \d+/;
const VOLATILE_TODO_MD_LINE = /TODO\.md:\d+/;

function listActiveAgenteraYamlFiles(root: string): string[] {
  const agenteraDir = path.join(root, ".agentera");
  if (!fs.existsSync(agenteraDir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(agenteraDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
      continue;
    }
    files.push(path.join(agenteraDir, entry.name));
  }
  return files;
}

function scanVolatileTodoRefs(root: string): string[] {
  const violations: string[] = [];
  for (const filePath of listActiveAgenteraYamlFiles(root)) {
    const rel = path.relative(root, filePath);
    const content = fs.readFileSync(filePath, "utf8");
    for (const pattern of [VOLATILE_TODO_LINE, VOLATILE_TODO_MD_LINE]) {
      const match = content.match(pattern);
      if (match) {
        violations.push(`${rel}: ${match[0]}`);
      }
    }
  }
  return violations;
}

describe("active .agentera artifacts avoid volatile TODO line-number refs (#42)", () => {
  it("pass: repo active artifacts use stable TODO cross-references", () => {
    expect(scanVolatileTodoRefs(REPO_ROOT)).toEqual([]);
  });

  it("fail: scan flags volatile TODO line-number refs in active artifacts", () => {
    const tmp = fs.mkdtempSync(path.join(__dirname, "volatile-todo-"));
    try {
      const agenteraDir = path.join(tmp, ".agentera");
      fs.mkdirSync(agenteraDir, { recursive: true });
      fs.writeFileSync(
        path.join(agenteraDir, "progress.yaml"),
        "cycles:\n  - discovered: pre-existing issue (TODO line 13)\n",
      );
      expect(scanVolatileTodoRefs(tmp)).toContain(
        ".agentera/progress.yaml: TODO line 13",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
