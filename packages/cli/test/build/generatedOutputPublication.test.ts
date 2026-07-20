import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// The publisher is an executable ESM script so package construction can run
// before checkout dist exists.
import { publishGeneratedSurfaces } from "../../scripts/build-package.mjs";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-generated-publication-test-"));
  roots.push(root);
  return root;
}

function writeSurface(root: string, name: "dist" | "bundle", token: string): void {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, "generation.txt"), `${token}\n`);
}

function readSurface(root: string, name: "dist" | "bundle"): string {
  return fs.readFileSync(path.join(root, name, "generation.txt"), "utf8").trim();
}

function waitForFile(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = (): void => {
      if (fs.existsSync(file)) resolve();
      else if (Date.now() >= deadline) reject(new Error(`timed out waiting for ${file}`));
      else setTimeout(poll, 10);
    };
    poll();
  });
}

function worker(packageRoot: string, stagedRoot: string, ready = "", hold = 0): Promise<void> {
  const child = spawn(process.execPath, [
    path.resolve(import.meta.dirname, "../helpers/generatedPublicationWorker.mjs"),
    packageRoot,
    stagedRoot,
    ready,
    String(hold),
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("generated-output publication", () => {
  it("publishes only complete staged dist and bundle directories", () => {
    const packageRoot = tempRoot();
    const stagedRoot = tempRoot();
    writeSurface(packageRoot, "dist", "old");
    writeSurface(packageRoot, "bundle", "old");
    writeSurface(stagedRoot, "dist", "new");
    writeSurface(stagedRoot, "bundle", "new");

    publishGeneratedSurfaces(packageRoot, stagedRoot);

    expect([readSurface(packageRoot, "dist"), readSurface(packageRoot, "bundle")]).toEqual(["new", "new"]);
    expect(fs.existsSync(path.join(packageRoot, ".agentera-generated-publication.json"))).toBe(false);
  });

  it("restores the previous complete result when publication is interrupted", () => {
    const packageRoot = tempRoot();
    const stagedRoot = tempRoot();
    writeSurface(packageRoot, "dist", "old");
    writeSurface(packageRoot, "bundle", "old");
    writeSurface(stagedRoot, "dist", "new");
    writeSurface(stagedRoot, "bundle", "new");

    expect(() => publishGeneratedSurfaces(packageRoot, stagedRoot, { faultAfterSurface: "dist" }))
      .toThrow("injected interruption after dist publication");

    expect([readSurface(packageRoot, "dist"), readSurface(packageRoot, "bundle")]).toEqual(["old", "old"]);
    expect(fs.existsSync(path.join(packageRoot, ".agentera-generated-publication.json"))).toBe(false);
  });

  it("recovers a journaled interrupted publication before retrying", () => {
    const packageRoot = tempRoot();
    const stagedRoot = tempRoot();
    const backupDist = path.join(packageRoot, ".dist.agentera-backup-interrupted");
    const backupBundle = path.join(packageRoot, ".bundle.agentera-backup-interrupted");
    writeSurface(packageRoot, "dist", "partial");
    writeSurface(packageRoot, "bundle", "old");
    writeSurface(stagedRoot, "dist", "recovered");
    writeSurface(stagedRoot, "bundle", "recovered");
    for (const backup of [backupDist, backupBundle]) {
      fs.mkdirSync(backup, { recursive: true });
      fs.writeFileSync(path.join(backup, "generation.txt"), "old\n");
    }
    fs.writeFileSync(path.join(packageRoot, ".agentera-generated-publication.json"), JSON.stringify({
      schemaVersion: "agentera.generatedPublication.v1",
      entries: [
        { surface: "dist", target: path.join(packageRoot, "dist"), staged: "interrupted", backup: backupDist, hadPrevious: true },
        { surface: "bundle", target: path.join(packageRoot, "bundle"), staged: "interrupted", backup: backupBundle, hadPrevious: true },
      ],
    }));

    publishGeneratedSurfaces(packageRoot, stagedRoot);

    expect([readSurface(packageRoot, "dist"), readSurface(packageRoot, "bundle")]).toEqual(["recovered", "recovered"]);
  });

  it("serializes overlapping publishers without mixing generated surfaces", async () => {
    const packageRoot = tempRoot();
    const first = path.join(packageRoot, ".first-stage");
    const second = path.join(packageRoot, ".second-stage");
    const ready = path.join(packageRoot, ".first-ready");
    writeSurface(packageRoot, "dist", "old");
    writeSurface(packageRoot, "bundle", "old");
    writeSurface(first, "dist", "first");
    writeSurface(first, "bundle", "first");
    writeSurface(second, "dist", "second");
    writeSurface(second, "bundle", "second");

    const firstWorker = worker(packageRoot, first, ready, 200);
    await waitForFile(ready);
    const secondWorker = worker(packageRoot, second);
    await Promise.all([firstWorker, secondWorker]);

    const result = [readSurface(packageRoot, "dist"), readSurface(packageRoot, "bundle")];
    expect(result[0]).toBe(result[1]);
    expect(["first", "second"]).toContain(result[0]);
  });
});
