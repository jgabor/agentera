import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(__dirname, "../../src");
const LINE_LIMIT = 1000;

/** Remaining plan T2 splits (not T2b); delete entries as each monolith lands. */
const PENDING_T2_MONOLITHS = new Set([
  "analytics/extractCorpus.ts",
  "setup/codex.ts",
  "setup/doctor.ts",
  "state/startupAnalysis.ts",
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
    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  - ${o.file}: ${o.lines} lines`)
        .join("\n");
      throw new Error(
        `monolith lint gate: ${offenders.length} source file(s) exceed ${LINE_LIMIT} lines.\n` +
          `Split each by state family or responsibility. Offenders:\n${detail}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
