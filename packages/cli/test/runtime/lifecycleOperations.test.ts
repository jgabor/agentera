import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyLifecycleOperations,
  createLifecycleOwnershipManifest,
  emptyLifecycleOwnershipLedger,
  lifecycleOperationFingerprint,
  planLifecycleOperations,
  readLifecycleOwnershipLedger,
  writeLifecycleOwnershipLedgerAtomic,
  type LifecycleOperationSpec,
  type LifecycleOwnershipLedger,
  type LifecycleOwnershipRecord,
  type LifecyclePlanAction,
  type LifecycleResourceState,
} from "../../src/runtime/lifecycleOperations.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-lifecycle-operations-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function fileSpec(
  id: string,
  destination: string,
  content = "desired\n",
  overrides: Partial<LifecycleOperationSpec> = {},
): LifecycleOperationSpec {
  return { id, destination, kind: "file", intent: "ensure", content, ...overrides };
}

function recordFor(
  spec: LifecycleOperationSpec,
  overrides: Partial<LifecycleOwnershipRecord> = {},
): LifecycleOwnershipRecord {
  return {
    resourceId: spec.id,
    destination: path.resolve(spec.destination),
    kind: spec.kind,
    scope: "whole",
    status: "managed",
    fingerprint: lifecycleOperationFingerprint(spec),
    ...overrides,
  };
}

function ledger(records: LifecycleOwnershipRecord[]): LifecycleOwnershipLedger {
  return { ...emptyLifecycleOwnershipLedger(), records };
}

interface ResourceCase {
  name: string;
  expectedState: LifecycleResourceState;
  expectedAction: LifecyclePlanAction;
  expectedOwnership: string;
  arrange: (destination: string) => {
    spec: LifecycleOperationSpec;
    ledger: LifecycleOwnershipLedger;
  };
}

const resourceCases: ResourceCase[] = [
  {
    name: "exact",
    expectedState: "exact",
    expectedAction: "noop",
    expectedOwnership: "managed",
    arrange(destination) {
      const spec = fileSpec("resource", destination);
      fs.writeFileSync(destination, spec.content as string);
      return { spec, ledger: ledger([recordFor(spec)]) };
    },
  },
  {
    name: "modified",
    expectedState: "modified",
    expectedAction: "update",
    expectedOwnership: "managed",
    arrange(destination) {
      const spec = fileSpec("resource", destination);
      fs.writeFileSync(destination, "user-visible drift\n");
      return { spec, ledger: ledger([recordFor(spec)]) };
    },
  },
  {
    name: "missing",
    expectedState: "missing",
    expectedAction: "create",
    expectedOwnership: "claimable",
    arrange(destination) {
      return { spec: fileSpec("resource", destination), ledger: ledger([]) };
    },
  },
  {
    name: "legacy",
    expectedState: "legacy",
    expectedAction: "remove",
    expectedOwnership: "legacy",
    arrange(destination) {
      const spec: LifecycleOperationSpec = {
        id: "resource",
        destination,
        kind: "file",
        intent: "remove",
      };
      fs.writeFileSync(destination, "legacy\n");
      return {
        spec,
        ledger: ledger([recordFor(spec, { status: "legacy", fingerprint: null })]),
      };
    },
  },
  {
    name: "symlinked",
    expectedState: "symlinked",
    expectedAction: "action_required",
    expectedOwnership: "managed",
    arrange(destination) {
      const spec = fileSpec("resource", destination);
      const target = path.join(root, "target.txt");
      fs.writeFileSync(target, "target\n");
      fs.symlinkSync(target, destination);
      return { spec, ledger: ledger([recordFor(spec)]) };
    },
  },
  {
    name: "wrong type",
    expectedState: "wrong_type",
    expectedAction: "action_required",
    expectedOwnership: "managed",
    arrange(destination) {
      const spec = fileSpec("resource", destination);
      fs.mkdirSync(destination);
      return { spec, ledger: ledger([recordFor(spec)]) };
    },
  },
  {
    name: "partially managed",
    expectedState: "partial_managed",
    expectedAction: "action_required",
    expectedOwnership: "partial",
    arrange(destination) {
      const spec = fileSpec("resource", destination);
      fs.writeFileSync(destination, spec.content as string);
      return { spec, ledger: ledger([recordFor(spec, { scope: "partial" })]) };
    },
  },
  {
    name: "unowned even when content is exact",
    expectedState: "unowned",
    expectedAction: "blocked_unowned",
    expectedOwnership: "unowned",
    arrange(destination) {
      const spec = fileSpec("resource", destination);
      fs.writeFileSync(destination, spec.content as string);
      return { spec, ledger: ledger([]) };
    },
  },
];

describe("lifecycle resource planning", () => {
  it.each(resourceCases)(
    "classifies $name resources deterministically",
    ({ arrange, expectedAction, expectedOwnership, expectedState }) => {
      const destination = path.join(root, "resource");
      const arranged = arrange(destination);
      const manifest = createLifecycleOwnershipManifest([arranged.spec]);

      const first = planLifecycleOperations({
        allowedRoots: [root],
        operations: [arranged.spec],
        manifest,
        ledger: arranged.ledger,
      });
      const second = planLifecycleOperations({
        allowedRoots: [root],
        operations: [arranged.spec],
        manifest,
        ledger: arranged.ledger,
      });

      expect(first).toEqual(second);
      expect(first.operations[0]).toMatchObject({
        state: expectedState,
        action: expectedAction,
        ownership: expectedOwnership,
      });
    },
  );

  it("rejects ambiguous ledger ownership instead of selecting a record", () => {
    const destination = path.join(root, "resource");
    const spec = fileSpec("resource", destination);
    fs.writeFileSync(destination, spec.content as string);
    const duplicate = recordFor(spec);

    const plan = planLifecycleOperations({
      allowedRoots: [root],
      operations: [spec],
      manifest: createLifecycleOwnershipManifest([spec]),
      ledger: ledger([duplicate, { ...duplicate }]),
    });

    expect(plan.operations[0]).toMatchObject({
      state: "ambiguous_ownership",
      ownership: "ambiguous",
      action: "action_required",
    });
  });
});

function snapshotTree(directory: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const entry = path.join(current, name);
      const relative = path.relative(directory, entry);
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) snapshot[relative] = `link:${fs.readlinkSync(entry)}`;
      else if (stat.isDirectory()) {
        snapshot[relative] = "directory";
        visit(entry);
      } else snapshot[relative] = `file:${fs.readFileSync(entry, "hex")}`;
    }
  };
  visit(directory);
  return snapshot;
}

describe("preview purity and path safety", () => {
  it("does not mutate absent parents, ledger state, or invoke native processes", () => {
    const stateDir = path.join(root, "absent", "state");
    const targetDir = path.join(stateDir, "resources");
    const ledgerPath = path.join(stateDir, "ownership.json");
    const operations: LifecycleOperationSpec[] = [
      { id: "state-dir", destination: stateDir, kind: "directory", intent: "ensure" },
      {
        id: "target-dir",
        destination: targetDir,
        kind: "directory",
        intent: "ensure",
        dependsOn: ["state-dir"],
      },
      fileSpec("target", path.join(targetDir, "agentera.json"), "{}\n", {
        dependsOn: ["target-dir"],
      }),
    ];
    const manifest = createLifecycleOwnershipManifest(operations);
    const ownership = readLifecycleOwnershipLedger(ledgerPath);
    const beforeTree = snapshotTree(root);
    const beforeState = JSON.stringify({ manifest, ownership });
    const mutationSpies = [
      vi.spyOn(fs, "mkdirSync"),
      vi.spyOn(fs, "writeFileSync"),
      vi.spyOn(fs, "renameSync"),
      vi.spyOn(fs, "unlinkSync"),
      vi.spyOn(fs, "rmSync"),
      vi.spyOn(fs, "symlinkSync"),
    ];
    const execSpy = vi.spyOn(childProcess, "execFileSync");
    const spawnSpy = vi.spyOn(childProcess, "spawnSync");

    const preview = planLifecycleOperations({
      allowedRoots: [root],
      operations,
      manifest,
      ledger: ownership,
    });

    expect(preview.operations.map((operation) => operation.action)).toEqual([
      "create",
      "create",
      "create",
    ]);
    expect(snapshotTree(root)).toEqual(beforeTree);
    expect(JSON.stringify({ manifest, ownership })).toBe(beforeState);
    expect(fs.existsSync(ledgerPath)).toBe(false);
    for (const spy of mutationSpies) expect(spy).not.toHaveBeenCalled();
    expect(execSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("rejects parent symlink traversal without writing through the link", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-lifecycle-outside-"));
    try {
      const linkedParent = path.join(root, "linked");
      fs.symlinkSync(outside, linkedParent);
      const spec = fileSpec("escape", path.join(linkedParent, "owned.txt"));
      const plan = planLifecycleOperations({
        allowedRoots: [root],
        operations: [spec],
        manifest: createLifecycleOwnershipManifest([spec]),
      });

      expect(plan.operations[0]).toMatchObject({
        state: "unsafe_path",
        action: "action_required",
      });
      const applied = applyLifecycleOperations(plan);
      expect(applied.operations[0].status).toBe("action_required");
      expect(fs.existsSync(path.join(outside, "owned.txt"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects symlink targets that escape an allowed root", () => {
    const spec: LifecycleOperationSpec = {
      id: "link",
      destination: path.join(root, "link"),
      kind: "symlink",
      intent: "ensure",
      linkTarget: "../../outside",
    };
    const plan = planLifecycleOperations({
      allowedRoots: [root],
      operations: [spec],
      manifest: createLifecycleOwnershipManifest([spec]),
    });
    expect(plan.operations[0]).toMatchObject({ state: "unsafe_path", action: "action_required" });
  });
});

describe("apply convergence", () => {
  it("continues independent work, skips dependents, and converges truthfully on retry", () => {
    const managedDir = path.join(root, "managed");
    const a = path.join(managedDir, "a.txt");
    const b = path.join(managedDir, "b.txt");
    const c = path.join(managedDir, "c.txt");
    const ledgerPath = path.join(root, "ownership.json");
    const operations: LifecycleOperationSpec[] = [
      { id: "directory", destination: managedDir, kind: "directory", intent: "ensure" },
      fileSpec("a", a, "A\n", { dependsOn: ["directory"] }),
      fileSpec("b", b, "B\n", { dependsOn: ["directory"] }),
      fileSpec("c", c, "C\n", { dependsOn: ["a"] }),
    ];
    const manifest = createLifecycleOwnershipManifest(operations);
    const initialLedger = emptyLifecycleOwnershipLedger();
    const originalRename = fs.renameSync.bind(fs);
    let failA = true;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (failA && path.resolve(destination.toString()) === a) {
        failA = false;
        const error = new Error("simulated partial write failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return originalRename(source, destination);
    });

    const first = applyLifecycleOperations(
      planLifecycleOperations({
        allowedRoots: [root],
        operations,
        manifest,
        ledger: initialLedger,
      }),
      { persistLedger: (next) => writeLifecycleOwnershipLedgerAtomic(ledgerPath, next) },
    );

    expect(first.status).toBe("non_success");
    expect(first.summary).toEqual({
      applied: 2,
      noop: 0,
      failed: 1,
      blocked_unowned: 0,
      skipped_dependency: 1,
      action_required: 0,
    });
    expect(first.operations.map(({ id, status }) => [id, status])).toEqual([
      ["directory", "applied"],
      ["a", "failed"],
      ["b", "applied"],
      ["c", "skipped_dependency"],
    ]);
    expect(first.operations[3].dependencyCauses).toEqual(["a"]);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.readFileSync(b, "utf8")).toBe("B\n");
    expect(readLifecycleOwnershipLedger(ledgerPath).records.find((item) => item.resourceId === "a")?.status)
      .toBe("pending_create");

    vi.restoreAllMocks();
    const retryLedger = readLifecycleOwnershipLedger(ledgerPath);
    const retry = applyLifecycleOperations(
      planLifecycleOperations({ allowedRoots: [root], operations, manifest, ledger: retryLedger }),
      { persistLedger: (next) => writeLifecycleOwnershipLedgerAtomic(ledgerPath, next) },
    );

    expect(retry.status).toBe("success");
    expect(retry.operations.map(({ id, status }) => [id, status])).toEqual([
      ["directory", "noop"],
      ["a", "applied"],
      ["b", "noop"],
      ["c", "applied"],
    ]);
    expect(fs.readFileSync(a, "utf8")).toBe("A\n");
    expect(fs.readFileSync(c, "utf8")).toBe("C\n");
    expect(readLifecycleOwnershipLedger(ledgerPath).records.every((item) => item.status === "managed"))
      .toBe(true);

    const final = applyLifecycleOperations(
      planLifecycleOperations({
        allowedRoots: [root],
        operations,
        manifest,
        ledger: readLifecycleOwnershipLedger(ledgerPath),
      }),
    );
    expect(final.status).toBe("success");
    expect(final.operations.every((operation) => operation.status === "noop")).toBe(true);
  });

  it("reports optional unmet outcomes without making the aggregate fail", () => {
    const destination = path.join(root, "user-owned.txt");
    fs.writeFileSync(destination, "user\n");
    const spec = fileSpec("optional", destination, "agentera\n", { required: false });
    const result = applyLifecycleOperations(
      planLifecycleOperations({
        allowedRoots: [root],
        operations: [spec],
        manifest: createLifecycleOwnershipManifest([spec]),
      }),
    );

    expect(result.operations[0].status).toBe("blocked_unowned");
    expect(result.requiredUnmet).toEqual([]);
    expect(result.status).toBe("success");
    expect(fs.readFileSync(destination, "utf8")).toBe("user\n");
  });

  it("finalizes a journaled create after the resource write outlives a ledger failure", () => {
    const destination = path.join(root, "created.txt");
    const spec = fileSpec("created", destination, "created\n");
    const manifest = createLifecycleOwnershipManifest([spec]);
    let persistCalls = 0;
    const first = applyLifecycleOperations(
      planLifecycleOperations({ allowedRoots: [root], operations: [spec], manifest }),
      {
        persistLedger(next) {
          persistCalls += 1;
          if (persistCalls === 2) throw new Error("simulated final ledger failure");
          expect(next.records[0].status).toBe("pending_create");
        },
      },
    );

    expect(first.operations[0].status).toBe("failed");
    expect(first.ownershipLedger.records[0].status).toBe("pending_create");
    expect(fs.readFileSync(destination, "utf8")).toBe("created\n");

    const writeSpy = vi.spyOn(fs, "writeFileSync");
    const retry = applyLifecycleOperations(
      planLifecycleOperations({
        allowedRoots: [root],
        operations: [spec],
        manifest,
        ledger: first.ownershipLedger,
      }),
    );

    expect(retry.operations[0]).toMatchObject({
      state: "exact",
      action: "finalize_ownership",
      status: "applied",
    });
    expect(retry.ownershipLedger.records[0].status).toBe("managed");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("removes only ledger-owned resources and reruns as a no-op", () => {
    const destination = path.join(root, "remove.txt");
    fs.writeFileSync(destination, "managed\n");
    const spec: LifecycleOperationSpec = {
      id: "remove",
      destination,
      kind: "file",
      intent: "remove",
    };
    const manifest = createLifecycleOwnershipManifest([spec]);
    const first = applyLifecycleOperations(
      planLifecycleOperations({
        allowedRoots: [root],
        operations: [spec],
        manifest,
        ledger: ledger([recordFor(spec)]),
      }),
    );
    expect(first.operations[0].status).toBe("applied");
    expect(first.ownershipLedger.records).toEqual([]);
    expect(fs.existsSync(destination)).toBe(false);

    const retry = applyLifecycleOperations(
      planLifecycleOperations({
        allowedRoots: [root],
        operations: [spec],
        manifest,
        ledger: first.ownershipLedger,
      }),
    );
    expect(retry.operations[0].status).toBe("noop");
  });
});

describe("ownership ledger persistence", () => {
  it("writes atomically only when the parent is already a safe directory", () => {
    const ledgerPath = path.join(root, "state", "ownership.json");
    const ownership = emptyLifecycleOwnershipLedger();
    expect(() => writeLifecycleOwnershipLedgerAtomic(ledgerPath, ownership)).toThrow(
      "ownership ledger parent does not exist",
    );
    expect(fs.existsSync(path.dirname(ledgerPath))).toBe(false);

    fs.mkdirSync(path.dirname(ledgerPath));
    writeLifecycleOwnershipLedgerAtomic(ledgerPath, ownership);
    expect(readLifecycleOwnershipLedger(ledgerPath)).toEqual(ownership);
    expect(fs.readdirSync(path.dirname(ledgerPath))).toEqual(["ownership.json"]);
  });
});
