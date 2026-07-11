import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  RUNTIME_ADAPTER_CATEGORIES,
  RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH,
  loadRuntimeLifecycleAdapterContract,
  validateRuntimeLifecycleAdapterContractData,
  validateRuntimeLifecycleAdapterContractRoot,
} from "../../src/runtime/lifecycleAdapterContract.js";
import {
  CodexLifecycleAdapter,
  CopilotLifecycleAdapter,
  CursorLifecycleAdapter,
  OpenCodeLifecycleAdapter,
  applyRuntimeAdapterRepair,
  inspectRuntimeLifecycleAdapters,
  type RuntimeAdapterInspectionContext,
} from "../../src/runtime/lifecycleAdapters.js";
import {
  LIFECYCLE_AUTHORITY_RELATIVE_PATH,
  loadLifecycleAuthority,
} from "../../src/runtime/lifecycleAuthority.js";
import {
  emptyLifecycleOwnershipLedger,
  type LifecycleOwnershipLedger,
} from "../../src/runtime/lifecycleOperations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const CONTRACT_PATH = path.join(REPO_ROOT, RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH);
const AUTHORITY = loadLifecycleAuthority(path.join(REPO_ROOT, LIFECYCLE_AUTHORITY_RELATIVE_PATH));
const CONTRACT = loadRuntimeLifecycleAdapterContract(CONTRACT_PATH, AUTHORITY);

interface Fixture {
  root: string;
  home: string;
  project: string;
  context: RuntimeAdapterInspectionContext;
  cacheMarkers: string[];
}

function mkdirs(paths: string[]): void {
  for (const item of paths) fs.mkdirSync(item, { recursive: true });
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-runtime-adapters-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  mkdirs([
    path.join(home, ".agents", "skills"),
    path.join(home, ".config", "opencode", "plugins"),
    path.join(home, ".config", "opencode", "agents"),
    path.join(home, ".codex", "agents"),
    path.join(home, ".codex", "cache"),
    path.join(home, ".config", "opencode", "cache"),
    path.join(home, ".copilot", "cache"),
    path.join(project, ".cursor", "agents"),
    path.join(project, ".cursor", "cache"),
    path.join(project, ".cursor-plugin"),
  ]);
  const cacheMarkers = [
    path.join(home, ".codex", "cache", "marker"),
    path.join(home, ".config", "opencode", "cache", "marker"),
    path.join(home, ".copilot", "cache", "marker"),
    path.join(project, ".cursor", "cache", "marker"),
  ];
  cacheMarkers.forEach((marker, index) => fs.writeFileSync(marker, `cache-${index}\n`));
  return {
    root,
    home,
    project,
    cacheMarkers,
    context: {
      home,
      project,
      sourceRoot: REPO_ROOT,
      env: { PATH: "" },
      surfaceEvidence: {
        host: { host_present: true },
        cli: { host_present: true },
        ide: { host_present: true },
      },
      categoryEvidence: {
        trust: { host: "unknown", cli: "unknown", ide: "unknown" },
      },
    },
  };
}

function freshHomeFixture(): Fixture {
  const fx = fixture();
  fs.rmSync(fx.home, { recursive: true });
  fs.rmSync(fx.project, { recursive: true });
  mkdirs([fx.home, fx.project]);
  return { ...fx, cacheMarkers: [] };
}

function treeSnapshot(root: string): string[] {
  return fs.readdirSync(root, { recursive: true }).map(String).sort();
}

function cacheSnapshot(items: string[]): string[] {
  return items.map((item) => fs.readFileSync(item, "utf8"));
}

function withLedger(
  context: RuntimeAdapterInspectionContext,
  ledger: LifecycleOwnershipLedger,
): RuntimeAdapterInspectionContext {
  return { ...context, ledger };
}

function installCanonicalSkill(fx: Fixture): LifecycleOwnershipLedger {
  const adapter = new OpenCodeLifecycleAdapter(CONTRACT, AUTHORITY);
  const result = applyRuntimeAdapterRepair(adapter.inspect(fx.context));
  expect(result.status).toBe("success");
  return result.ownershipLedger;
}

describe("runtime lifecycle adapter contract", () => {
  it("binds exactly four adapters and every common category to the lifecycle authority", () => {
    expect(validateRuntimeLifecycleAdapterContractRoot(REPO_ROOT)).toEqual([]);
    expect(CONTRACT.adapters.map((adapter) => adapter.runtimeId)).toEqual([
      "opencode",
      "codex",
      "cursor",
      "copilot",
    ]);
    for (const adapter of CONTRACT.adapters) {
      expect(Object.keys(adapter.categories)).toEqual(RUNTIME_ADAPTER_CATEGORIES);
      for (const category of RUNTIME_ADAPTER_CATEGORIES) {
        expect(Object.keys(adapter.categories[category])).toEqual(
          AUTHORITY.runtimes.find((runtime) => runtime.id === adapter.runtimeId)?.surfaces.map((surface) => surface.id),
        );
      }
    }
    expect(CONTRACT.adapters.some((adapter) => ["claude", "cursor-agent"].includes(adapter.runtimeId))).toBe(false);
  });

  it("reports stale, incomplete, unsafe, and unverified mandatory claims at actionable locations", () => {
    const raw = YAML.parse(fs.readFileSync(CONTRACT_PATH, "utf8"));
    delete raw.adapters[0].categories.hooks;
    raw.adapters[1].categories.skills.cli.capability = "unverified";
    raw.managed_resources[0].destination = "{home}/.config/opencode/cache/agentera.js";
    delete raw.adapters[2].categories.plugins.ide;
    raw.adapters[3].categories.native_actions.cli.evidence = "external_observation";
    raw.adapters[3].native_actions[1].id = raw.adapters[3].native_actions[0].id;

    const errors = validateRuntimeLifecycleAdapterContractData(raw, AUTHORITY);

    expect(errors).toContain(
      `${RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH}:adapters[0].categories.hooks: missing common category claims`,
    );
    expect(errors).toContain(
      `${RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH}:adapters[1].categories.skills.cli: required surfaces need repairable required skill detection`,
    );
    expect(errors).toContain(
      `${RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH}:managed_resources[0].destination: must not target runtime or package cache segment cache`,
    );
    expect(errors.some((error) =>
      error.includes(`${RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH}:adapters[2].categories.plugins`)
      && error.includes("must report surfaces"))).toBe(true);
    expect(errors).toContain(
      `${RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH}:adapters[3].categories.native_actions.cli: declared native actions require action_required, verified_host_actions, action_required semantics`,
    );
    expect(errors).toContain(
      `${RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH}:adapters[3].native_actions[1].id: must be non-empty and unique within the adapter`,
    );
  });

  it("requires exact native-action claims and declarations on the same surface", () => {
    const raw = YAML.parse(fs.readFileSync(CONTRACT_PATH, "utf8"));
    raw.adapters[3].native_actions = [];

    expect(validateRuntimeLifecycleAdapterContractData(raw, AUTHORITY)).toContain(
      `${RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH}:adapters[3].categories.native_actions.cli: verified native-action claims require at least one exact action for the same surface`,
    );
  });
});

describe("supported runtime adapter matrix", () => {
  it("reports all categories with explicit evidence, capability, and remediation semantics", () => {
    const fx = fixture();
    const matrix = inspectRuntimeLifecycleAdapters(fx.context, CONTRACT, AUTHORITY);

    expect(matrix.reports.map((report) => report.runtimeId)).toEqual([
      "opencode",
      "codex",
      "cursor",
      "copilot",
    ]);
    for (const report of matrix.reports) {
      expect(Object.keys(report.categories)).toEqual(RUNTIME_ADAPTER_CATEGORIES);
      for (const category of RUNTIME_ADAPTER_CATEGORIES) {
        const value = report.categories[category];
        expect(value.surfaces.length).toBeGreaterThan(0);
        for (const surface of value.surfaces) {
          expect(surface.evidence.length).toBeGreaterThan(0);
          expect(surface.capability).toBeTruthy();
          expect(surface.remediation.kind).toBeTruthy();
          expect(surface.diagnosisComplete).toBeTypeOf("boolean");
        }
      }
      expect(report.caveats.some((caveat) =>
        caveat.includes("existing ownership ledger") && caveat.includes("fails closed"))).toBe(true);
    }
    expect(matrix.lifecycleState.activeRuntimeIds).toEqual(["opencode", "codex", "cursor", "copilot"]);
    expect(matrix.lifecycleState.releaseBlocked).toBe(true);
  });

  it("keeps absent hosts and optional unsupported behavior explicit without satisfying a missing skill floor", () => {
    const fx = fixture();
    const context = { ...fx.context, surfaceEvidence: undefined, env: { PATH: "" } };
    const matrix = inspectRuntimeLifecycleAdapters(context, CONTRACT, AUTHORITY);

    for (const report of matrix.reports) {
      expect(report.supportFloor.releaseBlocking).toBe(true);
      expect(report.supportFloor.unmet).toContain("canonical_skill_not_detected");
      const requiredSurface = report.lifecycleObservation.surfaces.find((surface) =>
        AUTHORITY.runtimes.find((runtime) => runtime.id === report.runtimeId)?.surfaces
          .find((candidate) => candidate.id === surface.id)?.presence === "required");
      expect(requiredSurface?.evidence?.host_present).toBe(false);
    }
    expect(matrix.reports.find((report) => report.runtimeId === "copilot")?.categories.agents.state)
      .toBe("unsupported");
  });

  it("keeps unknown and denied trust explicit without turning either into trusted", () => {
    const fx = fixture();
    const ledger = installCanonicalSkill(fx);
    const unknown = new CodexLifecycleAdapter(CONTRACT, AUTHORITY).inspect(withLedger(fx.context, ledger));
    const denied = new CodexLifecycleAdapter(CONTRACT, AUTHORITY).inspect({
      ...withLedger(fx.context, ledger),
      categoryEvidence: { trust: { cli: "denied" } },
    });

    expect(unknown.categories.trust.surfaces[0].state).toBe("unknown");
    expect(unknown.lifecycleObservation.surfaces[0].evidence?.trusted).toBe("unknown");
    expect(unknown.supportFloor.met).toBe(false);
    expect(unknown.supportFloor.violations).toContainEqual(expect.objectContaining({
      code: "mandatory_evidence_unknown",
      field: "trusted",
      observed: "unknown",
    }));
    expect(denied.categories.trust.surfaces[0].state).toBe("denied");
    expect(denied.lifecycleObservation.surfaces[0].evidence?.trusted).toBe("denied");
    expect(denied.supportFloor.met).toBe(false);
    expect(denied.supportFloor.violations).toContainEqual(expect.objectContaining({
      code: "mandatory_trust_denied",
      field: "trusted",
      observed: "denied",
    }));
  });

  it("fails the mandatory floor when required canonical skill detection is unknown", () => {
    const fx = fixture();
    const canonical = path.join(fx.home, ".agents", "skills", "agentera");
    fs.symlinkSync(canonical, canonical);

    const report = new CopilotLifecycleAdapter(CONTRACT, AUTHORITY).inspect(fx.context);

    expect(report.canonicalSkill.detected).toBe("unknown");
    expect(report.supportFloor).toMatchObject({
      met: false,
      diagnosisComplete: false,
      releaseBlocking: true,
    });
    expect(report.supportFloor.unmet).toEqual(expect.arrayContaining([
      "canonical_skill_unknown",
      "diagnosis_incomplete",
      "mandatory_evidence_unknown:cli:trusted",
    ]));
  });
});

describe("repair ownership and publication boundaries", () => {
  it("reports missing destination parents as exact action-required work across all four runtimes", () => {
    const fx = freshHomeFixture();
    const beforeHome = treeSnapshot(fx.home);
    const beforeProject = treeSnapshot(fx.project);
    const matrix = inspectRuntimeLifecycleAdapters(fx.context, CONTRACT, AUTHORITY);
    const canonicalParent = path.join(fx.home, ".agents", "skills");

    expect(matrix.lifecycleState.releaseBlocked).toBe(true);
    for (const report of matrix.reports) {
      const canonicalOperation = report.repairPlan.operations.find((operation) =>
        operation.id === "canonical_skill");
      expect(canonicalOperation).toMatchObject({
        action: "action_required",
        reason: "allowed root is not an existing safe directory",
      });
      for (const skill of report.categories.skills.surfaces.filter((surface) => surface.expected)) {
        expect(skill.state).toBe("action_required");
        expect(skill.remediation).toEqual({
          kind: "action_required",
          summary: `Create the destination parent ${canonicalParent} as a real, non-symlink directory you control, then rerun preview; Agentera will not create or replace it.`,
          operationIds: ["canonical_skill"],
          nativeActions: [],
        });
      }
      expect(report.supportFloor).toMatchObject({
        met: false,
        diagnosisComplete: true,
        releaseBlocking: true,
      });
      expect(report.supportFloor.unmet).toContain("canonical_skill_not_detected");
      const result = applyRuntimeAdapterRepair(report);
      expect(result.status).toBe("non_success");
      expect(result.operations.every((operation) => operation.status === "action_required")).toBe(true);
    }
    expect(fs.existsSync(canonicalParent)).toBe(false);
    expect(treeSnapshot(fx.home)).toEqual(beforeHome);
    expect(treeSnapshot(fx.project)).toEqual(beforeProject);
  });

  it("previews purely, applies owned drift, converges, and never touches caches", () => {
    const fx = fixture();
    const adapter = new OpenCodeLifecycleAdapter(CONTRACT, AUTHORITY);
    const beforeCaches = cacheSnapshot(fx.cacheMarkers);
    const beforeTree = fs.readdirSync(fx.home, { recursive: true }).map(String).sort();

    const initial = adapter.inspect(fx.context);

    expect(fs.readdirSync(fx.home, { recursive: true }).map(String).sort()).toEqual(beforeTree);
    expect(cacheSnapshot(fx.cacheMarkers)).toEqual(beforeCaches);
    const firstApply = applyRuntimeAdapterRepair(initial);
    expect(firstApply.status).toBe("success");
    const plugin = path.join(fx.home, ".config", "opencode", "plugins", "agentera.js");
    fs.writeFileSync(plugin, "owned drift\n");

    const driftPreview = adapter.inspect(withLedger(fx.context, firstApply.ownershipLedger));
    expect(driftPreview.repairPlan.operations.find((operation) => operation.id === "opencode.plugin")?.action)
      .toBe("update");
    expect(fs.readFileSync(plugin, "utf8")).toBe("owned drift\n");
    expect(cacheSnapshot(fx.cacheMarkers)).toEqual(beforeCaches);

    const repaired = applyRuntimeAdapterRepair(driftPreview);
    expect(repaired.status).toBe("success");
    expect(fs.readFileSync(plugin).equals(fs.readFileSync(path.join(REPO_ROOT, ".opencode", "plugins", "agentera.js"))))
      .toBe(true);
    expect(cacheSnapshot(fx.cacheMarkers)).toEqual(beforeCaches);

    const converged = adapter.inspect(withLedger(fx.context, repaired.ownershipLedger));
    expect(converged.repairPlan.operations.every((operation) => operation.action === "noop")).toBe(true);
  });

  it.each([
    ["opencode", () => new OpenCodeLifecycleAdapter(CONTRACT, AUTHORITY), "opencode.plugin"],
    ["codex", () => new CodexLifecycleAdapter(CONTRACT, AUTHORITY), "codex.hooks"],
    ["cursor", () => new CursorLifecycleAdapter(CONTRACT, AUTHORITY), "cursor.hooks"],
    ["copilot", () => new CopilotLifecycleAdapter(CONTRACT, AUTHORITY), "canonical_skill"],
  ] as const)("converges declared %s resources through the shared engine", (_runtime, makeAdapter, driftId) => {
    const fx = fixture();
    const adapter = makeAdapter();
    const beforeCaches = cacheSnapshot(fx.cacheMarkers);
    const first = applyRuntimeAdapterRepair(adapter.inspect(fx.context));
    expect(first.status).toBe("success");

    const firstOperation = adapter.inspect(withLedger(fx.context, first.ownershipLedger))
      .repairPlan.operations.find((operation) => operation.id === driftId);
    expect(firstOperation?.action).toBe("noop");
    if (firstOperation && driftId !== "canonical_skill") {
      fs.writeFileSync(firstOperation.destination, "owned adapter drift\n");
      const drift = adapter.inspect(withLedger(fx.context, first.ownershipLedger));
      expect(drift.repairPlan.operations.find((operation) => operation.id === driftId)?.action).toBe("update");
      const repaired = applyRuntimeAdapterRepair(drift);
      expect(repaired.status).toBe("success");
      expect(adapter.inspect(withLedger(fx.context, repaired.ownershipLedger)).repairPlan.operations
        .find((operation) => operation.id === driftId)?.action).toBe("noop");
    }
    expect(cacheSnapshot(fx.cacheMarkers)).toEqual(beforeCaches);
  });

  it("blocks an exact-content user collision and never adopts it by equality or name", () => {
    const fx = fixture();
    const source = path.join(REPO_ROOT, ".opencode", "plugins", "agentera.js");
    const target = path.join(fx.home, ".config", "opencode", "plugins", "agentera.js");
    fs.copyFileSync(source, target);
    const before = fs.readFileSync(target);

    const report = new OpenCodeLifecycleAdapter(CONTRACT, AUTHORITY).inspect(fx.context);
    const plugin = report.repairPlan.operations.find((operation) => operation.id === "opencode.plugin");

    expect(plugin?.action).toBe("blocked_unowned");
    expect(report.categories.plugins.state).toBe("blocked_unowned");
    const result = applyRuntimeAdapterRepair(report);
    expect(result.operations.find((operation) => operation.id === "opencode.plugin")?.status)
      .toBe("blocked_unowned");
    expect(fs.readFileSync(target).equals(before)).toBe(true);
    expect(result.ownershipLedger.records.some((record) => record.resourceId === "opencode.plugin")).toBe(false);
  });

  it("reports project discovery collisions as potential shadowing without claiming ownership", () => {
    const fx = fixture();
    const ledger = installCanonicalSkill(fx);
    const projectSkill = path.join(fx.project, ".opencode", "skills", "agentera");
    fs.mkdirSync(projectSkill, { recursive: true });
    fs.writeFileSync(path.join(projectSkill, "SKILL.md"), "---\nname: agentera\n---\n");

    const report = new OpenCodeLifecycleAdapter(CONTRACT, AUTHORITY).inspect(withLedger(fx.context, ledger));

    expect(report.categories.skills.state).toBe("shadowed");
    expect(report.categories.skills.surfaces[0].evidence.some((item) =>
      item.path === projectSkill && item.detail.includes("shadow or collide"))).toBe(true);
    expect(report.repairPlan.operations.some((operation) => operation.destination === projectSkill)).toBe(false);
  });
});

describe("Cursor aggregation and native action boundaries", () => {
  it("treats Cursor CLI as required and an absent IDE as conditional not_applicable", () => {
    const fx = fixture();
    const ledger = installCanonicalSkill(fx);
    const report = new CursorLifecycleAdapter(CONTRACT, AUTHORITY).inspect({
      ...withLedger(fx.context, ledger),
      surfaceEvidence: { cli: { host_present: true }, ide: { host_present: false } },
      categoryEvidence: { trust: { cli: true, ide: "unknown" } },
    });

    expect(report.runtimeId).toBe("cursor");
    for (const category of RUNTIME_ADAPTER_CATEGORIES) {
      expect(report.categories[category].surfaces.map((surface) => surface.surfaceId)).toEqual(["cli", "ide"]);
      expect(report.categories[category].surfaces[1].state).toBe("not_applicable");
    }
    expect(report.supportFloor.met).toBe(true);
    expect(report.lifecycleObservation.surfaces.find((surface) => surface.id === "ide")?.evidence)
      .toEqual({
        host_present: false,
        installed: "not_applicable",
        enabled: "not_applicable",
        trusted: "not_applicable",
      });
  });

  it("reports an expected degraded IDE without splitting Cursor into another runtime", () => {
    const fx = fixture();
    const ledger = installCanonicalSkill(fx);
    const report = new CursorLifecycleAdapter(CONTRACT, AUTHORITY).inspect({
      ...withLedger(fx.context, ledger),
      surfaceEvidence: { cli: { host_present: true }, ide: { host_present: true } },
      categoryEvidence: { trust: { cli: "unknown", ide: "denied" } },
    });

    expect(report.categories.trust.surfaces.find((surface) => surface.surfaceId === "ide")?.state).toBe("denied");
    expect(report.status).toBe("blocked");
    expect(report.supportFloor.unmet).toContain("mandatory_trust_denied:ide:trusted");
    expect(report.lifecycleObservation.runtimeId).toBe("cursor");
  });

  it("exposes exact Copilot slash actions but never places them in an executable repair plan", () => {
    const fx = fixture();
    const report = new CopilotLifecycleAdapter(CONTRACT, AUTHORITY).inspect(fx.context);
    const skills = report.categories.skills.surfaces[0];
    const native = report.categories.native_actions.surfaces[0];

    expect(skills.state).toBe("absent");
    expect(skills.remediation).toMatchObject({
      kind: "repair",
      operationIds: ["canonical_skill"],
      nativeActions: [],
    });
    expect(report.categories.enablement.surfaces[0].remediation).toMatchObject({
      kind: "repair",
      operationIds: ["canonical_skill"],
      nativeActions: [],
    });
    for (const category of RUNTIME_ADAPTER_CATEGORIES.filter((category) => category !== "native_actions")) {
      expect(report.categories[category].surfaces.every((surface) =>
        surface.remediation.nativeActions.length === 0)).toBe(true);
    }
    expect(native.state).toBe("action_required");
    expect(native.remediation.nativeActions.map((action) => action.command)).toEqual([
      "/skills list",
      "/skills info agentera",
      "/skills reload",
    ]);
    expect(report.repairPlan.operations.map((operation) => operation.id)).toEqual(["canonical_skill"]);
    expect(JSON.stringify(report.repairPlan)).not.toContain("/skills reload");
    const result = applyRuntimeAdapterRepair(report);
    expect(result.operations.map((operation) => operation.id)).toEqual(["canonical_skill"]);
  });

  it("does not let native action metadata affect an empty ownership ledger", () => {
    const fx = fixture();
    const report = new CopilotLifecycleAdapter(CONTRACT, AUTHORITY).inspect({
      ...fx.context,
      ledger: emptyLifecycleOwnershipLedger(),
    });
    const result = applyRuntimeAdapterRepair(report);

    expect(result.ownershipLedger.records.map((record) => record.resourceId)).toEqual(["canonical_skill"]);
  });
});
