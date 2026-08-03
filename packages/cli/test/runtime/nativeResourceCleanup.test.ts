import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  LIFECYCLE_LEDGER_SCHEMA,
  type LifecycleOwnershipLedger,
} from "../../src/runtime/lifecycleOperations.js";
import { observeLifecyclePath } from "../../src/runtime/lifecyclePublication.js";
import {
  applyNativeResourceCleanup,
  loadNativeResourceCleanupContract,
  nativeResourceCleanupHistoricalIds,
  nativeResourceCleanupIds,
  previewNativeResourceCleanup,
  resolveNativeResourceCleanupId,
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

const codexConfigurationIds = [
  "codex.config.shell_environment_policy.set.AGENTERA_HOME",
  "codex.config.agents.max_depth",
  "codex.config.features.multi_agent_v2",
];

const retiredResourceClasses = [
  ["claude.skill-link", "legacy_skill_link"],
  ["codex.agent-descriptor", "capability_descriptor"],
  ["opencode.plugin", "plugin"],
  ["opencode.command", "command"],
  ["legacy.primary-agent", "primary_agent"],
  ["legacy.capability-agent", "capability_agent"],
  ["opencode.stale-skill-link", "stale_skill_link"],
  ["installed.hook", "installed_hook"],
  ["agentera.registration", "registration"],
] as const;

const codexDescriptors = [
  "status", "vision", "discuss", "research", "plan", "build", "optimize", "audit", "document", "profile", "design", "orchestrate",
] as const;

function contractData(): Record<string, unknown> {
  return YAML.parse(fs.readFileSync(
    path.join(import.meta.dirname, "../../../..", "references/adapters/runtime-retired-resources.yaml"),
    "utf8",
  )) as Record<string, unknown>;
}

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

  it.each(retiredResourceClasses)("discovers the %s resource vocabulary class", (id, resourceClass) => {
    const entry = loadNativeResourceCleanupContract().resourceVocabulary.find((item) => item.id === id);

    expect(entry).toMatchObject({ id, resourceClass });
    expect(entry?.resourceIds.length).toBeGreaterThan(0);
  });

  it.each(retiredResourceClasses)("fails closed when the %s resource vocabulary class is missing", (id, resourceClass) => {
    const data = contractData();
    data.resource_vocabulary = (data.resource_vocabulary as Array<Record<string, unknown>>)
      .filter((entry) => entry.id !== id);

    expect(validateNativeResourceCleanupContractData(data)).toContain(
      `resource_vocabulary must retain ${id} as ${resourceClass}`,
    );
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
    expect(preview.configurationUnits.map((unit) => unit.id)).toEqual(
      resource.id.startsWith("codex.") ? codexConfigurationIds : [],
    );
    expect(preview.configurationUnits.every((unit) => unit.status === "action_required")).toBe(true);
    expect(fs.lstatSync(destination).ino).toBe(before);
    expect(applyNativeResourceCleanup(preview, { approved: false }).operations[0]?.status).toBe("action_required");
    expect(fs.existsSync(destination)).toBe(true);

    const applied = applyNativeResourceCleanup(preview, { approved: true });
    expect(applied.status).toBe("success");
    expect(applied.operations[0]?.status).toBe("applied");
    expect(applied.configurationUnits).toEqual(preview.configurationUnits);
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

    expect(preview.plan.operations[0]).toMatchObject({
      state: "unowned",
      ownership: "unowned",
      action: "action_required",
    });
    expect(applied.operations[0]?.status).toBe("action_required");
    expect(fs.existsSync(destination)).toBe(true);
  });

  it("keeps an absent selected resource noop with unrelated valid ledger records", () => {
    const selected = resourceCases[1];
    const statusDestination = path.join(home, ".codex", "agents", "status.toml");
    const visionDestination = path.join(home, ".codex", "agents", "vision.toml");
    fs.mkdirSync(path.dirname(statusDestination), { recursive: true });
    fs.writeFileSync(statusDestination, "# owned status\n");
    fs.writeFileSync(visionDestination, "# owned vision\n");
    const ledger: LifecycleOwnershipLedger = {
      schemaVersion: LIFECYCLE_LEDGER_SCHEMA,
      owner: "agentera",
      records: [
        ledgerFor("codex.agent-descriptor.status", "managed", statusDestination).records[0]!,
        ledgerFor("codex.agent-descriptor.vision", "managed", visionDestination).records[0]!,
      ],
    };

    const preview = previewNativeResourceCleanup({ resourceId: selected.id, home, ledger });
    const applied = applyNativeResourceCleanup(preview, { approved: true });

    expect(preview).toMatchObject({
      ledgerAuthorization: "match_or_absent_noop",
      ledgerDiagnostics: [],
    });
    expect(preview.plan.operations[0]?.action).toBe("noop");
    expect(applied.operations[0]?.status).toBe("noop");
    expect(applied.ownershipLedger.records).toEqual(ledger.records);
  });

  it("preserves an existing unowned resource despite unrelated valid ledger records", () => {
    const selected = resourceCases[1];
    const destination = selected.destination();
    const unrelatedDestination = path.join(home, ".codex", "agents", "status.toml");
    selected.install(destination);
    fs.writeFileSync(unrelatedDestination, "# owned status\n");
    const ledger = ledgerFor("codex.agent-descriptor.status", "managed", unrelatedDestination);

    const preview = previewNativeResourceCleanup({ resourceId: selected.id, home, ledger });
    const applied = applyNativeResourceCleanup(preview, { approved: true });

    expect(preview).toMatchObject({ ledgerAuthorization: "blocked" });
    expect(preview.plan.operations[0]).toMatchObject({ action: "action_required" });
    expect(applied.operations[0]?.status).toBe("action_required");
    expect(fs.existsSync(destination)).toBe(true);
  });

  it("preserves a changed Codex descriptor as action_required", () => {
    const resource = resourceCases[1];
    const destination = resource.destination();
    resource.install(destination);
    const ledger = ledgerFor(resource.id, resource.status, destination);
    fs.writeFileSync(destination, "user changed this descriptor\n");

    const preview = previewNativeResourceCleanup({ resourceId: resource.id, home, ledger });
    const applied = applyNativeResourceCleanup(preview, { approved: true });

    expect(preview.plan.operations[0]).toMatchObject({ action: "action_required" });
    expect(applied.operations[0]?.status).toBe("action_required");
    expect(fs.existsSync(destination)).toBe(true);
  });

  it("preserves an ambiguous Codex ownership ledger as action_required", () => {
    const resource = resourceCases[1];
    const destination = resource.destination();
    resource.install(destination);
    const record = ledgerFor(resource.id, resource.status, destination).records[0]!;
    const ledger: LifecycleOwnershipLedger = {
      schemaVersion: LIFECYCLE_LEDGER_SCHEMA,
      owner: "agentera",
      records: [record, { ...record }],
    };

    const preview = previewNativeResourceCleanup({ resourceId: resource.id, home, ledger });
    const applied = applyNativeResourceCleanup(preview, { approved: true });

    expect(preview.plan.operations[0]).toMatchObject({
      state: "ambiguous_ownership",
      ownership: "ambiguous",
      action: "action_required",
    });
    expect(applied.operations[0]?.status).toBe("action_required");
    expect(fs.existsSync(destination)).toBe(true);
  });

  it("fails closed when canonical and historical identities collide", () => {
    const resource = resourceCases[1];
    const destination = resource.destination();
    resource.install(destination);
    const canonical = ledgerFor(resource.id, resource.status, destination).records[0]!;
    const historical = { ...canonical, resourceId: "codex.agents.build" };
    const ledger: LifecycleOwnershipLedger = {
      schemaVersion: LIFECYCLE_LEDGER_SCHEMA,
      owner: "agentera",
      records: [canonical, historical],
    };

    const preview = previewNativeResourceCleanup({ resourceId: resource.id, home, ledger });
    const applied = applyNativeResourceCleanup(preview, { approved: true });

    expect(preview.plan.operations[0]).toMatchObject({
      state: "ambiguous_ownership",
      ownership: "ambiguous",
      action: "action_required",
    });
    expect(applied.operations[0]?.status).toBe("action_required");
    expect(fs.existsSync(destination)).toBe(true);
  });

  it("does not let an unowned Codex descriptor block an independently owned one", () => {
    const unowned = resourceCases[1];
    const owned = { ...resourceCases[1], id: "codex.agent-descriptor.status" };
    const unownedDestination = unowned.destination();
    const ownedDestination = path.join(home, ".codex", "agents", "status.toml");
    unowned.install(unownedDestination);
    owned.install(ownedDestination);
    const ledger = ledgerFor(owned.id, owned.status, ownedDestination);

    const preserved = applyNativeResourceCleanup(
      previewNativeResourceCleanup({ resourceId: unowned.id, home }),
      { approved: true },
    );
    const removed = applyNativeResourceCleanup(
      previewNativeResourceCleanup({ resourceId: owned.id, home, ledger }),
      { approved: true },
    );

    expect(preserved.operations[0]?.status).toBe("action_required");
    expect(removed.operations[0]?.status).toBe("applied");
    expect(fs.existsSync(unownedDestination)).toBe(true);
    expect(fs.existsSync(ownedDestination)).toBe(false);
  });

  it.each(codexDescriptors)("replays the historical Codex descriptor identity for %s", (descriptor) => {
    const destination = path.join(home, ".codex", "agents", `${descriptor}.toml`);
    resourceCases[1].install(destination);
    const historicalId = `codex.agents.${descriptor}`;
    const canonicalId = `codex.agent-descriptor.${descriptor}`;
    const ledger = ledgerFor(historicalId, "managed", destination);

    expect(nativeResourceCleanupHistoricalIds()).toContain(historicalId);
    expect(resolveNativeResourceCleanupId(historicalId)?.id).toBe(canonicalId);

    const preview = previewNativeResourceCleanup({ resourceId: historicalId, home, ledger });
    expect(preview).toMatchObject({ resourceId: canonicalId, ledgerAuthorization: "match_or_absent_noop" });
    expect(preview.plan.operations[0]).toMatchObject({ id: canonicalId, action: "remove", ownership: "managed" });
    expect(preview.plan.request.ledger?.records).toEqual([
      expect.objectContaining({ resourceId: canonicalId, destination }),
    ]);

    const applied = applyNativeResourceCleanup(preview, { approved: true });
    expect(applied.operations[0]?.status).toBe("applied");
    expect(applied.ownershipLedger.records).toEqual([]);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it.each(codexDescriptors)("preserves an unowned %s descriptor selected by its historical identity", (descriptor) => {
    const destination = path.join(home, ".codex", "agents", `${descriptor}.toml`);
    resourceCases[1].install(destination);

    const preview = previewNativeResourceCleanup({ resourceId: `codex.agents.${descriptor}`, home });
    const applied = applyNativeResourceCleanup(preview, { approved: true });

    expect(preview.plan.operations[0]).toMatchObject({ action: "action_required", ownership: "unowned" });
    expect(applied.operations[0]?.status).toBe("action_required");
    expect(fs.existsSync(destination)).toBe(true);
  });
});
