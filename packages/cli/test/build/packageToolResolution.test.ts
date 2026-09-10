import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

it("constructs with vp and the installed compiler without bare pnpm, and fails without vp", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-build-tools-"));
  try {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.symlinkSync(fs.realpathSync(path.join(packageRoot, "node_modules/vite-plus/bin/vp")), path.join(bin, "vp"));
    // Keep the system utilities used by installed pnpm binary wrappers, not pnpm itself.
    for (const tool of ["git", "sed", "dirname", "uname"]) {
      const executable = (process.env.PATH ?? "")
        .split(path.delimiter)
        .map((entry) => path.join(entry, tool))
        .find((entry) => {
          try {
            fs.accessSync(entry, fs.constants.X_OK);
            return true;
          } catch {
            return false;
          }
        });
      expect(executable, `installed ${tool} is required`).toBeDefined();
      fs.symlinkSync(fs.realpathSync(executable!), path.join(bin, tool));
    }
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
    const env = { ...process.env, PATH: bin };
    expect(spawnSync("pnpm", ["--version"], { env }).error).toMatchObject({ code: "ENOENT" });
    const build = () =>
      spawnSync(process.execPath, ["scripts/build-package.mjs", "--output-root", path.join(root, "package")], {
        cwd: packageRoot,
        env,
        encoding: "utf8",
        timeout: 120_000,
      });
    const result = build();
    expect(result.status, result.stderr).toBe(0);
    fs.accessSync(path.join(root, "package/dist/bin/agentera.js"), fs.constants.X_OK);
    expect(fs.existsSync(path.join(root, "package/node_modules"))).toBe(false);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "missing-compiler", private: true }));
    const missingCompiler = spawnSync("vp", ["exec", "tsc", "--version"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(missingCompiler.error).toBeUndefined();
    expect(missingCompiler.status, missingCompiler.stderr).toBe(1);
    expect(`${missingCompiler.stdout}${missingCompiler.stderr}`).toMatch(/tsc/);
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);
    fs.unlinkSync(path.join(bin, "vp"));
    const missing = build();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("spawnSync vp ENOENT");
    expect(fs.existsSync(path.join(root, "package/node_modules"))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
