import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { COREPACK_ARCHIVE_INTEGRITY, PNPM_REFERENCE, provisionCorepack, verifiedCorepackArchive, verifiedCorepackBytes } from "../../scripts/bootstrap-integrity.mjs";

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

  it("rejects downloaded Corepack bytes before archive extraction or execution", () => {
    expect(COREPACK_ARCHIVE_INTEGRITY).toBe("sha512-9BuIGHDFE7Zieor1CeRsvt7X7AJFEuJ6OnbSbsVprq83ChDFoBh1wP98NeUS9FT3ZwlzFllPElXcz/OiDf0YGw==");
    expect(() => verifiedCorepackArchive(Buffer.from("unverified bootstrap"))).toThrow("Corepack archive integrity mismatch");
    expect(() => verifiedCorepackArchive(Buffer.alloc(0))).toThrow("Corepack archive integrity mismatch");
  });

  it("fails closed at provisioning without extracting altered bytes or retrying unavailable inputs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "corepack-provision-"));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("altered archive"))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(provisionCorepack(root)).rejects.toThrow("Corepack archive integrity mismatch");
      await expect(provisionCorepack(root)).rejects.toThrow("Corepack download failed: 503");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls.every(([url]) => url === "https://registry.npmjs.org/corepack/-/corepack-0.35.0.tgz")).toBe(true);
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
