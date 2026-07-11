import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LIFECYCLE_LEDGER_SCHEMA,
  type LifecycleOwnershipLedger,
} from "../../src/runtime/lifecycleOperations.js";
import { observeLifecyclePath } from "../../src/runtime/lifecyclePublication.js";
import {
  applyRetiredRuntimeCleanup,
  loadRetiredRuntimeCleanupContract,
  previewRetiredRuntimeCleanup,
  validateRetiredRuntimeCleanupContractData,
  validateRetiredRuntimeCleanupContractRoot,
} from "../../src/runtime/retiredRuntimeCleanup.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-retired-runtime-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function destination(): string {
  return path.join(home, ".claude", "skills", "agentera");
}

function installLegacySymlink(): { target: string; ledger: LifecycleOwnershipLedger } {
  const target = path.join(home, ".agents", "skills", "agentera");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "SKILL.md"), "owned target\n");
  fs.mkdirSync(path.dirname(destination()), { recursive: true });
  fs.symlinkSync(target, destination());
  const observation = observeLifecyclePath(destination(), [home]);
  expect(observation.kind).toBe("symlink");
  expect(observation.identity).toBeDefined();
  expect(observation.fingerprint).toBeDefined();
  return {
    target,
    ledger: {
      schemaVersion: LIFECYCLE_LEDGER_SCHEMA,
      owner: "agentera",
      records: [
        {
          resourceId: "claude.agentera-skill-link",
          destination: destination(),
          kind: "symlink",
          scope: "whole",
          status: "legacy",
          fingerprint: observation.fingerprint as string,
          identity: observation.identity as { device: string; inode: string },
        },
      ],
    },
  };
}

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const entry = path.join(current, name);
      const relative = path.relative(root, entry);
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) result[relative] = `link:${fs.readlinkSync(entry)}`;
      else if (stat.isDirectory()) {
        result[relative] = "directory";
        visit(entry);
      } else result[relative] = `file:${fs.readFileSync(entry, "utf8")}`;
    }
  };
  visit(root);
  return result;
}

describe("retired runtime cleanup contract", () => {
  it("loads as retired migration evidence without entering active inventory", () => {
    const contract = loadRetiredRuntimeCleanupContract();
    expect(contract.runtimes.map((runtime) => runtime.id)).toEqual(["claude"]);
    expect(contract.runtimes[0]).toMatchObject({ sourceProduct: "claude-code" });
    expect(validateRetiredRuntimeCleanupContractRoot()).toEqual([]);
  });

  it("rejects a retired record that claims active runtime support", () => {
    const data = {
      schema_version: "agentera.retiredRuntimeResources.v1",
      status: "retired_migration_contract",
      decision: 92,
      authority: "references/adapters/runtime-lifecycle-authority.yaml",
      operation_contract: "references/adapters/runtime-lifecycle-operation-contract.yaml",
      policy: {
        active_inventory_exposure: "forbidden",
        preview: "strictly_read_only",
        apply_requires: "explicit_approval",
        ownership: "matching_whole_resource_legacy_ledger_identity_and_fingerprint",
        unsupported_platform_result: "action_required",
      },
      retired_runtimes: [{
        id: "claude",
        active_runtime: true,
        source_product: "claude-code",
        resources: [{ id: "claude.agentera-skill-link", kind: "symlink", intent: "remove", destination: "{home}/.claude/skills/agentera" }],
        never_touch: ["projects", "settings", "credentials", "conversations", "cache", "stats"],
      }],
    };
    expect(validateRetiredRuntimeCleanupContractData(data)).toContain(
      "retired Claude record must be inactive with source_product claude-code",
    );
  });
});

describe("retired Claude resource cleanup", () => {
  it("keeps preview pure, requires approval, removes the owned link, and converges to noop", () => {
    const { target, ledger } = installLegacySymlink();
    const before = snapshot(home);
    const preview = previewRetiredRuntimeCleanup({ runtimeId: "claude", home, ledger });

    expect(preview.plan.operations).toEqual([
      expect.objectContaining({ action: "remove", ownership: "legacy", state: "legacy" }),
    ]);
    expect(snapshot(home)).toEqual(before);

    const unapproved = applyRetiredRuntimeCleanup(preview, { approved: false });
    expect(unapproved.status).toBe("non_success");
    expect(unapproved.operations[0].status).toBe("action_required");
    expect(fs.lstatSync(destination()).isSymbolicLink()).toBe(true);

    const applied = applyRetiredRuntimeCleanup(preview, { approved: true });
    expect(applied.status).toBe("success");
    expect(applied.operations[0].status).toBe("applied");
    expect(fs.existsSync(destination())).toBe(false);
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe("owned target\n");
    expect(applied.ownershipLedger.records).toEqual([]);

    const repeat = previewRetiredRuntimeCleanup({
      runtimeId: "claude",
      home,
      ledger: applied.ownershipLedger,
    });
    expect(repeat.plan.operations[0].action).toBe("noop");
    expect(applyRetiredRuntimeCleanup(repeat, { approved: true }).status).toBe("success");
  });

  it("blocks an ambiguous lookalike and never adopts it by name", () => {
    fs.mkdirSync(destination(), { recursive: true });
    fs.writeFileSync(path.join(destination(), "SKILL.md"), "user lookalike\n");
    const before = snapshot(home);

    const preview = previewRetiredRuntimeCleanup({ runtimeId: "claude", home });
    expect(preview.plan.operations[0]).toMatchObject({ action: "blocked_unowned", ownership: "unowned" });
    const applied = applyRetiredRuntimeCleanup(preview, { approved: true });

    expect(applied.status).toBe("non_success");
    expect(applied.operations[0].status).toBe("blocked_unowned");
    expect(snapshot(home)).toEqual(before);
  });

  it("never targets transcripts, settings, credentials, conversations, stats, or caches", () => {
    const { ledger } = installLegacySymlink();
    const protectedFiles = [
      path.join(home, ".claude", "projects", "p", "session.jsonl"),
      path.join(home, ".claude", "settings.json"),
      path.join(home, ".claude", "credentials", "token"),
      path.join(home, ".claude", "conversations", "c.json"),
      path.join(home, ".claude", "statsig", "stats.json"),
      path.join(home, ".claude", "cache", "entry"),
    ];
    for (const file of protectedFiles) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `user:${path.basename(file)}\n`);
    }
    const protectedBefore = protectedFiles.map((file) => fs.readFileSync(file));
    const preview = previewRetiredRuntimeCleanup({ runtimeId: "claude", home, ledger });
    expect(preview.plan.operations.map((operation) => operation.destination)).toEqual([destination()]);

    expect(applyRetiredRuntimeCleanup(preview, { approved: true }).status).toBe("success");
    protectedFiles.forEach((file, index) => {
      expect(fs.readFileSync(file).equals(protectedBefore[index])).toBe(true);
    });
  });

  it("fails closed when the owned symlink identity is replaced at publication", () => {
    const { ledger } = installLegacySymlink();
    const displaced = `${destination()}.displaced`;
    const userTarget = path.join(home, "user-target");
    fs.mkdirSync(userTarget);
    const preview = previewRetiredRuntimeCleanup({ runtimeId: "claude", home, ledger });

    const applied = applyRetiredRuntimeCleanup(preview, {
      approved: true,
      beforePublication(boundary) {
        expect(boundary.action).toBe("remove");
        fs.renameSync(destination(), displaced);
        fs.symlinkSync(userTarget, destination());
      },
    });

    expect(applied.status).toBe("non_success");
    expect(applied.operations[0].status).toBe("failed");
    expect(fs.readlinkSync(destination())).toBe(userTarget);
    expect(fs.lstatSync(displaced).isSymbolicLink()).toBe(true);
    expect(applied.ownershipLedger).toEqual(ledger);
  });

  it("fails closed on a parent swap without touching the replacement tree", () => {
    const { ledger } = installLegacySymlink();
    const skills = path.dirname(destination());
    const displacedSkills = `${skills}.displaced`;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-retired-outside-"));
    const preview = previewRetiredRuntimeCleanup({ runtimeId: "claude", home, ledger });
    try {
      const applied = applyRetiredRuntimeCleanup(preview, {
        approved: true,
        beforePublication() {
          fs.renameSync(skills, displacedSkills);
          fs.symlinkSync(outside, skills);
        },
      });
      expect(applied.status).toBe("non_success");
      expect(applied.operations[0].status).toBe("failed");
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.lstatSync(path.join(displacedSkills, "agentera")).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
