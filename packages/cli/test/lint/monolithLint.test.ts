import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(__dirname, "../../src");
const LINE_LIMIT = 1000;

/** Pending T2 splits — shrink as each monolith lands; not a permanent escape hatch.
 *  All T2 splits landed; the set is now empty and will be removed at T11. */
const PENDING_T2_MONOLITHS = new Set<string>([
  // empty — all 8 plan-listed monoliths and the 9th (cli/dispatch.ts) are split
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
        const rel = path.relative(SRC_ROOT, file);
        if (PENDING_T2_MONOLITHS.has(rel)) continue;
        offenders.push({ file: rel, lines });
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
