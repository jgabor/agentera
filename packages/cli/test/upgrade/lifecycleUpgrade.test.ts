import { spawnSync } from "node:child_process";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cmdDoctor } from "../../src/cli/commands/doctor.js";
import {
  CodexLifecycleAdapter,
  CursorLifecycleAdapter,
} from "../../src/runtime/lifecycleAdapters.js";
import {
  appendLifecycleOwnershipJournal,
  lifecycleOwnershipJournalPath,
  readLifecycleOwnershipJournal,
} from "../../src/runtime/lifecycleOwnershipJournal.js";
import * as lifecycleJournal from "../../src/runtime/lifecycleOwnershipJournal.js";
import * as lifecycleOperations from "../../src/runtime/lifecycleOperations.js";
import * as lifecyclePublication from "../../src/runtime/lifecyclePublication.js";
import * as usageStats from "../../src/analytics/usageStats.js";
import { LIFECYCLE_MANUAL_REVIEW_GUIDANCE } from "../../src/runtime/lifecycleOperations.js";
import { runLifecycleUpgrade } from "../../src/upgrade/lifecycleUpgrade.js";
import { buildUpgradePlan, renderUpgradePlan, upgradeExitCode } from "../../src/upgrade/upgradeOrchestrator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const CLI_BIN = path.join(REPO_ROOT, "packages/cli/dist/bin/agentera.js");
const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/lifecycle-upgrade-cases.json"), "utf8"));

interface Fixture {
  root: string;
  home: string;
  project: string;
  appHome: string;
  trap: string;
  env: Record<string, string | undefined>;
}

let fx: Fixture;

function mkdirs(paths: string[]): void {
  for (const value of paths) fs.mkdirSync(value, { recursive: true });
}

function fixture(withParents = true): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-upgrade-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const appHome = path.join(root, "app-home");
  const bin = path.join(root, "bin");
  const trap = path.join(root, "native-command-ran");
  mkdirs([home, project, appHome, bin]);
  if (withParents) {
    mkdirs([
      path.join(home, ".agents", "skills"),
      path.join(home, ".config", "opencode", "plugins"),
      path.join(home, ".config", "opencode", "agents"),
      path.join(home, ".codex", "agents"),
      path.join(project, ".cursor-plugin"),
      path.join(project, ".cursor", "agents"),
    ]);
  }
  for (const binary of ["opencode", "codex", "cursor", "cursor-agent", "gh"] ) {
    const executable = path.join(bin, binary);
    fs.writeFileSync(executable, `#!/bin/sh\nprintf invoked > '${trap}'\n`);
    fs.chmodSync(executable, 0o700);
  }
  return {
    root,
    home,
    project,
    appHome,
    trap,
    env: { PATH: bin, HOME: home },
  };
}

function run(selector: "all" | "opencode" | "codex" | "cursor" | "copilot" | null, apply = false) {
  return runLifecycleUpgrade({
    selector,
    home: fx.home,
    project: fx.project,
    sourceRoot: REPO_ROOT,
    appHome: fx.appHome,
    env: fx.env,
    apply,
  });
}

function treeBytes(root: string): string[] {
  const out: string[] = [];
  const walk = (current: string, relative: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const rel = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) out.push(`l:${rel}:${fs.readlinkSync(absolute)}`);
      else if (entry.isDirectory()) {
        out.push(`d:${rel}`);
        walk(absolute, rel);
      } else if (entry.isFile()) out.push(`f:${rel}:${fs.readFileSync(absolute).toString("base64")}`);
      else out.push(`o:${rel}`);
    }
  };
  walk(root, "");
  return out;
}

type ActiveSelector = "opencode" | "codex" | "cursor" | "copilot";

const ACTIVE_SELECTORS: readonly ActiveSelector[] = ["opencode", "codex", "cursor", "copilot"];

const RUNTIME_COLLISION_OPERATION: Record<ActiveSelector, string> = {
  opencode: "opencode.plugin",
  codex: "codex.hooks",
  cursor: "cursor.plugin",
  copilot: "canonical_skill",
};

function ownershipEventFiles(): string[] {
  return fs.readdirSync(lifecycleOwnershipJournalPath(fx.appHome))
    .filter((name) => /^\d{20}-[0-9a-f-]{36}\.json$/i.test(name))
    .sort();
}

function createRuntimeCollision(runtime: ActiveSelector): string {
  switch (runtime) {
    case "opencode": {
      const target = path.join(fx.home, ".config", "opencode", "plugins", "agentera.js");
      fs.copyFileSync(path.join(REPO_ROOT, ".opencode", "plugins", "agentera.js"), target);
      return target;
    }
    case "codex": {
      const target = path.join(fx.home, ".codex", "hooks.json");
      fs.copyFileSync(path.join(REPO_ROOT, "hooks", "codex-hooks.json"), target);
      return target;
    }
    case "cursor": {
      const target = path.join(fx.project, ".cursor-plugin", "plugin.json");
      fs.copyFileSync(path.join(REPO_ROOT, ".cursor-plugin", "plugin.json"), target);
      return target;
    }
    case "copilot": {
      const target = path.join(fx.home, ".agents", "skills", "agentera");
      fs.writeFileSync(target, "user-owned collision\n");
      return target;
    }
  }
}

beforeEach(() => {
  fx = fixture();
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.XDG_CONFIG_HOME = path.join(fx.home, ".config");
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(fx.root, { recursive: true, force: true });
});

describe("upgrade lifecycle preview", () => {
  it.each(ACTIVE_SELECTORS)("covers explicit all-runtime preview and narrowed %s selection", (runtime) => {
    const allRuntimePreview = buildUpgradePlan({
      installRoot: fx.appHome,
      home: fx.home,
      project: fx.project,
      channel: "development",
      runtime: "all",
      dryRun: true,
    });

    expect(allRuntimePreview.lifecycle?.selection).toEqual({
      requested: "all",
      runtimeIds: ACTIVE_SELECTORS,
    });
    expect(allRuntimePreview.lifecycle?.operations.filter((operation) => operation.id === "canonical_skill"))
      .toHaveLength(1);
    expect(allRuntimePreview.lifecycle?.operations.some((operation) => operation.runtime === runtime)
      || allRuntimePreview.lifecycle?.userActions.some((action) => action.runtime === runtime)).toBe(true);

    const narrowed = run(runtime, false);
    expect(narrowed.selection).toEqual({ requested: runtime, runtimeIds: [runtime] });
    expect(narrowed.operations[0]?.id).toBe("canonical_skill");
    expect(narrowed.operations.slice(1).every((operation) => operation.id.startsWith(`${runtime}.`))).toBe(true);
    expect(narrowed.operations.some((operation) => operation.runtime === runtime)
      || narrowed.userActions.some((action) => action.runtime === runtime)).toBe(true);
  });

  it("leaves optional lifecycle resources unselected during selector-free upgrade", () => {
    const before = treeBytes(fx.root);
    const preview = buildUpgradePlan({
      installRoot: fx.appHome,
      home: fx.home,
      project: fx.project,
      channel: "development",
      dryRun: true,
    });

    expect(preview.lifecycle).toBeNull();
    expect(preview.phases.some((phase) => phase.name === "lifecycle")).toBe(false);
    expect(preview.applyCommand).toBeNull();
    expect(treeBytes(fx.root)).toEqual(before);
  });

  it.each([false, true])("reports each selected resource once when apply=%s", (apply) => {
    const plan = buildUpgradePlan({
      installRoot: fx.appHome,
      home: fx.home,
      project: fx.project,
      channel: "development",
      runtime: "opencode",
      ...(apply ? { yes: true } : { dryRun: true }),
    });
    const operations = plan.lifecycle?.operations ?? [];

    expect(new Set(operations.map(({ id }) => id)).size).toBe(operations.length);
    expect(plan.phases.find((phase) => phase.name === "lifecycle")?.items).toEqual([]);
    expect(plan.lifecycle?.projection).not.toHaveProperty("actions");
    expect(plan.lifecycle?.projection).not.toHaveProperty("sharedResources");
    const aggregateProjection = JSON.stringify(plan.lifecycle?.projection);
    for (const operation of operations) {
      expect(aggregateProjection).not.toContain(`\"${operation.id}\"`);
    }
    expect(operations.every((operation) => apply
      ? operation.outcome !== null
      : operation.outcome === null)).toBe(true);
  });

  it("selects all runtimes in authority order, deduplicates shared work, and performs zero writes or native execution", () => {
    const before = treeBytes(fx.root);

    const preview = run(CASES.all_runtime_order.selector, false);

    expect(preview.selection).toEqual({
      requested: "all",
      runtimeIds: CASES.all_runtime_order.runtimeIds,
    });
    expect(preview.operations.slice(0, 4).map((operation) => operation.id))
      .toEqual(CASES.all_runtime_order.operationPrefix);
    expect(preview.operations.filter((operation) => operation.id === "canonical_skill")).toHaveLength(1);
    expect(preview.operations.every((operation) =>
      operation.runtime && operation.surface && operation.category && operation.resource
      && operation.desiredState && operation.currentState && operation.ownership
      && Array.isArray(operation.dependencies) && typeof operation.required === "boolean"
      && Array.isArray(operation.remediation))).toBe(true);
    expect(preview.userActions.some((action) =>
      action.kind === "native" && action.status === "action_required")).toBe(true);
    expect(preview.ownershipJournal.state).toBe("absent");
    expect(preview.retiredCleanup).toBeNull();
    expect(preview.retiredSummary).toBeNull();
    expect(treeBytes(fx.root)).toEqual(before);
    expect(fs.existsSync(fx.trap)).toBe(false);
  });

  it("keeps preview strictly read-only across managed roots and side-effect boundaries", () => {
    const before = treeBytes(fx.root);
    const mutationSpies = [
      vi.spyOn(fs, "mkdirSync"),
      vi.spyOn(fs, "writeFileSync"),
      vi.spyOn(fs, "renameSync"),
      vi.spyOn(fs, "unlinkSync"),
      vi.spyOn(fs, "rmSync"),
      vi.spyOn(fs, "rmdirSync"),
      vi.spyOn(fs, "symlinkSync"),
      vi.spyOn(fs, "linkSync"),
    ];
    const nativeSpies = [
      vi.spyOn(childProcess, "execFileSync"),
      vi.spyOn(childProcess, "spawnSync"),
      vi.spyOn(childProcess, "execFile"),
      vi.spyOn(childProcess, "spawn"),
    ];
    const journalAppendSpy = vi.spyOn(lifecycleJournal, "appendLifecycleOwnershipJournal");
    const lockSpy = vi.spyOn(lifecycleJournal, "acquireLifecycleOwnershipJournalLock");
    const publicationSpy = vi.spyOn(lifecyclePublication, "publishLifecycleResource");
    const ledgerSpy = vi.spyOn(lifecycleOperations, "writeLifecycleOwnershipLedgerAtomic");
    const telemetrySpy = vi.spyOn(usageStats, "usageMain");

    const preview = run("all", false);

    expect(preview.mode).toBe("preview");
    expect(treeBytes(fx.root)).toEqual(before);
    expect(fs.existsSync(lifecycleOwnershipJournalPath(fx.appHome))).toBe(false);
    expect(fs.existsSync(fx.trap)).toBe(false);
    for (const spy of mutationSpies) expect(spy).not.toHaveBeenCalled();
    for (const spy of nativeSpies) expect(spy).not.toHaveBeenCalled();
    expect(journalAppendSpy).not.toHaveBeenCalled();
    expect(lockSpy).not.toHaveBeenCalled();
    expect(publicationSpy).not.toHaveBeenCalled();
    expect(ledgerSpy).not.toHaveBeenCalled();
    expect(telemetrySpy).not.toHaveBeenCalled();
  });

  it.each(ACTIVE_SELECTORS)("fails closed on a missing %s ownership record in preview and apply", (runtime) => {
    const target = createRuntimeCollision(runtime);
    const before = fs.lstatSync(target).isSymbolicLink()
      ? `link:${fs.readlinkSync(target)}`
      : fs.readFileSync(target, "hex");
    const operationId = RUNTIME_COLLISION_OPERATION[runtime];

    const preview = run(runtime, false);
    const previewOperation = preview.operations.find((operation) => operation.id === operationId);
    expect(previewOperation).toMatchObject({
      currentState: "unowned",
      ownership: "unowned",
      action: "blocked_unowned",
      blockedReason: "pre-existing resource has no matching Agentera ownership ledger record",
      remediation: [LIFECYCLE_MANUAL_REVIEW_GUIDANCE],
    });

    const applied = run(runtime, true);
    const appliedOperation = applied.operations.find((operation) => operation.id === operationId);
    expect(appliedOperation).toMatchObject({
      outcome: "blocked_unowned",
      blockedReason: "pre-existing resource has no matching Agentera ownership ledger record",
    });
    expect(applied.status).toBe("non_success");
    expect(fs.lstatSync(target).isSymbolicLink()
      ? `link:${fs.readlinkSync(target)}`
      : fs.readFileSync(target, "hex")).toBe(before);
  });

  it("selects Cursor as one identity with deterministic CLI and IDE operation metadata", () => {
    const preview = run(CASES.selected_cursor.selector, false);

    expect(preview.selection.runtimeIds).toEqual(CASES.selected_cursor.runtimeIds);
    expect(preview.operations.map((operation) => operation.id)).toEqual(CASES.selected_cursor.operationIds);
    expect(new Set(preview.operations.map((operation) => operation.runtime))).toEqual(new Set(["shared", "cursor"]));
    expect(preview.userActions.some((action) => action.runtime === "cursor" && action.surface === "ide"))
      .toBe(true);
  });

  it("keeps runtime-specific resources outside a narrowed selector unchanged during apply", () => {
    const opencode = run("opencode", true);
    expect(opencode.operations.some((operation) => operation.id === "opencode.plugin")).toBe(true);
    const plugin = path.join(fx.home, ".config", "opencode", "plugins", "agentera.js");
    fs.writeFileSync(plugin, "leave this outside the Cursor selection\n");

    const cursor = run("cursor", true);

    expect(cursor.operations.every((operation) =>
      !operation.id.startsWith("opencode.") || operation.id === "canonical_skill")).toBe(true);
    expect(fs.readFileSync(plugin, "utf8")).toBe("leave this outside the Cursor selection\n");
  });

  it("keeps app and lifecycle preview byte-read-only while exposing both phases", () => {
    const before = treeBytes(fx.root);

    const plan = buildUpgradePlan({
      installRoot: fx.appHome,
      home: fx.home,
      project: fx.project,
      channel: "development",
      dryRun: true,
      runtime: "all",
    });

    expect(plan.phases.some((phase) => phase.name === "detect")).toBe(true);
    expect(plan.phases.some((phase) => phase.name === "lifecycle")).toBe(true);
    expect(plan.lifecycle?.mode).toBe("preview");
    expect(renderUpgradePlan(plan)).toContain("runtime lifecycle details:");
    expect(treeBytes(fx.root)).toEqual(before);
    expect(fs.existsSync(fx.trap)).toBe(false);
  });

  it("refreshes app content before observing and applying lifecycle state", () => {
    const plan = buildUpgradePlan({
      installRoot: fx.appHome,
      home: fx.home,
      project: fx.project,
      channel: "development",
      runtime: "opencode",
      yes: true,
    });

    const refresh = plan.phases
      .find((phase) => phase.name === "cleanup")?.items
      .find((item) => item.action === "refresh-app-content");
    const canonical = plan.lifecycle?.operations.find((operation) => operation.id === "canonical_skill");

    expect(refresh?.status).toBe("applied");
    expect(canonical?.outcome).toBe("applied");
    expect(fs.existsSync(path.join(fx.appHome, "skills", "agentera", "SKILL.md"))).toBe(true);
    expect(fs.lstatSync(path.join(fx.home, ".agents", "skills", "agentera")).isSymbolicLink()).toBe(true);
  });

  it("reports missing parents, unowned collisions, native actions, and unsupported publication explicitly", () => {
    fs.rmSync(path.join(fx.project, ".cursor"), { recursive: true });
    fs.rmSync(path.join(fx.project, ".cursor-plugin"), { recursive: true });
    const missing = run("cursor", false);
    expect(missing.operations.find((operation) => operation.id === "cursor.hooks")).toMatchObject({
      currentState: CASES.missing_parent.state,
      action: CASES.missing_parent.action,
    });

    const collision = path.join(fx.home, ".config", "opencode", "plugins", "agentera.js");
    fs.copyFileSync(path.join(REPO_ROOT, ".opencode", "plugins", "agentera.js"), collision);
    const unowned = run("opencode", false);
    expect(unowned.operations.find((operation) => operation.id === "opencode.plugin")).toMatchObject({
      currentState: CASES.unowned_collision.state,
      action: CASES.unowned_collision.action,
    });

    const copilot = run("copilot", false);
    expect(copilot.userActions.filter((action) => action.kind === "native").map((action) => action.command)).toEqual([
      "/skills list", "/skills info agentera", "/skills reload",
    ]);

    fs.unlinkSync(collision);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const unsupported = run("opencode", false);
    expect(unsupported.platform.securePublication).toBe(false);
    expect(unsupported.operations.filter((operation) => operation.action !== "noop")
      .every((operation) => operation.action === CASES.unsupported_platform.action)).toBe(true);
  });

  it("keeps Cursor CLI required while making IDE applicability conditional", () => {
    const cliOnly = new CursorLifecycleAdapter().inspect({
      home: fx.home,
      project: fx.project,
      sourceRoot: REPO_ROOT,
      env: fx.env,
      surfaceEvidence: {
        cli: { host_present: true },
        ide: { host_present: false },
      },
      categoryEvidence: { trust: { cli: true, ide: "unknown" } },
    });
    expect(cliOnly.lifecycleObservation.surfaces.map((surface) => [surface.id, surface.applicability])).toEqual([
      ["cli", "required"],
      ["ide", "not_applicable"],
    ]);
    expect(cliOnly.lifecycleObservation.surfaces[0]?.evidence).toMatchObject({
      host_present: true,
      trusted: true,
    });

    const idePresent = new CursorLifecycleAdapter().inspect({
      home: fx.home,
      project: fx.project,
      sourceRoot: REPO_ROOT,
      env: fx.env,
      surfaceEvidence: {
        cli: { host_present: true },
        ide: { host_present: true },
      },
      categoryEvidence: { trust: { cli: true, ide: "denied" } },
    });
    expect(idePresent.lifecycleObservation.surfaces.map((surface) => [surface.id, surface.applicability])).toEqual([
      ["cli", "required"],
      ["ide", "conditional"],
    ]);
    expect(idePresent.categories.trust.surfaces.find((surface) => surface.surfaceId === "ide")).toMatchObject({
      state: "denied",
      remediation: { kind: "action_required" },
    });
  });

  it("keeps unknown and denied trust as action-required evidence without a production injection seam", () => {
    const base = {
      home: fx.home,
      project: fx.project,
      sourceRoot: REPO_ROOT,
      env: fx.env,
      categoryEvidence: { trust: { cli: "unknown" as const } },
    };
    const unknown = new CodexLifecycleAdapter().inspect(base);
    expect(unknown.categories.trust.surfaces[0]).toMatchObject({
      state: CASES.unknown_trust.trust,
      remediation: { kind: CASES.unknown_trust.action },
    });
    const denied = new CursorLifecycleAdapter().inspect({
      ...base,
      categoryEvidence: { trust: { cli: "unknown", ide: "denied" } },
    });
    expect(denied.categories.trust.surfaces.find((surface) => surface.surfaceId === "ide")).toMatchObject({
      state: CASES.denied_trust.trust,
      remediation: { kind: CASES.denied_trust.action },
    });
  });

  it("keeps retired Claude cleanup separate from active selection and user data", () => {
    const claude = path.join(fx.home, ".claude");
    mkdirs([path.join(claude, "projects"), path.join(claude, "cache")]);
    fs.writeFileSync(path.join(claude, "projects", "history.json"), "user history\n");
    const before = treeBytes(claude);

    const preview = runLifecycleUpgrade({
      selector: null,
      home: fx.home,
      project: fx.project,
      sourceRoot: REPO_ROOT,
      appHome: fx.appHome,
      env: fx.env,
      apply: false,
      retiredCleanup: "claude",
    });

    expect(preview.selection).toEqual({ requested: "none", runtimeIds: [] });
    expect(preview.operations).toEqual([]);
    expect(preview.retiredCleanup).toMatchObject({ runtimeId: "claude", activeRuntime: false });
    expect(preview.retiredSummary).toMatchObject({ pending: 0, noop: 1 });
    expect(preview.summary.pending).toBe(0);
    expect(treeBytes(claude)).toEqual(before);
  });
});

describe("upgrade lifecycle apply and convergence", () => {
  it("applies selected owned operations, persists ownership, and reruns completed work as noop", () => {
    const first = run("opencode", true);
    expect(first.operations.every((operation) => operation.outcome === "applied")).toBe(true);
    expect(first.ownershipJournal.state).toBe("clean");

    const exact = run("opencode", false);
    expect(exact.operations.every((operation) => operation.action === "noop")).toBe(true);
    const plugin = exact.operations.find((operation) => operation.id === "opencode.plugin");
    expect(plugin).toMatchObject({
      currentState: CASES.exact.state,
      action: CASES.exact.action,
      ownershipEvidence: { ledgerRecord: { status: "managed" } },
    });

    fs.writeFileSync(plugin!.destination, "owned drift\n");
    const drift = run("opencode", false);
    expect(drift.operations.find((operation) => operation.id === "opencode.plugin")).toMatchObject({
      currentState: CASES.drifted.state,
      action: CASES.drifted.action,
    });
    const repaired = run("opencode", true);
    expect(repaired.operations.find((operation) => operation.id === "opencode.plugin")?.outcome).toBe("applied");
    expect(run("opencode", false).operations.every((operation) => operation.action === "noop")).toBe(true);
  });

  it("continues independent operations after failure and retries only remaining work", () => {
    const first = runLifecycleUpgrade({
      selector: "opencode",
      home: fx.home,
      project: fx.project,
      sourceRoot: REPO_ROOT,
      appHome: fx.appHome,
      env: fx.env,
      apply: true,
    }, {
      beforePublication(boundary) {
        if (boundary.operationId === "opencode.plugin") throw new Error("simulated independent failure");
      },
    });

    expect(first.status).toBe("non_success");
    expect(first.operations.map(({ id, outcome }) => [id, outcome])).toEqual([
      ["canonical_skill", "applied"],
      ["opencode.plugin", "failed"],
      ["opencode.agent", "applied"],
    ]);

    const restarted = run("opencode", true);
    expect(restarted.operations.map(({ id, outcome }) => [id, outcome])).toEqual([
      ["canonical_skill", "noop"],
      ["opencode.plugin", "applied"],
      ["opencode.agent", "noop"],
    ]);
    expect(run("opencode", false).operations.every((operation) => operation.action === "noop")).toBe(true);
  });

  it("fails closed with the same cause when a managed record no longer matches its destination", () => {
    const first = run("opencode", true);
    expect(first.status).toBe("success");
    const journalPath = lifecycleOwnershipJournalPath(fx.appHome);
    const journal = readLifecycleOwnershipJournal(journalPath);
    const mismatchedDestination = path.join(fx.root, "different-owner-destination");
    const mismatchedLedger = {
      ...journal.ledger,
      records: journal.ledger.records.map((record) => record.resourceId === "opencode.plugin"
        ? { ...record, destination: mismatchedDestination }
        : record),
    };
    appendLifecycleOwnershipJournal(journalPath, mismatchedLedger);

    const plugin = path.join(fx.home, ".config", "opencode", "plugins", "agentera.js");
    const before = fs.readFileSync(plugin, "hex");
    const expectedCause = "ownership ledger record does not match the declared destination and kind";

    const preview = run("opencode", false);
    const previewOperation = preview.operations.find((operation) => operation.id === "opencode.plugin");
    expect(previewOperation).toMatchObject({
      currentState: "ambiguous_ownership",
      ownership: "ambiguous",
      action: "action_required",
      blockedReason: expectedCause,
    });
    expect(previewOperation?.ownershipEvidence.ledgerRecord?.destination).toBe(mismatchedDestination);

    const applied = run("opencode", true);
    expect(applied.operations.find((operation) => operation.id === "opencode.plugin")).toMatchObject({
      outcome: "action_required",
      blockedReason: expectedCause,
    });
    expect(fs.readFileSync(plugin, "hex")).toBe(before);
  });

  it.each([
    ["corrupt", "incomplete publication occurs before a successor event", (events: string[]) => {
      fs.writeFileSync(path.join(lifecycleOwnershipJournalPath(fx.appHome), events[0]!), "{");
    }],
    ["disconnected", "previous digest disconnects the hash chain", (events: string[]) => {
      const journalPath = lifecycleOwnershipJournalPath(fx.appHome);
      const last = events.at(-1)!;
      const eventPath = path.join(journalPath, last);
      const event = JSON.parse(fs.readFileSync(eventPath, "utf8")) as Record<string, unknown>;
      event.previousDigest = "sha256:disconnected";
      fs.writeFileSync(eventPath, `${JSON.stringify(event, null, 2)}\n`);
    }],
  ] as const)("fails closed on a %s ownership journal in preview and apply", (_kind, expectedCause, corrupt) => {
    run("opencode", true);
    const plugin = path.join(fx.home, ".config", "opencode", "plugins", "agentera.js");
    fs.writeFileSync(plugin, "owned drift before journal failure\n");
    const journalPath = lifecycleOwnershipJournalPath(fx.appHome);
    let journal = readLifecycleOwnershipJournal(journalPath);
    while (journal.validEvents < 2) {
      journal = appendLifecycleOwnershipJournal(journalPath, journal.ledger);
    }
    const events = ownershipEventFiles();
    corrupt(events);
    const before = treeBytes(fx.root);

    const preview = run("opencode", false);
    expect(preview.ownershipJournal.state).toBe("corrupt");
    const previewBlocked = preview.operations.filter((operation) => operation.action !== "noop");
    expect(previewBlocked.length).toBeGreaterThan(0);
    expect(new Set(previewBlocked.map((operation) => operation.blockedReason))).toEqual(new Set([
      `ownership journal is corrupt: ${expectedCause}`,
    ]));

    const applied = run("opencode", true);
    expect(applied.ownershipJournal.state).toBe("corrupt");
    expect(applied.operations.filter((operation) => operation.outcome !== "noop")
      .every((operation) => operation.outcome === "action_required")).toBe(true);
    expect(applied.operations.some((operation) => operation.blockedReason === `ownership journal is corrupt: ${expectedCause}`))
      .toBe(true);
    expect(treeBytes(fx.root)).toEqual(before);
  });

  it("blocks preview and apply on exact event-2 corruption in a nine-event chain without mutation", () => {
    const applied = run("opencode", true);
    const journalPath = lifecycleOwnershipJournalPath(fx.appHome);
    let journal = readLifecycleOwnershipJournal(journalPath);
    while (journal.validEvents < 9) {
      journal = appendLifecycleOwnershipJournal(journalPath, journal.ledger);
    }
    const events = fs.readdirSync(journalPath).filter((name) => name.endsWith(".json")).sort();
    fs.writeFileSync(
      path.join(journalPath, events[1]!),
      '{"schemaVersion":"agentera.lifecycleOwnershipJournalEvent.v1"',
    );
    const before = treeBytes(fx.root);

    const preview = run("opencode", false);
    const attempted = run("opencode", true);

    expect(applied.status).toBe("success");
    expect(preview.ownershipJournal).toMatchObject({ state: "corrupt", validEvents: 1, ignoredEvents: 8 });
    expect(preview.operations.filter((operation) => operation.action !== "noop")
      .every((operation) => operation.action === "action_required"
        && operation.blockedReason?.includes("incomplete publication occurs before a successor"))).toBe(true);
    expect(attempted.status).toBe("non_success");
    expect(attempted.ownershipJournal).toMatchObject({ state: "corrupt", validEvents: 1, ignoredEvents: 8 });
    expect(treeBytes(fx.root)).toEqual(before);
    expect(fs.existsSync(fx.trap)).toBe(false);
  });

  it("makes doctor consume the persisted ledger after apply", () => {
    const applied = buildUpgradePlan({
      installRoot: fx.appHome,
      home: fx.home,
      project: fx.project,
      channel: "development",
      runtime: "opencode",
      yes: true,
    });
    expect(upgradeExitCode(applied)).toBe(0);
    let output = "";
    const code = cmdDoctor({
      installRoot: fx.appHome,
      home: fx.home,
      project: fx.project,
      expectedVersion: null,
      expectCommand: [],
      smoke: false,
      allowLiveModel: false,
      format: "json",
    }, { out: (text) => { output += text; } });
    const payload = JSON.parse(output);

    expect(code).toBe(1);
    expect(payload.runtime_lifecycle.runtimes.find((runtime: { runtimeId: string }) =>
      runtime.runtimeId === "opencode").canonicalSkill.detected).toBe(true);
    expect(readLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(fx.appHome)).validEvents)
      .toBeGreaterThan(0);
  });
});

describe("upgrade lifecycle CLI output and exits", () => {
  it("drains selected lifecycle JSON over a pipe with stable non-success exit", () => {
    const child = spawnSync(process.execPath, [
      CLI_BIN,
      "upgrade",
      "--install-root", fx.appHome,
      "--home", fx.home,
      "--project", fx.project,
      "--channel", "development",
      "--runtime", "all",
      "--dry-run",
      "--format", "json",
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...fx.env, AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT },
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });

    expect(child.status).toBe(1);
    expect(child.stderr).toBe("");
    expect(Buffer.byteLength(child.stdout)).toBeGreaterThan(10_000);
    const payload = JSON.parse(child.stdout);
    expect(payload.lifecycle).toMatchObject({
      schemaVersion: "agentera.lifecycleUpgrade.v1",
      selection: { requested: "all", runtimeIds: CASES.all_runtime_order.runtimeIds },
    });
  });

  it("uses exit 0 for converged operations, 1 for pending or failed work, and leaves 2 to usage errors", () => {
    const pending = buildUpgradePlan({
      installRoot: fx.appHome,
      home: fx.home,
      project: fx.project,
      channel: "development",
      runtime: "opencode",
      dryRun: true,
    });
    expect(upgradeExitCode(pending)).toBe(1);

    const applied = buildUpgradePlan({
      installRoot: fx.appHome,
      home: fx.home,
      project: fx.project,
      channel: "development",
      runtime: "opencode",
      yes: true,
    });
    expect(upgradeExitCode(applied)).toBe(0);
    const converged = buildUpgradePlan({
      installRoot: fx.appHome,
      home: fx.home,
      project: fx.project,
      channel: "development",
      runtime: "opencode",
      dryRun: true,
    });
    expect(converged.lifecycle?.operations.every((operation) => operation.action === "noop")).toBe(true);
    expect(upgradeExitCode(converged)).toBe(0);
    expect(converged.lifecycle?.status).toBe("noop");
    expect(converged.lifecycle?.userActions).toEqual([]);
  });
});
