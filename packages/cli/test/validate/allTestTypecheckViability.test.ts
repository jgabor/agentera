import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { verifyEvidence } from "../../scripts/verify-all-test-typecheck-evidence.mjs";

describe("all-test typecheck viability evidence", () => {
  it("replays the isolated measurement and compiled classifications", () => expect(verifyEvidence()).toEqual([]));

  for (const [name, mutate] of Object.entries({
    input: (dir: string) => fs.appendFileSync(path.join(dir, "package.json"), " "),
    config: (dir: string) => fs.appendFileSync(path.join(dir, "tsconfig.json"), " "),
    output: (dir: string) => fs.appendFileSync(path.join(dir, "compiler.normalized.json"), " "),
    digest: (dir: string) => fs.writeFileSync(path.join(dir, "manifest.sha256"), `${"0".repeat(64)}\n`),
    tool: (dir: string) => {
      const file = path.join(dir, "manifest.json");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("vite-plus@0.3.0", "vite-plus@0.3.1"));
    },
    source: (dir: string) => fs.appendFileSync(path.join(dir, "source-binding.json"), " "),
  })) {
    it(`fails closed on ${name} tampering`, () => {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-type-tamper-"));
      try {
        fs.cpSync(path.resolve("test/evidence/all-test-typecheck-replay"), temp, { recursive: true });
        mutate(temp);
        expect(verifyEvidence({ directory: temp, replay: false })).not.toEqual([]);
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    });
  }
});
