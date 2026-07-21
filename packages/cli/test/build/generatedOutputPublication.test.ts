import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupGeneratedState,
  GENERATED_RETENTION_LIMIT,
  legacyPublicationLockPath,
  pinGeneratedGeneration,
  publishGeneratedGeneration,
  selectGeneratedGeneration,
  writeGenerationIdentity,
} from "../../scripts/generated-output.mjs";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-generated-publication-test-"));
  roots.push(root);
  return root;
}

function stage(root: string, id: string): string {
  const staged = path.join(root, `.stage-${id}`);
  for (const surface of ["dist", "bundle"]) {
    fs.mkdirSync(path.join(staged, surface), { recursive: true });
    fs.writeFileSync(path.join(staged, surface, "generation.txt"), `${id}\n`);
  }
  writeGenerationIdentity(staged, id);
  return staged;
}

function selectedTokens(root: string): string[] {
  const selected = selectGeneratedGeneration(root);
  return ["dist", "bundle"].map((surface) =>
    fs.readFileSync(path.join(selected.root, surface, "generation.txt"), "utf8").trim());
}

function waitFor(check: () => boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = (): void => {
      if (check()) resolve();
      else if (Date.now() >= deadline) reject(new Error(`timed out waiting for ${label}`));
      else setTimeout(poll, 10);
    };
    poll();
  });
}

function worker(script: string, args: string[]): { done: Promise<void> } {
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../helpers", script), ...args], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  return {
    done: new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(legacyPublicationLockPath(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("generated generation publication", () => {
  it("selects one validated generation for both surfaces", () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "first"), "first");
    expect(selectedTokens(root)).toEqual(["first", "first"]);
  });

  it.each([
    ["after-validation", "old"],
    ["after-generation-rename", "old"],
    ["after-temporary-pointer", "old"],
    ["after-pointer", "new"],
  ] as const)("keeps a complete selection after interruption at %s", (faultAt, expected) => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "old"), "old");
    expect(() => publishGeneratedGeneration(root, stage(root, "new"), "new", { faultAt }))
      .toThrow(`injected interruption at ${faultAt}`);
    expect(selectedTokens(root)).toEqual([expected, expected]);

    cleanupGeneratedState(root);
    expect(fs.readdirSync(path.join(root, ".agentera-generated")).filter((name) => name.startsWith(".current-"))).toEqual([]);

    publishGeneratedGeneration(root, stage(root, "retry"), "retry");
    expect(selectedTokens(root)).toEqual(["retry", "retry"]);
  });

  it("rejects incomplete and corrupt generations without changing selection", () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "old"), "old");
    const incomplete = stage(root, "incomplete");
    fs.rmSync(path.join(incomplete, "bundle", ".agentera-generation.json"));
    expect(() => publishGeneratedGeneration(root, incomplete, "incomplete")).toThrow("bundle identity is missing");
    expect(selectedTokens(root)).toEqual(["old", "old"]);

    fs.rmSync(path.join(root, ".agentera-generated", "current"));
    fs.writeFileSync(path.join(root, ".agentera-generated", "current"), "not a symlink");
    expect(() => selectGeneratedGeneration(root)).toThrow("current selection is not a symbolic link");
  });

  it("rejects a selected generation whose surface identities mismatch", () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "selected"), "selected");
    const selected = selectGeneratedGeneration(root);
    const bundleIdentity = path.join(selected.root, "bundle", ".agentera-generation.json");
    const identity = JSON.parse(fs.readFileSync(bundleIdentity, "utf8"));
    fs.writeFileSync(bundleIdentity, JSON.stringify({ ...identity, id: "different" }));

    expect(() => selectGeneratedGeneration(root)).toThrow("do not share generation");
  });

  it.each(["direct", "generation-link", "prefix-collision"])("confines selected generations against %s escape", (scenario) => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "inside"), "inside");
    const outsideParent = tempRoot();
    const outside = stage(outsideParent, "escaped");
    const current = path.join(root, ".agentera-generated", "current");
    fs.rmSync(current);
    if (scenario === "generation-link") {
      const linked = path.join(root, ".agentera-generated", "generations", "escaped");
      fs.symlinkSync(outside, linked, "dir");
      fs.symlinkSync("generations/escaped", current, "dir");
    } else {
      const target = scenario === "prefix-collision"
        ? path.join(root, ".agentera-generated", "generations-escaped")
        : outside;
      if (scenario === "prefix-collision") fs.renameSync(outside, target);
      fs.symlinkSync(target, current, "dir");
    }

    expect(() => selectGeneratedGeneration(root)).toThrow(/governed generations root|regular generation directory/);
    if (scenario === "generation-link") expect(() => cleanupGeneratedState(root)).toThrow("state has unknown ownership");
    else cleanupGeneratedState(root);
    expect(fs.existsSync(path.join(scenario === "prefix-collision"
      ? path.join(root, ".agentera-generated", "generations-escaped")
      : outside, "dist", "generation.txt"))).toBe(true);
    expect(fs.readdirSync(path.join(root, ".agentera-generated")).filter((name) => name.startsWith(".preserved-current-")))
      .toHaveLength(scenario === "generation-link" ? 0 : 1);
    if (scenario === "generation-link") expect(fs.lstatSync(current).isSymbolicLink()).toBe(true);
  });

  it("recovers a directory at current by preserving it before atomic replacement", () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "old"), "old");
    const current = path.join(root, ".agentera-generated", "current");
    fs.rmSync(current);
    fs.mkdirSync(current);
    fs.writeFileSync(path.join(current, "evidence.txt"), "preserve\n");

    publishGeneratedGeneration(root, stage(root, "new"), "new");
    expect(selectedTokens(root)).toEqual(["new", "new"]);
    const preserved = fs.readdirSync(path.dirname(current)).filter((name) => name.startsWith(".preserved-current-"));
    expect(preserved).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(current), preserved[0]!, "evidence.txt"), "utf8")).toBe("preserve\n");
    cleanupGeneratedState(root);
    cleanupGeneratedState(root);
    expect(fs.readdirSync(path.dirname(current)).filter((name) => name.startsWith(".preserved-current-"))).toEqual(preserved);
  });

  it.each(["corrupt-journal", "missing-backup", "corrupt-backup"])(
    "retains degraded legacy recovery evidence: %s",
    (scenario) => {
      const root = tempRoot();
      const journal = path.join(root, ".agentera-generated-publication.json");
      if (scenario === "corrupt-journal") fs.writeFileSync(journal, "{corrupt\n");
      if (scenario === "missing-backup") {
        fs.writeFileSync(journal, JSON.stringify({ entries: [{ hadPrevious: true, backup: "missing" }] }));
      }
      if (scenario === "corrupt-backup") fs.writeFileSync(path.join(root, ".dist.agentera-backup-corrupt"), "not a directory\n");

      expect(() => publishGeneratedGeneration(root, stage(root, "new"), "new"))
        .toThrow("legacy generated-output recovery residue");
      expect(fs.existsSync(journal) || fs.existsSync(path.join(root, ".dist.agentera-backup-corrupt"))).toBe(true);
      expect(fs.existsSync(path.join(root, ".agentera-generated", "current"))).toBe(false);
    },
  );

  it.each(["unknown-owner", "stale-owner"])("safely reclaims an obsolete %s lock", (scenario) => {
    const root = tempRoot();
    const lock = legacyPublicationLockPath(root);
    fs.mkdirSync(lock, { recursive: true });
    if (scenario === "stale-owner") fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 999_999_999 }));
    else {
      const old = new Date(Date.now() - 31_000);
      fs.utimesSync(lock, old, old);
    }

    publishGeneratedGeneration(root, stage(root, "new"), "new");
    expect(selectedTokens(root)).toEqual(["new", "new"]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("retains a fresh unknown-owner lock with bounded recovery guidance", () => {
    const root = tempRoot();
    const lock = legacyPublicationLockPath(root);
    fs.mkdirSync(lock, { recursive: true });

    expect(() => publishGeneratedGeneration(root, stage(root, "new"), "new"))
      .toThrow("retry after 30 seconds");
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("does not reclaim a live legacy publisher lock", () => {
    const root = tempRoot();
    const lock = legacyPublicationLockPath(root);
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));

    expect(() => publishGeneratedGeneration(root, stage(root, "new"), "new"))
      .toThrow(`publisher PID ${process.pid} is active`);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("reclaims dead staging owners and retains unknown staging evidence", () => {
    const root = tempRoot();
    const generated = path.join(root, ".agentera-generated");
    const dead = path.join(generated, ".staging-999999999-dead");
    fs.mkdirSync(dead, { recursive: true });
    cleanupGeneratedState(root);
    expect(fs.existsSync(dead)).toBe(false);

    const unknown = path.join(generated, ".staging-unknown");
    fs.mkdirSync(unknown);
    expect(() => cleanupGeneratedState(root)).toThrow("state has unknown ownership");
    expect(fs.existsSync(unknown)).toBe(true);
  });

  it.runIf(process.platform === "linux")("uses process-start identity instead of PID alone when reclaiming staging", () => {
    const root = tempRoot();
    const generated = path.join(root, ".agentera-generated");
    const reused = path.join(generated, `.staging-${process.pid}-deadbeef`);
    fs.mkdirSync(reused, { recursive: true });
    fs.writeFileSync(path.join(reused, ".owner.json"), JSON.stringify({ pid: process.pid, processIdentity: "linux-start:not-this-process" }));
    const conservative = path.join(generated, `.staging-${process.pid}-feedface`);
    fs.mkdirSync(conservative);
    fs.writeFileSync(path.join(conservative, ".owner.json"), JSON.stringify({ pid: process.pid }));

    cleanupGeneratedState(root);
    expect(fs.existsSync(reused)).toBe(false);
    expect(fs.existsSync(conservative)).toBe(true);
  });

  it("preserves malformed temporary pointer state with an idempotent correction", () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "selected"), "selected");
    const corrupt = path.join(root, ".agentera-generated", ".current-corrupt");
    fs.mkdirSync(corrupt);
    fs.writeFileSync(path.join(corrupt, "evidence.txt"), "unknown\n");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => cleanupGeneratedState(root)).toThrow("remove only confirmed residue");
      expect(fs.readFileSync(path.join(corrupt, "evidence.txt"), "utf8")).toBe("unknown\n");
      expect(selectedTokens(root)).toEqual(["selected", "selected"]);
    }
  });

  it("does not collect a complete generation owned by a concurrent live publisher", () => {
    const root = tempRoot();
    const generation = stage(root, "active");
    const target = path.join(root, ".agentera-generated", "generations", "active");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(generation, target);

    cleanupGeneratedState(root);

    expect(fs.existsSync(target)).toBe(true);
  });

  it("bounds completed generations while retaining and later reclaiming a pinned reader", () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "first"), "first");
    const pinned = pinGeneratedGeneration(root);
    for (const id of ["second", "third", "fourth"]) publishGeneratedGeneration(root, stage(root, id), id);

    cleanupGeneratedState(root);
    const generations = path.join(root, ".agentera-generated", "generations");
    expect(fs.existsSync(path.join(generations, "first"))).toBe(true);
    expect(fs.readdirSync(generations).filter((name) => !name.startsWith("."))).toHaveLength(GENERATED_RETENTION_LIMIT);
    expect(fs.readFileSync(path.join(pinned.root, "dist", "generation.txt"), "utf8")).toBe("first\n");

    pinned.release();
    publishGeneratedGeneration(root, stage(root, "fifth"), "fifth");
    cleanupGeneratedState(root);
    cleanupGeneratedState(root);
    expect(fs.existsSync(path.join(generations, "first"))).toBe(false);
    expect(fs.readdirSync(generations).filter((name) => !name.startsWith("."))).toHaveLength(GENERATED_RETENTION_LIMIT);
  });

  it("restores an interrupted cleanup claim when a reader lease is live", () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "old"), "old");
    const pinned = pinGeneratedGeneration(root);
    publishGeneratedGeneration(root, stage(root, "new"), "new");
    const generations = path.join(root, ".agentera-generated", "generations");
    const old = path.join(generations, "old");
    fs.renameSync(path.join(old, ".agentera-generation.guard"), path.join(old, ".agentera-generation.guard.retiring-interrupted"));

    cleanupGeneratedState(root);
    expect(fs.existsSync(path.join(old, ".agentera-generation.guard"))).toBe(true);
    expect(fs.readFileSync(path.join(pinned.root, "bundle", "generation.txt"), "utf8")).toBe("old\n");
    pinned.release();
  });

  it("removes an interrupted cleanup claim after its reader lease is released", () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "old"), "old");
    const pinned = pinGeneratedGeneration(root);
    publishGeneratedGeneration(root, stage(root, "new"), "new");
    pinned.release();
    const generations = path.join(root, ".agentera-generated", "generations");
    const old = path.join(generations, "old");
    const retired = path.join(old, ".agentera-generation.guard.retiring-interrupted");
    fs.renameSync(path.join(old, ".agentera-generation.guard"), retired);

    cleanupGeneratedState(root);
    cleanupGeneratedState(root);
    expect(fs.existsSync(old)).toBe(false);
    expect(selectedTokens(root)).toEqual(["new", "new"]);
  });

  it("never exposes a missing or cross-generation surface to a pinned concurrent reader", async () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "old"), "old");
    const observations = path.join(root, "observations.jsonl");
    const readerReady = path.join(root, "reader.ready");
    const stop = path.join(root, "reader.stop");
    const publisherReady = path.join(root, "publisher.ready");
    const reader = worker("generatedPublicationReader.mjs", [root, observations, readerReady, stop]);
    await waitFor(() => fs.existsSync(readerReady), "reader readiness");

    const publisher = worker("generatedPublicationWorker.mjs", [root, stage(root, "new"), "new", publisherReady, "200"]);
    await waitFor(() => fs.existsSync(publisherReady), "publisher pre-pointer phase");
    await publisher.done;
    await waitFor(() => fs.existsSync(observations) && fs.readFileSync(observations, "utf8").includes('"new"'), "new observation");
    fs.writeFileSync(stop, "stop\n");
    await reader.done;

    const rows = fs.readFileSync(observations, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.some(({ id }) => id === "old")).toBe(true);
    expect(rows.some(({ id }) => id === "new")).toBe(true);
    expect(rows.every(({ id, dist, bundle }) => id === dist && id === bundle)).toBe(true);
  });
});
