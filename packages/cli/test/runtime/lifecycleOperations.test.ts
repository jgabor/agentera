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
import * as lifecyclePublication from "../../src/runtime/lifecyclePublication.js";

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
    identity: fs.existsSync(spec.destination)
      ? (() => {
          const stat = fs.lstatSync(spec.destination, { bigint: true });
          return { device: stat.dev.toString(), inode: stat.ino.toString() };
        })()
      : null,
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
    expectedAction: "action_required",
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

  it("fails closed when managed provenance has no publication identity", () => {
    const destination = path.join(root, "resource");
    const spec = fileSpec("resource", destination);
    fs.writeFileSync(destination, spec.content as string);

    expect(() => planLifecycleOperations({
      allowedRoots: [root],
      operations: [spec],
      manifest: createLifecycleOwnershipManifest([spec]),
      ledger: ledger([recordFor(spec, { identity: null })]),
    })).toThrow("identity is required for managed ownership");
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

describe("adversarial publication boundary", () => {
  it("does not overwrite or claim a target that appears after the missing-resource check", () => {
    const destination = path.join(root, "appeared.txt");
    const spec = fileSpec("appeared", destination, "agentera\n");
    const unlinkSpy = vi.spyOn(fs, "unlinkSync");

    const first = applyLifecycleOperations(
      planLifecycleOperations({
        allowedRoots: [root],
        operations: [spec],
        manifest: createLifecycleOwnershipManifest([spec]),
      }),
      {
        beforePublication(boundary) {
          expect(boundary.action).toBe("create");
          fs.writeFileSync(destination, "user\n");
        },
      },
    );

    expect(first.operations[0].status).toBe("failed");
    expect(fs.readFileSync(destination, "utf8")).toBe("user\n");
    expect(first.ownershipLedger.records[0]).toMatchObject({
      status: "pending_create",
      identity: null,
    });
    const retry = planLifecycleOperations({
      allowedRoots: [root],
      operations: [spec],
      manifest: createLifecycleOwnershipManifest([spec]),
      ledger: first.ownershipLedger,
    });
    expect(retry.operations[0]).toMatchObject({
      state: "partial_managed",
      action: "action_required",
    });
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it("does not replace or unlink a symlink that appears at publication", () => {
    const destination = path.join(root, "runtime-link");
    const userTarget = path.join(root, "user-target");
    const spec: LifecycleOperationSpec = {
      id: "appeared-link",
      destination,
      kind: "symlink",
      intent: "ensure",
      linkTarget: "agentera-target",
    };
    const unlinkSpy = vi.spyOn(fs, "unlinkSync");

    const result = applyLifecycleOperations(
      planLifecycleOperations({
        allowedRoots: [root],
        operations: [spec],
        manifest: createLifecycleOwnershipManifest([spec]),
      }),
      {
        beforePublication() {
          fs.symlinkSync(userTarget, destination);
        },
      },
    );

    expect(result.operations[0].status).toBe("failed");
    expect(fs.readlinkSync(destination)).toBe(userTarget);
    expect(result.ownershipLedger.records[0].identity).toBeNull();
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it("does not modify a target whose inode is replaced after owned-resource validation", () => {
    const destination = path.join(root, "owned.txt");
    const displaced = path.join(root, "owned.displaced.txt");
    const spec = fileSpec("owned", destination, "desired\n");
    fs.writeFileSync(destination, "managed drift\n");
    const ownership = ledger([recordFor(spec)]);
    const unlinkSpy = vi.spyOn(fs, "unlinkSync");

    const result = applyLifecycleOperations(
      planLifecycleOperations({
        allowedRoots: [root],
        operations: [spec],
        manifest: createLifecycleOwnershipManifest([spec]),
        ledger: ownership,
      }),
      {
        beforePublication() {
          fs.renameSync(destination, displaced);
          fs.writeFileSync(destination, "user replacement\n");
        },
      },
    );

    expect(result.operations[0].status).toBe("failed");
    expect(fs.readFileSync(destination, "utf8")).toBe("user replacement\n");
    expect(fs.readFileSync(displaced, "utf8")).toBe("managed drift\n");
    expect(result.ownershipLedger).toEqual(ownership);
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it("blocks a parent swap and symlink substitution without escaping the allowed root", () => {
    const parent = path.join(root, "parent");
    const displacedParent = path.join(root, "parent.displaced");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-publication-outside-"));
    fs.mkdirSync(parent);
    const destination = path.join(parent, "owned.txt");
    const spec = fileSpec("parent-swap", destination, "agentera\n");
    try {
      const result = applyLifecycleOperations(
        planLifecycleOperations({
          allowedRoots: [root],
          operations: [spec],
          manifest: createLifecycleOwnershipManifest([spec]),
        }),
        {
          beforePublication() {
            fs.renameSync(parent, displacedParent);
            fs.symlinkSync(outside, parent);
          },
        },
      );

      expect(result.operations[0].status).toBe("failed");
      expect(fs.existsSync(path.join(outside, "owned.txt"))).toBe(false);
      expect(fs.existsSync(path.join(displacedParent, "owned.txt"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("ignores a colliding former temp name and never unlinks it", () => {
    const destination = path.join(root, "published.txt");
    const formerTemporary = `${destination}.tmp.${process.pid}.123`;
    const spec = fileSpec("temp-collision", destination, "agentera\n");
    const unlinkSpy = vi.spyOn(fs, "unlinkSync");

    const result = applyLifecycleOperations(
      planLifecycleOperations({
        allowedRoots: [root],
        operations: [spec],
        manifest: createLifecycleOwnershipManifest([spec]),
      }),
      {
        beforePublication() {
          fs.writeFileSync(formerTemporary, "user temp collision\n");
        },
      },
    );

    expect(result.operations[0].status).toBe("applied");
    expect(fs.readFileSync(destination, "utf8")).toBe("agentera\n");
    expect(fs.readFileSync(formerTemporary, "utf8")).toBe("user temp collision\n");
    expect(unlinkSpy).not.toHaveBeenCalled();
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
    const originalOpen = fs.openSync.bind(fs);
    const originalWrite = fs.writeSync.bind(fs);
    let aDescriptor: number | undefined;
    let failA = true;
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      const fd = originalOpen(target, flags, mode);
      if (
        typeof target === "string"
        && target.endsWith("/a.txt")
        && typeof flags === "number"
        && (flags & fs.constants.O_EXCL) !== 0
      ) {
        aDescriptor = fd;
      }
      return fd;
    });
    vi.spyOn(fs, "writeSync").mockImplementation((fd, buffer, offset, length, position) => {
      if (failA && fd === aDescriptor) {
        failA = false;
        const error = new Error("simulated partial write failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return originalWrite(fd, buffer, offset, length, position);
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
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.readFileSync(a, "utf8")).toBe("");
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
          if (persistCalls === 3) throw new Error("simulated final ledger failure");
          if (persistCalls < 3) expect(next.records[0].status).toBe("pending_create");
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

  it("recovers an exact publication after restart when only the pre-create journal record survived", () => {
    const destination = path.join(root, "published-before-ledger.txt");
    const spec = fileSpec("published-before-ledger", destination, "published\n");
    fs.writeFileSync(destination, spec.content as string);
    const pending = recordFor(spec, { status: "pending_create", identity: null });

    const preview = planLifecycleOperations({
      allowedRoots: [root],
      operations: [spec],
      manifest: createLifecycleOwnershipManifest([spec]),
      ledger: ledger([pending]),
    });

    expect(preview.operations[0]).toMatchObject({
      state: "exact",
      action: "finalize_ownership",
      ownership: "managed",
    });
    const restarted = applyLifecycleOperations(preview);
    expect(restarted.operations[0]).toMatchObject({ status: "applied", action: "finalize_ownership" });
    expect(restarted.ownershipLedger.records[0]).toMatchObject({ status: "managed" });
    expect(restarted.ownershipLedger.records[0].identity).not.toBeNull();
  });

  it("fails closed for removal when Node cannot conditionally unlink the validated inode", () => {
    const destination = path.join(root, "remove.txt");
    fs.writeFileSync(destination, "managed\n");
    const spec: LifecycleOperationSpec = {
      id: "remove",
      destination,
      kind: "file",
      intent: "remove",
    };
    const manifest = createLifecycleOwnershipManifest([spec]);
    const observed = lifecyclePublication.observeLifecyclePath(destination, [root]);
    vi.spyOn(lifecyclePublication, "secureLifecycleRemovalAvailable").mockReturnValue(false);
    const first = applyLifecycleOperations(
      planLifecycleOperations({
        allowedRoots: [root],
        operations: [spec],
        manifest,
        ledger: ledger([recordFor(spec, { fingerprint: observed.fingerprint })]),
      }),
    );
    expect(first.operations[0]).toMatchObject({
      action: "action_required",
      status: "action_required",
      reason: "safe removal requires Linux /proc/self/fd pinned-parent access",
    });
    expect(first.ownershipLedger.records).toHaveLength(1);
    expect(fs.readFileSync(destination, "utf8")).toBe("managed\n");
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

  it("preserves the previous complete snapshot when replacement is interrupted before publication", () => {
    const ledgerPath = path.join(root, "ownership.json");
    const previous = ledger([{
      resourceId: "durable",
      destination: path.join(root, "durable"),
      kind: "file",
      scope: "whole",
      status: "pending_create",
      fingerprint: "sha256:durable",
      identity: null,
    }]);
    writeLifecycleOwnershipLedgerAtomic(ledgerPath, previous);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated interruption before ledger publication");
    });

    expect(() => writeLifecycleOwnershipLedgerAtomic(ledgerPath, emptyLifecycleOwnershipLedger()))
      .toThrow("simulated interruption");
    expect(readLifecycleOwnershipLedger(ledgerPath)).toEqual(previous);
    expect(fs.readdirSync(root).filter((name) => name.includes(".next-"))).toEqual([]);
  });
});
