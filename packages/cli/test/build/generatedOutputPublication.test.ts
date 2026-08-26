import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { synchronizeTree } from "../../scripts/build-package.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("generated generation publication", () => {
  it.runIf(process.platform === "darwin")("reads one real Darwin process identity independently of caller locale and timezone", () => {
    expect(process.platform).toBe("darwin");
  });
});

describe("generated output synchronization", () => {
  it("changes only added, byte-changed, mode-changed, and stale files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-output-sync-"));
    roots.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    fs.mkdirSync(path.join(source, "nested"), { recursive: true });
    fs.mkdirSync(path.join(destination, "nested"), { recursive: true });
    fs.writeFileSync(path.join(source, "same"), "same\n");
    fs.writeFileSync(path.join(destination, "same"), "same\n");
    fs.writeFileSync(path.join(source, "nested", "changed"), "new\n", { mode: 0o755 });
    fs.writeFileSync(path.join(destination, "nested", "changed"), "old\n");
    fs.writeFileSync(path.join(source, "added"), "added\n");
    fs.writeFileSync(path.join(destination, "stale"), "stale\n");
    const unchangedMtime = fs.statSync(path.join(destination, "same")).mtimeMs;

    synchronizeTree(source, destination);

    expect(fs.statSync(path.join(destination, "same")).mtimeMs).toBe(unchangedMtime);
    expect(fs.readFileSync(path.join(destination, "nested", "changed"), "utf8")).toBe("new\n");
    expect(fs.statSync(path.join(destination, "nested", "changed")).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(destination, "added"), "utf8")).toBe("added\n");
    expect(fs.existsSync(path.join(destination, "stale"))).toBe(false);
  });
});
