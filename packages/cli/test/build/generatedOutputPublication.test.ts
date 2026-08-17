import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupGeneratedState,
  classifyProcessOwner,
  GENERATED_RETENTION_LIMIT,
  generatedSourceIdentity,
  legacyPublicationLockPath,
  pinGeneratedGeneration,
  publishGeneratedGeneration,
  sealGeneratedSourceIdentity,
  processStartIdentity,
  selectGeneratedGeneration,
  writeGeneratedSourceIdentity,
  writeGenerationIdentity,
} from "../../scripts/generated-output.mjs";
import { gitSourceTreeDigest } from "../../scripts/git-source-tree.mjs";
import { gitCommitArgs } from "../helpers/git.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-generated-publication-test-"));
  roots.push(root);
  return root;
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function sourceIdentityRepository(fileMode: boolean): { root: string; packageRoot: string; file: string } {
  const root = tempRoot();
  const packageRoot = path.join(root, "packages", "cli");
  const file = path.join(root, "mode-fixture.txt");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), "packages/cli/.agentera-generated/\n");
  fs.writeFileSync(file, "mode-bound bytes\n");
  git(root, ["init", "--quiet"]);
  git(root, ["config", "core.filemode", String(fileMode)]);
  git(root, ["add", "."]);
  git(root, gitCommitArgs("--quiet", "-m", "fixture"));
  return { root, packageRoot, file };
}

function symlinkIdentityRepository(): { root: string; packageRoot: string; file: string } {
  const root = tempRoot();
  const packageRoot = path.join(root, "packages", "cli");
  const file = path.join(root, "source-link");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), "packages/cli/.agentera-generated/\n");
  git(root, ["init", "--quiet"]);
  fs.symlinkSync("target-a", file);
  git(root, ["add", "."]);
  git(root, gitCommitArgs("--quiet", "-m", "symlink fixture"));
  return { root, packageRoot, file };
}

function symlinkSurrogateIdentityRepository(): { root: string; packageRoot: string; file: string } {
  const root = tempRoot();
  const packageRoot = path.join(root, "packages", "cli");
  const file = path.join(root, "source-link");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), "packages/cli/.agentera-generated/\n");
  fs.writeFileSync(file, "target-a");
  git(root, ["init", "--quiet"]);
  git(root, ["config", "core.symlinks", "false"]);
  git(root, ["add", ".gitignore"]);
  const object = git(root, ["hash-object", "-w", "source-link"]);
  git(root, ["update-index", "--add", "--cacheinfo", `120000,${object},source-link`]);
  git(root, gitCommitArgs("--quiet", "-m", "symlink surrogate fixture"));
  return { root, packageRoot, file };
}

function sourceIdentity(value: string) {
  const unsigned = {
    schemaVersion: "agentera.generatedBuildSource.v1",
    commit: value.repeat(40),
    tree: value.repeat(40),
    files: 1,
    workingTreeSha256: value.repeat(64),
  };
  return sealGeneratedSourceIdentity(unsigned);
}

function stage(root: string, id: string, source?: ReturnType<typeof sourceIdentity>): string {
  const staged = path.join(root, `.stage-${id}`);
  for (const surface of ["dist", "bundle"]) {
    fs.mkdirSync(path.join(staged, surface), { recursive: true });
    fs.writeFileSync(path.join(staged, surface, "generation.txt"), `${id}\n`);
  }
  if (source) writeGeneratedSourceIdentity(staged, source);
  writeGenerationIdentity(staged, id, source);
  return staged;
}

function nestedLink(staged: string, surface: "dist" | "bundle", target: string, relative = false): string {
  const link = path.join(staged, surface, "nested", "payload");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(relative ? path.relative(path.dirname(link), target) : target, link);
  return link;
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

async function synchronizedWorkers(root: string, specs: Array<{ script: string; args: string[] }>): Promise<void> {
  const release = path.join(root, "workers.release");
  const workers = specs.map(({ script, args }, index) => {
    const ready = path.join(root, `worker-${index}.ready`);
    return { ready, worker: worker(script, [...args, ready, release]) };
  });
  await waitFor(() => workers.every(({ ready }) => fs.existsSync(ready)), `${workers.length} worker barriers`);
  fs.writeFileSync(release, "release\n");
  await Promise.all(workers.map(({ worker: running }) => running.done));
}

function generatedResidue(root: string): string[] {
  const generated = path.join(root, ".agentera-generated");
  if (!fs.existsSync(generated)) return [];
  const residue: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (/^(\.mutation-lock|\.current-|\.staging-)/.test(entry.name) || entry.name.includes(".retiring-")) {
        residue.push(path.relative(generated, candidate));
      }
      if (entry.isDirectory()) visit(candidate);
    }
  };
  visit(generated);
  return residue.sort();
}

function writeMutationOwner(directory: string, owner: Record<string, unknown>): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "owner.json"), `${JSON.stringify(owner)}\n`);
}

function deadMutationOwner(token: string): Record<string, unknown> {
  return { pid: 2_147_483_647, processIdentity: "linux-start:1", token };
}

function darwinPs(started: string, calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>) {
  return (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: options.env });
    return { status: 0, stdout: `${started}\n` };
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

  it("rejects a complete lease-free generation built from another source identity", () => {
    const root = tempRoot();
    const oldSource = sourceIdentity("a");
    const currentSource = sourceIdentity("b");
    publishGeneratedGeneration(root, stage(root, "old", oldSource), "old");

    expect(selectGeneratedGeneration(root, { sourceIdentity: oldSource }).sourceIdentity).toEqual(oldSource);
    expect(() => selectGeneratedGeneration(root, { sourceIdentity: currentSource }))
      .toThrow("does not match the required source identity");

    publishGeneratedGeneration(root, stage(root, "current", currentSource), "current");
    expect(selectGeneratedGeneration(root, { sourceIdentity: currentSource }).sourceIdentity).toEqual(currentSource);
  });

  it.runIf(process.platform !== "win32")("binds tracked and untracked Git executable bits and rejects a stale selected generation", () => {
    const repo = sourceIdentityRepository(true);
    fs.chmodSync(repo.file, 0o644);
    const nonExecutable = generatedSourceIdentity(repo.packageRoot);
    publishGeneratedGeneration(repo.packageRoot, stage(repo.packageRoot, "non-executable", nonExecutable), "non-executable");

    fs.chmodSync(repo.file, 0o755);
    const executable = generatedSourceIdentity(repo.packageRoot);
    expect(executable.workingTreeSha256).not.toBe(nonExecutable.workingTreeSha256);
    expect(executable.identitySha256).not.toBe(nonExecutable.identitySha256);
    expect(() => selectGeneratedGeneration(repo.packageRoot, { sourceIdentity: executable }))
      .toThrow("does not match the required source identity");

    const untracked = path.join(repo.root, "untracked.txt");
    fs.writeFileSync(untracked, "untracked mode-bound bytes\n");
    fs.chmodSync(untracked, 0o644);
    const untrackedNonExecutable = generatedSourceIdentity(repo.packageRoot);
    fs.chmodSync(untracked, 0o755);
    const untrackedExecutable = generatedSourceIdentity(repo.packageRoot);
    expect(untrackedExecutable.workingTreeSha256).not.toBe(untrackedNonExecutable.workingTreeSha256);
    expect(untrackedExecutable.identitySha256).not.toBe(untrackedNonExecutable.identitySha256);
  });

  it.runIf(process.platform !== "win32")("ignores non-executable permission noise and unsupported worktree chmod", () => {
    const supported = sourceIdentityRepository(true);
    fs.chmodSync(supported.file, 0o644);
    const ordinary = generatedSourceIdentity(supported.packageRoot);
    fs.chmodSync(supported.file, 0o604);
    expect(generatedSourceIdentity(supported.packageRoot)).toEqual(ordinary);

    const unsupported = sourceIdentityRepository(false);
    fs.chmodSync(unsupported.file, 0o644);
    const indexed = generatedSourceIdentity(unsupported.packageRoot);
    fs.chmodSync(unsupported.file, 0o755);
    expect(generatedSourceIdentity(unsupported.packageRoot)).toEqual(indexed);
  });

  it("matches a clean core.symlinks=false surrogate to its index symlink and binds target changes", () => {
    const repo = symlinkSurrogateIdentityRepository();
    expect(git(repo.root, ["status", "--porcelain=v1"])).toBe("");
    const surrogate = generatedSourceIdentity(repo.packageRoot);
    expect(gitSourceTreeDigest(repo.root).sha256)
      .toBe(gitSourceTreeDigest(repo.root, { source: "index" }).sha256);

    fs.writeFileSync(repo.file, "target-b");
    const changed = generatedSourceIdentity(repo.packageRoot);
    expect(changed.workingTreeSha256).not.toBe(surrogate.workingTreeSha256);
    expect(changed.identitySha256).not.toBe(surrogate.identitySha256);
  });

  it.runIf(process.platform !== "win32")("treats a regular replacement as a symlink type mismatch when symlinks are enabled", () => {
    const repo = symlinkIdentityRepository();
    git(repo.root, ["config", "core.symlinks", "true"]);
    const linked = generatedSourceIdentity(repo.packageRoot);

    fs.rmSync(repo.file);
    fs.writeFileSync(repo.file, "target-a");
    const replaced = generatedSourceIdentity(repo.packageRoot);

    expect(replaced.workingTreeSha256).not.toBe(linked.workingTreeSha256);
    expect(replaced.identitySha256).not.toBe(linked.identitySha256);
  });

  it("fails closed when Git cannot parse the effective symlink configuration", () => {
    const repo = sourceIdentityRepository(true);
    git(repo.root, ["config", "core.symlinks", "not-a-boolean"]);

    expect(() => generatedSourceIdentity(repo.packageRoot))
      .toThrow("unable to read generated-output source identity");
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

  it.each([
    ["absolute dist file", "dist", "file", false],
    ["relative dist file", "dist", "file", true],
    ["absolute bundle file", "bundle", "file", false],
    ["relative bundle directory", "bundle", "directory", true],
    ["path-prefix collision", "dist", "prefix", false],
    ["broken nested link", "bundle", "broken", true],
  ] as const)("rejects %s nested surface escape without mutating its target", (_, surface, targetKind, relative) => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "selected"), "selected");
    const candidate = stage(root, "escaped");
    const outsideRoot = targetKind === "prefix"
      ? path.join(root, ".agentera-generated", "generations-outside")
      : tempRoot();
    fs.mkdirSync(outsideRoot, { recursive: true });
    const target = targetKind === "directory"
      ? outsideRoot
      : path.join(outsideRoot, targetKind === "broken" ? "missing.txt" : "outside.txt");
    if (targetKind !== "directory" && targetKind !== "broken") fs.writeFileSync(target, "outside-before\n");
    nestedLink(candidate, surface, target, relative);

    expect(() => publishGeneratedGeneration(root, candidate, "escaped")).toThrow("contains a symbolic link");
    expect(selectedTokens(root)).toEqual(["selected", "selected"]);
    if (targetKind !== "directory" && targetKind !== "broken") expect(fs.readFileSync(target, "utf8")).toBe("outside-before\n");
    else expect(fs.existsSync(outsideRoot)).toBe(true);
  });

  it("rejects an externally linked checkout executable during selection", () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "selected"), "selected");
    const selected = selectGeneratedGeneration(root);
    const outside = path.join(tempRoot(), "agentera.js");
    fs.writeFileSync(outside, "throw new Error('external code ran');\n");
    const executable = path.join(selected.root, "dist/bin/agentera.js");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.symlinkSync(outside, executable);

    expect(() => selectGeneratedGeneration(root)).toThrow("dist surface contains a symbolic link");
    expect(fs.readFileSync(outside, "utf8")).toContain("external code ran");
  });

  it("rejects nested hard links without unlinking or changing the external inode", () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "selected"), "selected");
    const candidate = stage(root, "linked");
    const outside = path.join(tempRoot(), "outside.txt");
    fs.writeFileSync(outside, "outside-before\n");
    const linked = path.join(candidate, "bundle/nested/linked.txt");
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.linkSync(outside, linked);

    expect(() => publishGeneratedGeneration(root, candidate, "linked")).toThrow("multiply linked file");
    expect(fs.readFileSync(outside, "utf8")).toBe("outside-before\n");
    expect(selectedTokens(root)).toEqual(["selected", "selected"]);
  });

  it("derives declared-platform process birth identities", () => {
    const linuxFields = ["S", ...Array(18).fill("0"), "987654"];
    expect(processStartIdentity(42, { platform: "linux", readFile: () => `42 (agent worker) ${linuxFields.join(" ")}` }))
      .toBe("linux-start:987654");
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    expect(processStartIdentity(42, {
      platform: "darwin",
      env: { TZ: "Pacific/Honolulu", LC_ALL: "fr_FR.UTF-8", LANG: "fr_FR.UTF-8" },
      spawnSync: darwinPs("Tue Jul 21 06:10:11 2026", calls),
    })).toBe("darwin-start-utc:2026-07-21T06:10:11Z");
    expect(calls).toEqual([{
      command: "ps",
      args: ["-o", "lstart=", "-p", "42"],
      env: expect.objectContaining({ TZ: "UTC0", LC_ALL: "C", LANG: "C" }),
    }]);
    expect(processStartIdentity(42, {
      platform: "win32",
      spawnSync: () => ({ status: 0, stdout: "638887614110000000\r\n" }),
    })).toBe("win32-start:638887614110000000");
  });

  it("keeps Darwin ownership stable across caller locale and timezone changes", () => {
    const recordedCalls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const checkedCalls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const recorded = processStartIdentity(42, {
      platform: "darwin",
      env: { TZ: "America/Los_Angeles", LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" },
      spawnSync: darwinPs("Tue Jul 21 06:10:11 2026", recordedCalls),
    });
    const observed = () => processStartIdentity(42, {
      platform: "darwin",
      env: { TZ: "Asia/Tokyo", LC_ALL: "ja_JP.UTF-8", LANG: "ja_JP.UTF-8" },
      spawnSync: darwinPs("Tue Jul 21 06:10:11 2026", checkedCalls),
    });

    expect(recorded).toBe("darwin-start-utc:2026-07-21T06:10:11Z");
    expect(classifyProcessOwner(
      { pid: 42, processIdentity: recorded },
      { isAlive: () => true, identityForPid: observed },
    )).toBe("active");
    expect([...recordedCalls, ...checkedCalls].every(({ env }) =>
      env.TZ === "UTC0" && env.LC_ALL === "C" && env.LANG === "C")).toBe(true);
  });

  it("distinguishes reused and dead Darwin processes while preserving uncertain evidence", () => {
    const recorded = "darwin-start-utc:2026-07-21T06:10:11Z";
    const reused = () => processStartIdentity(42, {
      platform: "darwin",
      spawnSync: darwinPs("Tue Jul 21 06:11:12 2026", []),
    });
    expect(classifyProcessOwner(
      { pid: 42, processIdentity: recorded },
      { isAlive: () => true, identityForPid: reused },
    )).toBe("stale");
    expect(classifyProcessOwner(
      { pid: 42, processIdentity: recorded },
      { isAlive: () => false, identityForPid: () => { throw new Error("must not inspect a dead PID"); } },
    )).toBe("stale");

    for (const spawnSync of [
      () => ({ status: 1, stdout: "", stderr: "operation not permitted" }),
      () => ({ status: 0, stdout: "not a process start time\n" }),
    ]) {
      expect(classifyProcessOwner(
        { pid: 42, processIdentity: recorded },
        { isAlive: () => true, identityForPid: () => processStartIdentity(42, { platform: "darwin", spawnSync }) },
      )).toBe("unknown");
    }
    expect(classifyProcessOwner(
      { pid: 42, processIdentity: "darwin-start:Tue Jul 21 06:10:11 2026" },
      { isAlive: () => true, identityForPid: reused },
    )).toBe("unknown");
    expect(classifyProcessOwner(
      { pid: 42, processIdentity: recorded },
      { isAlive: () => true, identityForPid: () => processStartIdentity(42, { platform: "freebsd" }) },
    )).toBe("unknown");
  });

  it.runIf(process.platform === "darwin")("reads one real Darwin process identity independently of caller locale and timezone", () => {
    const first = processStartIdentity(process.pid, {
      env: { ...process.env, TZ: "Pacific/Honolulu", LC_ALL: "C", LANG: "C" },
    });
    const second = processStartIdentity(process.pid, {
      env: { ...process.env, TZ: "Europe/Berlin", LC_ALL: "C", LANG: "C" },
    });
    expect(first).toMatch(/^darwin-start-utc:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(second).toBe(first);
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
      .toThrow(`publisher PID ${process.pid} has uncertain identity`);
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
    fs.writeFileSync(path.join(reused, ".owner.json"), JSON.stringify({ pid: process.pid, processIdentity: "linux-start:1" }));
    cleanupGeneratedState(root);
    expect(fs.existsSync(reused)).toBe(false);

    const conservative = path.join(generated, `.staging-${process.pid}-feedface`);
    fs.mkdirSync(conservative);
    fs.writeFileSync(path.join(conservative, ".owner.json"), JSON.stringify({ pid: process.pid }));
    expect(() => cleanupGeneratedState(root)).toThrow("state has unknown ownership");
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

  it("fails closed for PID-reused mutation ownership and preserves unknown ownership", () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "selected"), "selected");
    const lock = path.join(root, ".agentera-generated/.mutation-lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
      pid: process.pid,
      processIdentity: "linux-start:1",
      token: "reused",
    }));

    expect(() => cleanupGeneratedState(root)).toThrow("mutation lock has stale ownership");
    expect(fs.existsSync(lock)).toBe(true);
    fs.rmSync(lock, { recursive: true });

    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "unknown" }));
    expect(() => cleanupGeneratedState(root)).toThrow("mutation owner identity is unavailable");
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("does not move a fresh file lock after stale classification", () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "selected"), "selected");
    const lock = path.join(root, ".agentera-generated/.mutation-lock");
    fs.writeFileSync(lock, JSON.stringify(deadMutationOwner("stale")));
    const identity = processStartIdentity(process.pid);
    expect(identity).not.toBeNull();
    const original = fs.readFileSync.bind(fs);
    let reads = 0;
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (args[0] === lock && ++reads === 1) {
        const stale = Reflect.apply(original, fs, args);
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, processIdentity: identity, token: "fresh" }));
        return stale;
      }
      return Reflect.apply(original, fs, args);
    });
    try {
      expect(() => cleanupGeneratedState(root, { mutationLockWaitMs: 0 })).toThrow("mutation lock has stale ownership");
      expect(fs.existsSync(lock)).toBe(true);
      expect(fs.readFileSync(lock, "utf8")).toContain('"token":"fresh"');
      expect(fs.readdirSync(path.dirname(lock)).filter((name) => name.startsWith(".mutation-lock.reclaim-"))).toEqual([]);
      expect(() => cleanupGeneratedState(root, { mutationLockWaitMs: 0 })).toThrow("mutation lock remained active");
    } finally {
      readSpy.mockRestore();
    }
  });

  it("recovers an interrupted stale mutation-lock claim idempotently before cleanup and publication retry", () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "selected"), "selected");
    const generated = path.join(root, ".agentera-generated");
    writeMutationOwner(path.join(generated, ".mutation-lock.reclaim-interrupted"), deadMutationOwner("interrupted"));

    cleanupGeneratedState(root);
    cleanupGeneratedState(root);
    publishGeneratedGeneration(root, stage(root, "retried"), "retried");
    expect(selectedTokens(root)).toEqual(["retried", "retried"]);
    expect(generatedResidue(root)).toEqual([]);
  });

  it("restores live mutation ownership and preserves uncertain reclaim claims", () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "selected"), "selected");
    const generated = path.join(root, ".agentera-generated");
    const liveClaim = path.join(generated, ".mutation-lock.reclaim-live");
    const identity = processStartIdentity(process.pid);
    expect(identity).not.toBeNull();
    writeMutationOwner(liveClaim, { pid: process.pid, processIdentity: identity, token: "live" });

    expect(() => cleanupGeneratedState(root, { mutationLockWaitMs: 20 })).toThrow("mutation lock remained active");
    expect(fs.existsSync(liveClaim)).toBe(false);
    expect(fs.lstatSync(path.join(generated, ".mutation-lock")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(generated, ".mutation-lock"), "utf8")).toContain('"token":"live"');
    fs.rmSync(path.join(generated, ".mutation-lock"), { recursive: true });

    const uncertainClaim = path.join(generated, ".mutation-lock.reclaim-uncertain");
    writeMutationOwner(uncertainClaim, { pid: process.pid, token: "uncertain" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => cleanupGeneratedState(root)).toThrow("mutation-lock reclaim claim has uncertain ownership");
      expect(fs.existsSync(uncertainClaim)).toBe(true);
    }
  });

  it("preserves conflicting live canonical and reclaim ownership", () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "selected"), "selected");
    const generated = path.join(root, ".agentera-generated");
    const identity = processStartIdentity(process.pid);
    expect(identity).not.toBeNull();
    const lock = path.join(generated, ".mutation-lock");
    const claim = path.join(generated, ".mutation-lock.reclaim-conflict");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, processIdentity: identity, token: "canonical" }));
    writeMutationOwner(claim, { pid: process.pid, processIdentity: identity, token: "claim" });

    expect(() => cleanupGeneratedState(root, { mutationLockWaitMs: 0 })).toThrow("conflicts with canonical lock");
    expect(fs.readFileSync(lock, "utf8")).toContain('"token":"canonical"');
    expect(fs.existsSync(claim)).toBe(true);
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
    expect(fs.readdirSync(generations).filter((name) => !name.startsWith("."))).toHaveLength(GENERATED_RETENTION_LIMIT + 1);
    expect(fs.readFileSync(path.join(pinned.root, "dist", "generation.txt"), "utf8")).toBe("first\n");

    pinned.release();
    publishGeneratedGeneration(root, stage(root, "fifth"), "fifth");
    cleanupGeneratedState(root);
    cleanupGeneratedState(root);
    expect(fs.existsSync(path.join(generations, "first"))).toBe(false);
    expect(fs.readdirSync(generations).filter((name) => !name.startsWith("."))).toHaveLength(GENERATED_RETENTION_LIMIT);
  });

  it("bounds ordinary retention while preserving and reporting an uncertain lease", () => {
    const root = tempRoot();
    publishGeneratedGeneration(root, stage(root, "uncertain"), "uncertain");
    const generated = path.join(root, ".agentera-generated");
    const lease = path.join(generated, `leases/00000000-0000-4000-8000-000000000000.${process.pid}.none.reader.lease`);
    fs.linkSync(path.join(generated, "generations/uncertain/.agentera-generation.guard"), lease);
    for (const id of ["second", "third", "fourth", "fifth"]) publishGeneratedGeneration(root, stage(root, id), id);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => cleanupGeneratedState(root)).toThrow("unavailable process-start identity");
      const retained = fs.readdirSync(path.join(generated, "generations")).filter((name) => !name.startsWith("."));
      expect(retained).toHaveLength(GENERATED_RETENTION_LIMIT + 1);
      expect(retained).toContain("uncertain");
      expect(selectedTokens(root)).toEqual(["fifth", "fifth"]);
    }
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

  it("serializes many stale reclaimers, cleaners, and publishers without residue or launcher gaps", async () => {
    const root = tempRoot();
    for (const id of ["seed1", "seed2", "seed3", "seed4"]) publishGeneratedGeneration(root, stage(root, id), id);
    const generated = path.join(root, ".agentera-generated");
    for (const suffix of ["crash", "one", "two", "three"]) {
      writeMutationOwner(path.join(generated, `.mutation-lock.reclaim-${suffix}`), deadMutationOwner(`residue-${suffix}`));
    }
    const cleaners = Array.from({ length: 8 }, () => ({ script: "generatedCleanupWorker.mjs", args: [root] }));
    const builders = Array.from({ length: 6 }, (_, index) => ({
      script: "generatedBuildWorker.mjs",
      args: [root, `build${index}`],
    }));

    await synchronizedWorkers(root, [...cleaners, ...builders]);

    const selected = selectGeneratedGeneration(root);
    expect(selected.id).toMatch(/^build\d$/);
    expect(fs.lstatSync(path.join(root, "dist/bin/agentera.js")).isFile()).toBe(true);
    const generations = path.join(root, ".agentera-generated/generations");
    expect(fs.readdirSync(generations).filter((name) => !name.startsWith("."))).toHaveLength(GENERATED_RETENTION_LIMIT);
    expect(generatedResidue(root)).toEqual([]);
    expect(fs.readdirSync(root).filter((name) => name.startsWith(".worker-stage-"))).toEqual([]);
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
