import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import config from "../../../../vite.config.js";

const vp = resolve(import.meta.dirname, "../../../../node_modules/.bin/vp");

describe("formatter check", () => {
  it("includes all maintained source", () => {
    expect(config.fmt?.ignorePatterns).toContain("packages/cli/test/**/fixtures/**");
  });

  it("accepts clean input and rejects formatting drift", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentera-formatter-"));
    const clean = join(directory, "clean.ts");
    const drifted = join(directory, "drifted.ts");

    writeFileSync(clean, 'const value = "clean";\n');
    writeFileSync(drifted, "const value='drifted'\n");

    expect(() => execFileSync(vp, ["fmt", "--check", clean])).not.toThrow();
    expect(spawnSync(vp, ["fmt", "--check", drifted]).status).not.toBe(0);
  });
});
