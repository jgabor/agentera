import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostSkillPath, loadHostSkillSource, runHostSkillLifecycle } from "../../src/setup/hostSkillLifecycle.js";
import { appendLifecycleOwnershipJournal, lifecycleOwnershipJournalPath, readLifecycleOwnershipJournal } from "../../src/runtime/lifecycleOwnershipJournal.js";
import { applyLifecycleOperations, createLifecycleOwnershipManifest, planLifecycleOperations, type LifecycleOperationSpec } from "../../src/runtime/lifecycleOperations.js";
import { main } from "../../src/cli/dispatch.js";

const repo = path.resolve(import.meta.dirname, "../../../..");
let temp: string, home: string, appHome: string, sourceRoot: string, target: string;
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
function snapshot(root = temp): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (at: string) => {
    const stat = fs.lstatSync(at);
    entries[path.relative(root, at)] = stat.isSymbolicLink() ? `link:${fs.readlinkSync(at)}` : stat.isDirectory() ? "directory" : fs.readFileSync(at).toString("base64");
    if (stat.isDirectory()) for (const name of fs.readdirSync(at).sort()) visit(path.join(at, name));
  };
  visit(root);
  return entries;
}
const run = (apply = false, authorization?: string, options: Parameters<typeof runHostSkillLifecycle>[1] = {}) => runHostSkillLifecycle({ home, appHome, sourceRoot, apply, authorization }, options);
const token = (result: unknown) => (result as { authorization: string }).authorization;
function owned(kind: "symlink" | "directory") {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const operations: LifecycleOperationSpec[] =
    kind === "symlink"
      ? [
          {
            id: "canonical_skill",
            destination: target,
            kind,
            intent: "ensure",
            linkTarget: path.join(sourceRoot, "skills/agentera"),
          },
        ]
      : [
          { id: "legacy.root", destination: target, kind, intent: "ensure" },
          {
            id: "legacy.skill",
            destination: path.join(target, "SKILL.md"),
            kind: "file",
            intent: "ensure",
            content: "legacy bootstrap",
          },
          {
            id: "legacy.schemas",
            destination: path.join(target, "schemas"),
            kind: "directory",
            intent: "ensure",
          },
          {
            id: "legacy.contract",
            destination: path.join(target, "schemas/contract.yaml"),
            kind: "file",
            intent: "ensure",
            content: "legacy: retained\n",
          },
        ];
  const result = applyLifecycleOperations(
    planLifecycleOperations({
      allowedRoots: [home, sourceRoot],
      operations,
      manifest: createLifecycleOwnershipManifest(operations),
    }),
  );
  expect(result.status, JSON.stringify(result)).toBe("success");
  appendLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(appHome), {
    ...result.ownershipLedger,
    records: result.ownershipLedger.records.map((record) => ({ ...record, status: "legacy" })),
  });
}
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-host-conversion-"));
  home = path.join(temp, "home");
  appHome = path.join(temp, "app");
  sourceRoot = path.join(temp, "runtime");
  fs.mkdirSync(home);
  target = hostSkillPath(home);
  for (const relative of ["references/adapters/package-registry.yaml", "registry.json", "skills/agentera/SKILL.md"]) write(path.join(sourceRoot, relative), fs.readFileSync(path.join(repo, relative), "utf8"));
  write(path.join(sourceRoot, "skills/agentera/protocol.yaml"), "old runtime retained\n");
  write(path.join(appHome, "private/untouched"), "app data");
  vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", sourceRoot);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("evidence-bound legacy host conversion", () => {
  it("CLI previews and applies only the exact host-scoped approval", () => {
    owned("symlink");
    const command = (tail: string[]) => {
      let output = "";
      const code = main(["node", "agentera", "upgrade", "--shared-skill", "--home", home, "--install-root", appHome, ...tail], { out: (text) => (output += text), err: (text) => (output += text) });
      return { code, output };
    };
    const preview = command([]);
    expect(preview.code, preview.output).toBe(0);
    const approval = token(JSON.parse(preview.output));
    expect(command(["--yes"]).code).toBe(1);
    const applied = command(["--yes", "--authorization", approval]);
    expect(applied.code, applied.output).toBe(0);
    expect(JSON.parse(applied.output).status).toBe("success");
    expect(command(["--yes", "--authorization", approval]).code).toBe(0);
    const before = snapshot();
    expect(
      main(["node", "agentera", "upgrade", "--yes", "--authorization", approval], {
        out: () => {},
        err: () => {},
      }),
    ).toBe(2);
    expect(snapshot()).toEqual(before);
  });

  it("recovers a move completed before its ownership relocation checkpoint", () => {
    owned("directory");
    const approval = token(run());
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (path.basename(String(to)) === "legacy") throw new Error("interrupted after atomic move");
    });
    expect(run(true, approval).status).toBe("non_success");
    vi.restoreAllMocks();
    const resumed = run(true, approval);
    expect(resumed.status, JSON.stringify(resumed)).toBe("success");
    expect(fs.readdirSync(target)).toEqual(["SKILL.md"]);
  });

  it("rejects a replaced parent at the pinned move boundary without following it", () => {
    owned("directory");
    const approval = token(run());
    const outside = path.join(temp, "outside");
    write(path.join(outside, "agentera/user"), "retain outside");
    const before = snapshot(outside);
    let calls = 0;
    const result = run(true, approval, {
      beforePublication: (boundary) => {
        if (boundary.operationId === "shared-skill.convert" && ++calls === 2) {
          fs.renameSync(path.dirname(target), path.join(home, ".agents/saved-skills"));
          fs.symlinkSync(outside, path.dirname(target));
        }
      },
    });
    expect(result.status).toBe("non_success");
    expect(snapshot(outside)).toEqual(before);
    expect(fs.readFileSync(path.join(home, ".agents/saved-skills/agentera/schemas/contract.yaml"), "utf8")).toBe("legacy: retained\n");
  });
  it.each(["symlink", "directory"] as const)("previews exact %s ownership, retains old data and converges with matching approval", (kind) => {
    owned(kind);
    const before = snapshot(),
      runtime = snapshot(sourceRoot),
      original = snapshot(target);
    const preview = run();
    expect(preview.status, JSON.stringify(preview)).toBe("pending");
    expect(snapshot()).toEqual(before);
    expect(preview).toMatchObject({
      affectedPaths: expect.arrayContaining([target, path.join(target, "SKILL.md"), lifecycleOwnershipJournalPath(appHome)]),
      resultingShape: { files: ["SKILL.md"] },
      retained: { targetDataModified: false },
    });
    expect(token(preview)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(run(true).status).toBe("non_success");
    expect(run(true, "sha256:wrong").status).toBe("non_success");
    expect(snapshot()).toEqual(before);
    const applied = run(true, token(preview));
    expect(applied.status, JSON.stringify(applied)).toBe("success");
    expect(fs.readdirSync(target)).toEqual(["SKILL.md"]);
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe(loadHostSkillSource(sourceRoot).content);
    const retained = (applied as unknown as { retained: { path: string } }).retained.path;
    expect(snapshot(retained)).toEqual(original);
    expect(snapshot(sourceRoot)).toEqual(runtime);
    const after = snapshot();
    expect(run(true, token(preview)).status).toBe("noop");
    expect(snapshot()).toEqual(after);
    expect(run(true).status).toBe("noop");
    const journal = readLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(appHome));
    expect(journal.ledger.records.some((record) => record.destination === retained && record.resourceId.startsWith("shared-skill.retained."))).toBe(true);
  });

  it.each(["extra", "changed", "identity", "ambiguous", "unowned", "pending-null"])("rejects %s ownership before effects", (change) => {
    owned("directory");
    const preview = run();
    const journalPath = lifecycleOwnershipJournalPath(appHome),
      journal = readLifecycleOwnershipJournal(journalPath);
    if (change === "extra") write(path.join(target, "user-data"), "private");
    if (change === "changed") write(path.join(target, "schemas/contract.yaml"), "user change");
    if (change === "identity") {
      fs.renameSync(path.join(target, "SKILL.md"), path.join(temp, "old"));
      write(path.join(target, "SKILL.md"), "legacy bootstrap");
    }
    if (change === "ambiguous")
      appendLifecycleOwnershipJournal(journalPath, {
        ...journal.ledger,
        records: [...journal.ledger.records, { ...journal.ledger.records[0]!, resourceId: "duplicate" }],
      });
    if (change === "unowned") appendLifecycleOwnershipJournal(journalPath, { ...journal.ledger, records: [] });
    if (change === "pending-null")
      appendLifecycleOwnershipJournal(journalPath, {
        ...journal.ledger,
        records: journal.ledger.records.map((record) => ({
          ...record,
          status: "pending_create",
          identity: null,
        })),
      });
    const before = snapshot();
    expect(run(true, token(preview)).status).toBe("non_success");
    expect(snapshot()).toEqual(before);
  });

  it("binds approval to source bytes and scope and refuses CLI mode combinations", () => {
    owned("symlink");
    const approval = token(run());
    write(path.join(sourceRoot, "skills/agentera/SKILL.md"), loadHostSkillSource(sourceRoot).content + "\nchanged source\n");
    const before = snapshot();
    expect(run(true, approval).status).toBe("non_success");
    expect(snapshot()).toEqual(before);
    expect(
      runHostSkillLifecycle({
        home,
        appHome: path.join(temp, "other-app"),
        sourceRoot,
        apply: true,
        authorization: approval,
      }).status,
    ).toBe("non_success");
    expect(
      main(["node", "agentera", "upgrade", "--shared-skill", "--project", temp, "--yes", "--authorization", approval], {
        out: () => {},
        err: () => {},
      }),
    ).toBe(2);
  });

  it("rechecks source and ownership at the actual move boundary", () => {
    owned("symlink");
    const approval = token(run());
    let calls = 0;
    const result = run(true, approval, {
      beforePublication: (boundary) => {
        if (boundary.operationId === "shared-skill.convert" && ++calls === 2) {
          fs.unlinkSync(target);
          fs.symlinkSync(path.join(temp, "user-target"), target);
        }
      },
    });
    expect(result.status).toBe("non_success");
    expect(fs.readlinkSync(target)).toBe(path.join(temp, "user-target"));
    expect(fs.readFileSync(path.join(sourceRoot, "skills/agentera/protocol.yaml"), "utf8")).toBe("old runtime retained\n");
  });

  it.each(["intent", "moved", "created"])("retries interrupted %s with the original approval only", (stage) => {
    owned("directory");
    const approval = token(run());
    let interrupted = false;
    const first = run(true, approval, {
      persistLedger: (ledger) => {
        const hit = stage === "intent" ? ledger.records.some((r) => r.resourceId.startsWith("shared-skill.conversion.")) : stage === "moved" ? ledger.records.some((r) => r.resourceId.startsWith("shared-skill.retained.")) : ledger.records.some((r) => r.resourceId === "shared-skill.bootstrap" && r.status === "managed");
        if (hit && !interrupted) {
          interrupted = true;
          throw new Error("fixture interruption");
        }
      },
    });
    expect(interrupted).toBe(true);
    expect(first.status).toBe("non_success");
    const before = snapshot();
    expect(run(true).status).toBe("non_success");
    expect(snapshot()).toEqual(before);
    const resumed = run(true, approval);
    expect(resumed.status, JSON.stringify(resumed)).toBe("success");
    expect(fs.readdirSync(target)).toEqual(["SKILL.md"]);
  });
});
