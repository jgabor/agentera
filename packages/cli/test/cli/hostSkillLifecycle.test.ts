import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostSkillPath, loadHostSkillSource, runHostSkillLifecycle, HOST_SKILL_DIRECTORY_ID, HOST_SKILL_FILE_ID } from "../../src/setup/hostSkillLifecycle.js";
import { diagnoseCanonicalSkill } from "../../src/setup/sharedSkill.js";
import { main } from "../../src/cli/dispatch.js";
import { activeAppModel } from "../../src/cli/appContext.js";
import { sourceModuleUrl, sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";
import { acquireLifecycleOwnershipJournalLock, lifecycleOwnershipJournalPath, readLifecycleOwnershipJournal, releaseLifecycleOwnershipJournalLock } from "../../src/runtime/lifecycleOwnershipJournal.js";

const root = path.resolve(import.meta.dirname, "../../../..");
let temp: string, home: string, appHome: string, sourceRoot: string, target: string, file: string;
function write(destination: string, text: string) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, text);
}
function run(apply = true, options: Parameters<typeof runHostSkillLifecycle>[1] = {}) {
  return runHostSkillLifecycle({ home, appHome, sourceRoot, apply }, options);
}
function snapshot(directory = temp): Record<string, string> {
  const values: Record<string, string> = {};
  function visit(at: string) {
    for (const name of fs.readdirSync(at).sort()) {
      const child = path.join(at, name),
        key = path.relative(directory, child),
        stat = fs.lstatSync(child);
      values[key] = stat.isSymbolicLink() ? `link:${fs.readlinkSync(child)}` : stat.isDirectory() ? "dir" : fs.readFileSync(child).toString("base64");
      if (stat.isDirectory()) visit(child);
    }
  }
  visit(directory);
  return values;
}
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-host-lifecycle-"));
  home = path.join(temp, "home");
  appHome = path.join(temp, "app");
  sourceRoot = path.join(temp, "runtime");
  target = hostSkillPath(home);
  file = path.join(target, "SKILL.md");
  fs.mkdirSync(home);
  for (const relative of ["references/adapters/package-registry.yaml", "registry.json", "skills/agentera/SKILL.md"]) write(path.join(sourceRoot, relative), fs.readFileSync(path.join(root, relative), "utf8"));
  write(path.join(temp, "project/.agentera/unrelated"), "retain project state");
  write(path.join(appHome, "profile/private"), "retain profile");
  vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", sourceRoot);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("one-file host install and refresh", () => {
  it("previews with zero writes, creates exactly one regular bootstrap and repeats without journal changes", () => {
    const before = snapshot();
    expect(run(false).status).toBe("pending");
    expect(snapshot()).toEqual(before);
    const installed = run();
    expect(installed.status, JSON.stringify(installed)).toBe("success");
    expect(fs.readdirSync(target)).toEqual(["SKILL.md"]);
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(fs.lstatSync(file).nlink).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe(loadHostSkillSource(sourceRoot).content);
    const after = snapshot();
    expect(run().status).toBe("noop");
    expect(snapshot()).toEqual(after);
    for (const [key, value] of Object.entries(before)) expect(after[key]).toBe(value);
    expect(diagnoseCanonicalSkill(home, { sourceRoot, appHome })).toMatchObject({
      status: "pass",
      shape: "one_file",
      compatibility: "compatible",
      freshness: "current",
      ownership: "owned",
    });
    expect(snapshot()).toEqual(after);
  });

  it("refreshes only an owned bootstrap using the registry-selected bundled host surface, retaining internal runtime", () => {
    expect(run().status).toBe("success");
    const internal = fs.readFileSync(path.join(sourceRoot, "skills/agentera/SKILL.md"), "utf8");
    write(path.join(sourceRoot, ".agentera-npx-bundle.json"), "{}");
    write(path.join(sourceRoot, "host/agentera/SKILL.md"), internal + "\nNew bootstrap prose.\n");
    write(path.join(sourceRoot, "skills/agentera/protocol.yaml"), "retained: true\n");
    const runtime = snapshot(sourceRoot);
    expect(diagnoseCanonicalSkill(home, { sourceRoot, appHome })).toMatchObject({
      shape: "one_file",
      compatibility: "compatible",
      freshness: "stale",
    });
    expect(run().status).toBe("success");
    expect(fs.readdirSync(target)).toEqual(["SKILL.md"]);
    expect(fs.readFileSync(file, "utf8")).toContain("New bootstrap prose.");
    expect(snapshot(sourceRoot)).toEqual(runtime);
    expect(run().status).toBe("noop");
  });

  it.each(["extra", "tree", "symlink", "dangling", "unowned", "modified", "replaced", "hardlink", "parent_symlink", "corrupt_journal"])("preserves %s without conversion approval", (kind) => {
    if (["extra", "modified", "replaced", "hardlink", "corrupt_journal"].includes(kind)) expect(run().status).toBe("success");
    if (kind === "extra") write(path.join(target, "notes.txt"), "not owned");
    if (kind === "tree") {
      write(file, loadHostSkillSource(sourceRoot).content);
      write(path.join(target, "capabilities/custom/data"), "preserve");
    }
    if (kind === "symlink" || kind === "dangling") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(kind === "symlink" ? path.join(sourceRoot, "skills/agentera") : path.join(temp, "absent"), target);
    }
    if (kind === "unowned") write(file, loadHostSkillSource(sourceRoot).content);
    if (kind === "modified") fs.appendFileSync(file, "user changes");
    if (kind === "replaced") {
      fs.renameSync(file, path.join(temp, "old"));
      write(file, loadHostSkillSource(sourceRoot).content);
    }
    if (kind === "hardlink") fs.linkSync(file, path.join(temp, "hardlink"));
    if (kind === "parent_symlink") {
      fs.mkdirSync(path.join(temp, "other"));
      fs.symlinkSync(path.join(temp, "other"), path.join(home, ".agents"));
    }
    if (kind === "corrupt_journal") write(path.join(lifecycleOwnershipJournalPath(appHome), "unexpected.json"), "{}");
    const before = snapshot();
    const unsafe = ["hardlink", "parent_symlink", "corrupt_journal"].includes(kind);
    expect(run(false).status).toBe(kind === "unowned" ? "noop" : unsafe ? "non_success" : "pending");
    expect(run().status).toBe(kind === "unowned" ? "noop" : "non_success");
    diagnoseCanonicalSkill(home, { sourceRoot, appHome });
    expect(snapshot()).toEqual(before);
  });

  it.each([HOST_SKILL_DIRECTORY_ID, HOST_SKILL_FILE_ID])("retries interruption before %s publication", (id) => {
    const interrupted = run(true, {
      beforePublication: (boundary) => {
        if (boundary.operationId === id) throw new Error("interrupted");
      },
    });
    expect(interrupted.status).toBe("non_success");
    const retried = run();
    expect(retried.status, JSON.stringify(retried)).toBe("success");
    expect(run().status).toBe("noop");
    expect(fs.readdirSync(target)).toEqual(["SKILL.md"]);
  });

  it("retries an interruption after bootstrap bytes but before final ownership publication", () => {
    let stopped = false;
    const interrupted = run(true, {
      persistLedger: (ledger) => {
        if (!stopped && fs.existsSync(file) && fs.statSync(file).size === Buffer.byteLength(loadHostSkillSource(sourceRoot).content) && ledger.records.some((r) => r.resourceId === HOST_SKILL_FILE_ID && r.status === "pending_create" && r.identity)) {
          stopped = true;
          throw new Error("interruption");
        }
      },
    });
    expect(interrupted.status).toBe("non_success");
    expect(fs.readFileSync(file, "utf8")).toBe(loadHostSkillSource(sourceRoot).content);
    expect(run().status).toBe("success");
    expect(run().status).toBe("noop");
  });

  describe.each([
    [HOST_SKILL_FILE_ID, ".agents/skills/agentera/SKILL.md"],
    [HOST_SKILL_DIRECTORY_ID, ".agents/skills/agentera"],
    ["shared-skill.parent-0", ".agents"],
    ["shared-skill.parent-1", ".agents/skills"],
  ])("SIGKILL before %s creation", (id, relative) => {
    function killBeforeCreate() {
      const destination = path.join(home, relative);
      const killed = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
            import fs from "node:fs";
            import path from "node:path";
            import { runHostSkillLifecycle } from ${JSON.stringify(sourceModuleUrl("setup/hostSkillLifecycle.js"))};
            const destination = ${JSON.stringify(destination)};
            const matches = (value) => {
              try {
                return typeof value === "string" &&
                  path.join(fs.realpathSync(path.dirname(value)), path.basename(value)) === destination;
              } catch { return false; }
            };
            const open = fs.openSync, mkdir = fs.mkdirSync;
            fs.openSync = function (value, flags, ...rest) {
              if (typeof flags === "number" && (flags & fs.constants.O_CREAT) && matches(value))
                process.kill(process.pid, "SIGKILL");
              return open.call(fs, value, flags, ...rest);
            };
            fs.mkdirSync = function (value, ...rest) {
              if (matches(value)) process.kill(process.pid, "SIGKILL");
              return mkdir.call(fs, value, ...rest);
            };
            runHostSkillLifecycle(${JSON.stringify({ home, appHome, sourceRoot, apply: true })});
          `,
        ],
        { cwd: temp, env: sourceSubprocessEnv(), encoding: "utf8", timeout: 10_000 },
      );
      expect(killed.signal, killed.stderr + killed.stdout).toBe("SIGKILL");
      expect(fs.existsSync(destination)).toBe(false);
      expect(readLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(appHome)).ledger.records.find((entry) => entry.resourceId === id)).toMatchObject({ status: "pending_create", identity: null, destination });
      return destination;
    }

    it("preserves a foreign matching resource and journal on preview, apply and later refresh", () => {
      const destination = killBeforeCreate();
      if (id === HOST_SKILL_FILE_ID) fs.writeFileSync(destination, loadHostSkillSource(sourceRoot).content);
      else fs.mkdirSync(destination);
      const identity = fs.lstatSync(destination, { bigint: true });
      const assertBlocked = () => {
        const before = snapshot();
        for (const apply of [false, true]) {
          const result = run(apply);
          const dedicated = [HOST_SKILL_FILE_ID, HOST_SKILL_DIRECTORY_ID].includes(id);
          expect(result.status, JSON.stringify(result)).toBe(dedicated && !apply ? "pending" : "non_success");
          expect(result.reason).toContain(dedicated ? "authorization" : "no recorded publication identity");
          expect(result.operations).toEqual([]);
          expect(snapshot()).toEqual(before);
          const after = fs.lstatSync(destination, { bigint: true });
          expect([after.dev, after.ino]).toEqual([identity.dev, identity.ino]);
          expect(readLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(appHome)).ledger.records.find((entry) => entry.resourceId === id)).toMatchObject({ status: "pending_create", identity: null });
        }
      };
      assertBlocked();
      fs.appendFileSync(path.join(sourceRoot, "skills/agentera/SKILL.md"), "\nRefreshed guidance.\n");
      assertBlocked();
    });

    it("still retries when the destination remains absent", () => {
      killBeforeCreate();
      const before = snapshot();
      expect(run(false).status).toBe("pending");
      expect(snapshot()).toEqual(before);
      const retried = run();
      expect(retried.status, JSON.stringify(retried)).toBe("success");
      expect(run().status).toBe("noop");
      expect(fs.readdirSync(target)).toEqual(["SKILL.md"]);
      expect(fs.readFileSync(file, "utf8")).toBe(loadHostSkillSource(sourceRoot).content);
    });
  });

  it.each(["extra", "replace", "parent"])("fails closed at publication boundary race: %s", (race) => {
    expect(run().status).toBe("success");
    fs.appendFileSync(path.join(sourceRoot, "skills/agentera/SKILL.md"), "\nrefreshed\n");
    const old = fs.readFileSync(file, "utf8");
    const result = run(true, {
      beforePublication: (boundary) => {
        if (boundary.operationId !== HOST_SKILL_FILE_ID) return;
        if (race === "extra") write(path.join(target, "other"), "preserve");
        if (race === "replace") {
          fs.renameSync(file, path.join(temp, "old"));
          write(file, "replacement");
        }
        if (race === "parent") {
          fs.renameSync(target, path.join(temp, "old-directory"));
          fs.symlinkSync(path.join(sourceRoot, "skills/agentera"), target);
        }
      },
    });
    expect(result.status).toBe("non_success");
    if (race === "extra") {
      expect(fs.readFileSync(file, "utf8")).toBe(old);
      expect(fs.readFileSync(path.join(target, "other"), "utf8")).toBe("preserve");
    }
    if (race === "replace") expect(fs.readFileSync(file, "utf8")).toBe("replacement");
    if (race === "parent") expect(fs.readFileSync(path.join(temp, "old-directory/SKILL.md"), "utf8")).toBe(old);
  });

  it("blocks a concurrent journal owner without modifying bootstrap or stealing the lock", () => {
    expect(run().status).toBe("success");
    const lock = acquireLifecycleOwnershipJournalLock(lifecycleOwnershipJournalPath(appHome));
    try {
      const before = snapshot();
      expect(run().status).toBe("non_success");
      expect(snapshot()).toEqual(before);
    } finally {
      releaseLifecycleOwnershipJournalLock(lock);
    }
  });

  it.each(["create", "refresh"])("resumes a partial %s write using only its recorded identity and intended prefix", (mode) => {
    if (mode === "refresh") {
      expect(run().status).toBe("success");
      const source = path.join(sourceRoot, "skills/agentera/SKILL.md");
      fs.writeFileSync(source, fs.readFileSync(source, "utf8").replace("One agent", "An agent"));
    }
    const original = fs.writeSync;
    let interrupted = false;
    const spy = vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, bytes: Buffer, offset: number, length: number, position: number) => {
      if (!interrupted && fs.readlinkSync(`/proc/self/fd/${fd}`) === file) {
        const record = readLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(appHome)).ledger.records.find((entry) => entry.resourceId === HOST_SKILL_FILE_ID);
        const stat = fs.fstatSync(fd, { bigint: true });
        expect(record).toMatchObject({
          status: "pending_create",
          identity: { device: String(stat.dev), inode: String(stat.ino) },
        });
        interrupted = true;
        original(fd, bytes, offset, Math.min(40, length), position);
        throw new Error("simulated partial write interruption");
      }
      return original(fd, bytes, offset, length, position);
    }) as typeof fs.writeSync);
    expect(run().status).toBe("non_success");
    spy.mockRestore();
    expect(interrupted).toBe(true);
    expect(fs.statSync(file).size).toBe(40);
    const retry = run();
    expect(retry.status, JSON.stringify(retry)).toBe("success");
    expect(fs.readFileSync(file, "utf8")).toBe(loadHostSkillSource(sourceRoot).content);
    expect(run().status).toBe("noop");
  });

  it("retries refresh after its durable intent but before bytes, and preserves foreign edits during recovery", () => {
    expect(run().status).toBe("success");
    const source = path.join(sourceRoot, "skills/agentera/SKILL.md");
    fs.writeFileSync(source, fs.readFileSync(source, "utf8").replace("One agent", "An agent"));
    const interrupt = () =>
      run(true, {
        persistLedger: (ledger) => {
          if (ledger.records.some((r) => r.resourceId === HOST_SKILL_FILE_ID && r.status === "pending_create")) throw new Error("after intent");
        },
      });
    expect(interrupt().status).toBe("non_success");
    expect(run().status).toBe("success");
    fs.appendFileSync(source, "\nnext refresh\n");
    expect(interrupt().status).toBe("non_success");
    fs.writeFileSync(file, "unrelated user edit");
    const before = snapshot();
    expect(run().status).toBe("non_success");
    expect(snapshot()).toEqual(before);
  });

  it("does not fall back to the internal tree when a packaged host surface is missing", () => {
    write(path.join(sourceRoot, ".agentera-npx-bundle.json"), "{}");
    const before = snapshot();
    expect(run().status).toBe("non_success");
    expect(snapshot()).toEqual(before);
  });

  it.each(["AGENTERA_HOME", "AGENTERA_DEFAULT_INSTALL_ROOT"])("keeps packaged runtime contracts separate from the %s ownership/data override", (variable) => {
    write(path.join(sourceRoot, ".agentera-npx-bundle.json"), "{}");
    write(path.join(sourceRoot, "host/agentera/SKILL.md"), fs.readFileSync(path.join(sourceRoot, "skills/agentera/SKILL.md"), "utf8"));
    expect(run().status).toBe("success");
    const before = snapshot();
    const model = activeAppModel({
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: sourceRoot,
      [variable]: appHome,
    });
    expect(model).toMatchObject({
      appHome,
      skillRoot: path.join(sourceRoot, "skills/agentera"),
      authoritativeRoot: sourceRoot,
      runtimeRoot: sourceRoot,
    });
    expect(snapshot()).toEqual(before);
  });

  it("rejects ownership state inside the one-file namespace and symlinked app state", () => {
    const before = snapshot();
    expect(runHostSkillLifecycle({ home, appHome: target, sourceRoot, apply: true }).status).toBe("non_success");
    expect(snapshot()).toEqual(before);
    const link = path.join(temp, "app-link");
    fs.symlinkSync(appHome, link);
    const linked = snapshot();
    expect(runHostSkillLifecycle({ home, appHome: link, sourceRoot, apply: true }).status).toBe("non_success");
    expect(snapshot()).toEqual(linked);
  });

  it("diagnoses compatibility independently of shape and selected runtime authority, read-only", () => {
    write(file, "---\nname: agentera\nversion: 2.0.0\n---\nold bootstrap\n");
    expect(diagnoseCanonicalSkill(home, { sourceRoot, appHome })).toMatchObject({
      shape: "one_file",
      compatibility: "incompatible",
      runtime_authority: "available",
    });
    fs.unlinkSync(path.join(sourceRoot, "skills/agentera/SKILL.md"));
    const before = snapshot();
    expect(diagnoseCanonicalSkill(home, { sourceRoot, appHome })).toMatchObject({
      shape: "one_file",
      compatibility: "incompatible",
      runtime_authority: "invalid_host_authority",
    });
    expect(run().status).toBe("non_success");
    expect(snapshot()).toEqual(before);
  });

  it("CLI defaults to preview, requires --yes, rejects incompatible apply modes before any effects", () => {
    const command = (tail: string[]) => {
      let output = "";
      const code = main(["node", "agentera", "upgrade", "--shared-skill", "--home", home, "--install-root", appHome, ...tail], {
        out: (text) => {
          output += text;
        },
        err: (text) => {
          output += text;
        },
      });
      return { code, output };
    };
    const before = snapshot();
    expect(command([]).code).toBe(0);
    for (const tail of [
      ["--yes", "--dry-run"],
      ["--yes", "--project", path.join(temp, "project")],
      ["--yes", "--force"],
      ["--yes", "--verify"],
      ["--yes", "--channel", "development"],
    ])
      expect(command(tail).code).toBe(2);
    expect(snapshot()).toEqual(before);
    const applied = command(["--yes"]);
    expect(applied.code, applied.output).toBe(0);
    expect(fs.readdirSync(target)).toEqual(["SKILL.md"]);
  });
});
