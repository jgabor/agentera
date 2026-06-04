import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(__dirname, "../../src");
const LINE_LIMIT = 1000;

/** Pending T2 splits — shrink as each monolith lands; not a permanent escape hatch. */
const PENDING_T2_MONOLITHS = new Set([
  "cli/capabilityContext.ts",
  "cli/dispatch.ts",
  "setup/codex.ts",
  "setup/doctor.ts",
]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("T2 monolith lint gate", () => {
  it("keeps every packages/cli/src/**/*.ts file at or under 1000 lines", () => {
    const offenders: { file: string; lines: number }[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split("\n").length;
      if (lines > LINE_LIMIT) {
        offenders.push({ file: path.relative(SRC_ROOT, file), lines });
      }
    }
    const unexpected = offenders.filter((o) => !PENDING_T2_MONOLITHS.has(o.file));
    if (unexpected.length > 0) {
      const detail = unexpected
        .map((o) => `  - ${o.file}: ${o.lines} lines`)
        .join("\n");
      throw new Error(
        `monolith lint gate: ${unexpected.length} source file(s) exceed ${LINE_LIMIT} lines.\n` +
          `Split each by state family or responsibility (or add only while a T2 slice is in flight). Offenders:\n${detail}`,
      );
    }
    expect(unexpected).toEqual([]);
    for (const path of PENDING_T2_MONOLITHS) {
      const hit = offenders.find((o) => o.file === path);
      expect(hit, `expected pending monolith still over limit: ${path}`).toBeTruthy();
    }
  });
});
