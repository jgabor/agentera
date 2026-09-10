import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PNPM_REFERENCE, verifiedCorepackBytes } from "../../scripts/bootstrap-integrity.mjs";

describe("bootstrap integrity prerequisites", () => {
  it("binds the selected pnpm version to the reviewed tarball digest", () => {
    const integrity = "yWHR4KLY41TsqlFmuCJRZmi39Ey1vZUSLVkN2Bki9gb1RzttI+xKW+Bef80Y6EiNR9l4u+mBhy8RRdBumnQAFw==";
    expect(PNPM_REFERENCE).toBe(`pnpm@10.30.3+sha512.${Buffer.from(integrity, "base64").toString("hex")}`);
  });

  it("rejects altered and missing host Corepack without executing it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-prerequisite-"));
    try {
      const file = path.join(root, "corepack.cjs");
      const marker = path.join(root, "executed");
      fs.writeFileSync(file, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`);
      expect(() => verifiedCorepackBytes(file)).toThrow("host Corepack integrity mismatch");
      expect(() => verifiedCorepackBytes(path.join(root, "missing.cjs"))).toThrow(/ENOENT/);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
