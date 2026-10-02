import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { PNPM_REFERENCE, VP_ARCHIVE_SHA256, VP_ARCHIVE_URL, activateBootstrap, prepareBootstrap, provisionVpArchive, verifiedVpArchive } from "../../scripts/bootstrap-integrity.mjs";

describe("bootstrap integrity prerequisites", () => {
  it("binds pnpm and native Vite+ to reviewed release digests", () => {
    const integrity = "yWHR4KLY41TsqlFmuCJRZmi39Ey1vZUSLVkN2Bki9gb1RzttI+xKW+Bef80Y6EiNR9l4u+mBhy8RRdBumnQAFw==";
    expect(PNPM_REFERENCE).toBe(`pnpm@10.30.3+sha512.${Buffer.from(integrity, "base64").toString("hex")}`);
    expect(VP_ARCHIVE_SHA256).toBe("2adca8386c8f7e158eea4abe1a3eda9f89313c869145f788409a0be45979dd6a");
  });

  it("rejects altered and missing native archives before extraction or execution", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-prerequisite-"));
    try {
      const file = path.join(root, "vp.tgz");
      fs.writeFileSync(file, "unverified native code");
      expect(() => verifiedVpArchive(fs.readFileSync(file))).toThrow("Vite+ archive integrity mismatch");
      expect(() => prepareBootstrap(root, file)).toThrow("Vite+ archive integrity mismatch");
      expect(() => prepareBootstrap(root, path.join(root, "missing.tgz"))).toThrow(/ENOENT/);
      expect(fs.readdirSync(root)).toEqual(["vp.tgz"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed without extracting altered bytes or retrying unavailable inputs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vp-provision-"));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("altered archive"))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(provisionVpArchive(root)).rejects.toThrow("Vite+ archive integrity mismatch");
      await expect(provisionVpArchive(root)).rejects.toThrow("Vite+ download failed: 503");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls.every(([url]) => url === VP_ARCHIVE_URL)).toBe(true);
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects project pin drift before launching managed project commands", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-pin-"));
    const execute = vi.fn();
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@latest" }));
      await expect(activateBootstrap({ execute }, root)).rejects.toThrow("project packageManager pin rejected");
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.30.3" }));
      fs.writeFileSync(path.join(root, ".node-version"), "24.20.0\n");
      await expect(activateBootstrap({ execute }, root)).rejects.toThrow("project Node pin rejected");
      expect(execute).not.toHaveBeenCalled();
      fs.writeFileSync(path.join(root, ".npmrc"), "registry=https://untrusted.invalid\n");
      await expect(activateBootstrap({ execute }, root)).rejects.toThrow("project .npmrc is not allowed");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
