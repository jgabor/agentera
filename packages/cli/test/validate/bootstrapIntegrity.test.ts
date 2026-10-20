import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { NODE_VERSION, PNPM_REFERENCE, VP_ARCHIVE_SHA256, VP_ARCHIVE_URL, VP_LAUNCHER_PATTERN, VP_LOCAL_PATTERN, VP_VERSION, activateBootstrap, prepareBootstrap, provisionVpArchive, verifiedVpArchive } from "../../scripts/bootstrap-integrity.mjs";
import { LAUNCHER_DEPENDENT_RESULTS, VP_LAUNCHER_RANGE, classifyLauncher } from "../../scripts/launcher-range.mjs";

const [major, minor, patch] = VP_VERSION.split(".").map(Number);
// Real launcher output, including the distribution-packaged build: one launcher
// line followed by the root-local block.
const versionOutput = (launcher: string) => `vp v${launcher}\n\nLocal vite-plus:\n  vite-plus  v${VP_VERSION}\n`;

describe("bootstrap integrity prerequisites", () => {
  it("binds pnpm and native Vite+ to reviewed release digests", () => {
    const integrity = "yWHR4KLY41TsqlFmuCJRZmi39Ey1vZUSLVkN2Bki9gb1RzttI+xKW+Bef80Y6EiNR9l4u+mBhy8RRdBumnQAFw==";
    expect(PNPM_REFERENCE).toBe(`pnpm@10.30.3+sha512.${Buffer.from(integrity, "base64").toString("hex")}`);
    expect(VP_ARCHIVE_SHA256).toBe("3fb3a668472e1312eedd7598b3f6c511acebc2f6497c293a5ee04eba248eee7e");
    expect(VP_ARCHIVE_URL).toBe(`https://github.com/voidzero-dev/vite-plus/releases/download/v${VP_VERSION}/vp-x86_64-unknown-linux-gnu.tar.gz`);
  });

  it("binds the CI bootstrap to only the pinned standalone launcher and root-local Vite+ versions", () => {
    expect(VP_LAUNCHER_PATTERN.test(`vp v${VP_VERSION}\n`)).toBe(true);
    expect(VP_LAUNCHER_PATTERN.test(`vp v${VP_VERSION}1\n`)).toBe(false);
    expect(VP_LOCAL_PATTERN.test(`Local vite-plus:\n  vite-plus  v${VP_VERSION}\n`)).toBe(true);
    expect(VP_LOCAL_PATTERN.test(`Local vite-plus:\n  vite-plus  v${VP_VERSION}.1\n`)).toBe(false);
  });

  it("derives the contributor launcher range from the pin", () => {
    expect(VP_LAUNCHER_RANGE).toBe(`>=${VP_VERSION} <${major + 1}.0.0`);
  });

  it("qualifies the pinned launcher and accepts a newer stable same-major launcher as unqualified", () => {
    expect(classifyLauncher(versionOutput(VP_VERSION))).toMatchObject({ status: "qualified", version: VP_VERSION });
    for (const newer of [`${major}.${minor}.${patch + 1}`, `${major}.${minor + 1}.0`, `${major}.${minor + 7}.0`]) {
      const result = classifyLauncher(versionOutput(newer));
      expect(result).toMatchObject({ status: "accepted_unqualified", version: newer, unqualifiedResults: LAUNCHER_DEPENDENT_RESULTS });
      expect(result.message).toContain(`only ${VP_VERSION} is qualified`);
      for (const item of LAUNCHER_DEPENDENT_RESULTS) expect(result.message).toContain(item);
      expect(result.message).not.toMatch(/downgrade|rejected|Use a stable/i);
    }
  });

  it.each([
    ["older same-major", patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${minor - 1}.0`],
    ["prerelease of a newer version", `${major}.${minor + 1}.0-rc.0`],
    ["prerelease of the pin", `${VP_VERSION}-beta.1`],
    ["build-tagged pin", `${VP_VERSION}+distro`],
    ["previous major", `${major - 1}.9.0`],
    ["next major", `${major + 1}.0.0`],
    ["later major", `${major + 1}.${minor + 1}.0`],
  ])("rejects a %s launcher with recovery naming the pin and the range", (_name, version) => {
    const result = classifyLauncher(versionOutput(version));
    expect(result).toMatchObject({ status: "rejected", version });
    expect(result.message).toContain(`accepted range ${VP_LAUNCHER_RANGE}; only the official ${VP_VERSION} release asset is qualified`);
  });

  it("rejects output without a launcher line", () => {
    for (const output of ["", `Local vite-plus:\n  vite-plus  v${VP_VERSION}\n`, `vp ${VP_VERSION}\n`]) expect(classifyLauncher(output).status).toBe("rejected");
  });

  it("keeps the CI bootstrap exact: a newer accepted contributor launcher is still rejected", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-launcher-"));
    const newer = `${major}.${minor + 1}.0`;
    const execute = vi.fn(async () => versionOutput(newer));
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.30.3" }));
      fs.writeFileSync(path.join(root, ".node-version"), `${NODE_VERSION}\n`);
      expect(classifyLauncher(versionOutput(newer)).status).toBe("accepted_unqualified");
      await expect(activateBootstrap({ execute, home: root }, root)).rejects.toThrow("standalone Vite+ pin rejected");
      expect(execute.mock.calls).toEqual([[["--version"], root]]);
      execute
        .mockImplementationOnce(async () => versionOutput(VP_VERSION))
        .mockImplementationOnce(async () => {
          throw new Error("past the launcher check");
        });
      await expect(activateBootstrap({ execute, home: root }, root)).rejects.toThrow("past the launcher check");
      expect(execute.mock.calls[2]).toEqual([["env", "on"], root]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
