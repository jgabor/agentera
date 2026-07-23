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
  applyNativeResourceCleanup,
  loadNativeResourceCleanupContract,
  nativeResourceCleanupIds,
  previewNativeResourceCleanup,
  validateNativeResourceCleanupContractData,
  validateNativeResourceCleanupContractRoot,
} from "../../src/runtime/nativeResourceCleanup.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-native-resource-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const resourceCases = [
  {
    id: "claude.agentera-skill-link",
    status: "legacy" as const,
    destination: () => path.join(home, ".claude", "skills", "agentera"),
    install(destination: string): void {
      const target = path.join(home, ".agents", "skills", "agentera");
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "SKILL.md"), "owned target\n");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(target, destination);
    },
  },
  {
    id: "codex.agent-descriptor.build",
    status: "managed" as const,
    destination: () => path.join(home, ".codex", "agents", "build.toml"),
    install(destination: string): void {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, "# agentera_managed: true\nname = 'build'\n");
    },
  },
] as const;

function ledgerFor(
  id: string,
  status: "legacy" | "managed",
  destination: string,
): LifecycleOwnershipLedger {
  const observation = observeLifecyclePath(destination, [home]);
  expect(observation.identity).toBeDefined();
  expect(observation.fingerprint).toBeDefined();
  return {
    schemaVersion: LIFECYCLE_LEDGER_SCHEMA,
    owner: "agentera",
    records: [{
      resourceId: id,
      destination,
      kind: observation.kind as "file" | "symlink",
      scope: "whole",
      status,
      fingerprint: observation.fingerprint as string,
      identity: observation.identity as { device: string; inode: string },
    }],
  };
}

describe("native resource cleanup contract", () => {
  it("records accepted supported-host evidence without retiring supported hosts", () => {
    const contract = loadNativeResourceCleanupContract();
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "../../../..", "references/adapters/runtime-retired-resources.yaml"),
      "utf8",
    );

    expect(nativeResourceCleanupIds(contract)).toContain("codex.agent-descriptor.build");
    expect(nativeResourceCleanupIds(contract)).toContain("claude.agentera-skill-link");
    expect(source).toContain("Codex loaded Agentera's specific canonical skill instructions and bootstrap command.");
    expect(source).toContain("Cursor loaded Agentera's specific canonical skill instructions and bootstrap command.");
    expect(source).toContain("OpenCode's native CLI listed /home/jgabor/.agents/skills/agentera/SKILL.md.");
    expect(source).toContain("Copilot's native CLI listed the canonical personal-agents skill; its disabled state is intentional.");
    expect(validateNativeResourceCleanupContractRoot()).toEqual([]);
  });

  it("rejects marker, value, name, and file equality as ownership proof", () => {
    const data = {
      schema_version: "agentera.nativeResourceCleanup.v1",
      status: "resource_retirement_contract",
      decision: "nksvqmnevm",
      authority: "references/adapters/runtime-lifecycle-authority.yaml",
      operation_contract: "references/adapters/runtime-lifecycle-operation-contract.yaml",
      policy: {
        host_inventory_exposure: "evidence_only",
        selection: "native_agentera_resource_only",
        preview: "strictly_read_only",
        apply_requires: "explicit_approval",
        ownership: "matching_whole_resource_ledger_identity_and_fingerprint",
        shared_configuration: "action_required_without_key_level_ownership",
        forbidden_ownership_evidence: [],
        unsupported_platform_result: "action_required",
      },
      hosts: [],
      accepted_host_evidence: [],
      resources: [],
      configuration_inventory: [],
    };

    expect(validateNativeResourceCleanupContractData(data)).toContain(
      "policy must reject managed_marker as ownership evidence",
    );
  });

  it("keeps every shared Codex configuration unit action-required without key-level ownership", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "../../../..", "references/adapters/runtime-retired-resources.yaml"),
      "utf8",
    );

    expect(source).toContain("ownership_available: false");
    expect(source.match(/result_without_proof: action_required/g)).toHaveLength(3);
    expect(nativeResourceCleanupIds()).not.toContain("codex.config.agents.max_depth");
  });
});

describe("native resource cleanup ownership", () => {
  it.each(resourceCases)("removes an owned $id only after approval and converges to noop", (resource) => {
    const destination = resource.destination();
    resource.install(destination);
    const ledger = ledgerFor(resource.id, resource.status, destination);
    const before = fs.lstatSync(destination).ino;
    const preview = previewNativeResourceCleanup({ resourceId: resource.id, home, ledger });

    expect(preview.plan.operations[0]).toMatchObject({
      action: "remove",
      ownership: resource.status === "legacy" ? "legacy" : "managed",
    });
    expect(fs.lstatSync(destination).ino).toBe(before);
    expect(applyNativeResourceCleanup(preview, { approved: false }).operations[0]?.status).toBe("action_required");
    expect(fs.existsSync(destination)).toBe(true);

    const applied = applyNativeResourceCleanup(preview, { approved: true });
    expect(applied.status).toBe("success");
    expect(applied.operations[0]?.status).toBe("applied");
    expect(fs.existsSync(destination)).toBe(false);

    const repeat = previewNativeResourceCleanup({
      resourceId: resource.id,
      home,
      ledger: applied.ownershipLedger,
    });
    expect(repeat.plan.operations[0]?.action).toBe("noop");
  });

  it.each(resourceCases)("preserves an unowned $id even when its marker or value looks managed", (resource) => {
    const destination = resource.destination();
    resource.install(destination);

    const preview = previewNativeResourceCleanup({ resourceId: resource.id, home });
    const applied = applyNativeResourceCleanup(preview, { approved: true });

    expect(preview.plan.operations[0]).toMatchObject({ action: "blocked_unowned" });
    expect(applied.operations[0]?.status).toBe("blocked_unowned");
    expect(fs.existsSync(destination)).toBe(true);
  });
});
