import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyRuntimeAdapterRepair,
  runtimeLifecycleAdapters,
  type RuntimeAdapterInspectionContext,
} from "../../src/runtime/lifecycleAdapters.js";
import { emptyLifecycleOwnershipLedger } from "../../src/runtime/lifecycleOperations.js";
import {
  observeRuntimeLifecycle,
  summarizeRuntimeLifecycle,
} from "../../src/runtime/lifecycleSnapshot.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CLI_BIN = path.join(REPO_ROOT, "packages", "cli", "dist", "bin", "agentera.js");
const EXPECTED_RUNTIME_IDS = ["opencode", "codex", "cursor", "copilot"];
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function mkdirs(paths: string[]): void {
  for (const item of paths) fs.mkdirSync(item, { recursive: true });
}

function deepPath(root: string, label: string, depth: number): string {
  const segment = `${label}-${"x".repeat(176)}`;
  return path.join(root, ...Array.from({ length: depth }, (_value, index) => `${segment}-${index}`));
}

function treeSnapshot(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true })
    .map(String)
    .sort()
    .map((relative) => {
      const target = path.join(root, relative);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) return `${relative}:symlink:${fs.readlinkSync(target)}`;
      if (stat.isDirectory()) return `${relative}:directory`;
      return `${relative}:file:${fs.readFileSync(target, "utf8")}`;
    });
}

function writeTrapBinaries(bin: string, marker: string): void {
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["opencode", "codex", "cursor-agent", "cursor", "copilot"]) {
    const target = path.join(bin, name);
    fs.writeFileSync(target, `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${marker}'\nexit 99\n`);
    fs.chmodSync(target, 0o755);
  }
}

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

function sharedRuntimeSemantics(runtime: Record<string, unknown>): Record<string, unknown> {
  return {
    runtimeId: runtime.runtimeId,
    status: runtime.status,
    readiness: runtime.readiness,
    supportFloor: runtime.supportFloor,
    surfaces: (runtime.surfaces as Array<Record<string, unknown>>).map((surface) => ({
      id: surface.id,
      expected: surface.expected,
      status: surface.status,
    })),
  };
}

describe("prime and doctor lifecycle integration", () => {
  it("shares one four-runtime snapshot while preserving bounded and detailed budgets", () => {
    const root = tempRoot("lifecycle-cli-");
    const home = deepPath(root, "home", 9);
    const project = deepPath(root, "project", 4);
    const bin = path.join(root, "bin");
    const invocationMarker = path.join(root, "native-process-invoked");
    mkdirs([home, project]);
    writeTrapBinaries(bin, invocationMarker);
    fs.unlinkSync(path.join(bin, "opencode"));
    const env = {
      ...process.env,
      HOME: home,
      PATH: bin,
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
      AGENTERA_HOME: path.join(home, ".local", "share", "agentera"),
    };
    const before = treeSnapshot(root);

    const prime = runCli(["prime", "--format", "json"], project, env);
    const doctor = runCli([
      "doctor", "--home", home, "--project", project, "--format", "json",
    ], project, env);

    expect(prime.status, prime.stderr).toBe(0);
    expect([0, 1]).toContain(doctor.status);
    const primePayload = JSON.parse(prime.stdout) as Record<string, unknown>;
    const doctorPayload = JSON.parse(doctor.stdout) as Record<string, unknown>;
    const summary = primePayload.runtime_lifecycle as Record<string, unknown>;
    const diagnosis = doctorPayload.runtime_lifecycle as Record<string, unknown>;
    expect(summary.activeRuntimeIds).toEqual(EXPECTED_RUNTIME_IDS);
    expect(diagnosis.activeRuntimeIds).toEqual(EXPECTED_RUNTIME_IDS);
    expect(summary.snapshotVersion).toBe(diagnosis.schemaVersion);
    expect(summary.statusVocabularyVersion).toBe(diagnosis.statusVocabularyVersion);
    expect(summary.authority).toBe(diagnosis.authority);
    expect(((summary.runtimes as Array<Record<string, unknown>>)[0].surfaces as Array<Record<string, unknown>>)[0].detected)
      .toBe(false);

    const primeRuntimes = summary.runtimes as Array<Record<string, unknown>>;
    const doctorRuntimes = diagnosis.runtimes as Array<Record<string, unknown>>;
    expect(primeRuntimes.map((runtime) => runtime.runtimeId)).toEqual(EXPECTED_RUNTIME_IDS);
    expect(doctorRuntimes.map((runtime) => runtime.runtimeId)).toEqual(EXPECTED_RUNTIME_IDS);
    for (const primeRuntime of primeRuntimes) {
      const doctorRuntime = doctorRuntimes.find((runtime) => runtime.runtimeId === primeRuntime.runtimeId);
      expect(doctorRuntime).toBeDefined();
      expect(sharedRuntimeSemantics(primeRuntime)).toEqual(sharedRuntimeSemantics(doctorRuntime!));
      expect(primeRuntime.blockerCount).toBe((doctorRuntime!.blockers as unknown[]).length);
      expect(primeRuntime.actionCount).toBe(doctorRuntime!.actionCount);
    }

    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(4_096);
    expect(JSON.stringify(summary)).not.toMatch(/categories|evidence|remediation|nativeActions|command/);
    expect(Buffer.byteLength(doctor.stdout)).toBeGreaterThan(65_536);
    expect(doctorRuntimes.every((runtime) =>
      (runtime.surfaces as Array<Record<string, unknown>>).every((surface) =>
        (surface.categories as unknown[]).length === 8))).toBe(true);
    const copilot = doctorRuntimes.find((runtime) => runtime.runtimeId === "copilot")!;
    const copilotNative = ((copilot.surfaces as Array<Record<string, unknown>>)[0].categories as Array<Record<string, unknown>>)
      .find((category) => category.category === "native_actions")!;
    const copilotAgents = ((copilot.surfaces as Array<Record<string, unknown>>)[0].categories as Array<Record<string, unknown>>)
      .find((category) => category.category === "agents")!;
    expect(copilotAgents.state).toBe("unsupported");
    expect((copilotNative.remediation as Record<string, unknown>).nativeActions).toEqual([
      expect.objectContaining({ command: "/skills list" }),
      expect.objectContaining({ command: "/skills info agentera" }),
      expect.objectContaining({ command: "/skills reload" }),
    ]);
    expect(JSON.stringify(doctorRuntimes.map((runtime) => runtime.runtimeId))).not.toContain("claude");
    expect(JSON.stringify(doctorRuntimes.map((runtime) => runtime.runtimeId))).not.toContain("cursor-agent");
    expect(fs.existsSync(path.join(home, ".agents", "skills"))).toBe(false);
    expect(fs.existsSync(invocationMarker)).toBe(false);
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("renders bounded prime text and detailed doctor text from lifecycle projections", () => {
    const root = tempRoot("lifecycle-text-");
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    mkdirs([home, project]);
    const env = {
      ...process.env,
      HOME: home,
      PATH: "",
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
    };
    const prime = runCli(["prime"], project, env);
    const doctor = runCli(["doctor", "--home", home, "--project", project], project, env);
    expect(prime.status, prime.stderr).toBe(0);
    expect(prime.stdout).toContain("runtime_lifecycle: snapshot=agentera.runtimeLifecycleSnapshot.v1");
    expect(prime.stdout).toContain("- cursor: status=");
    expect(prime.stdout).not.toContain("native step:");
    expect([0, 1]).toContain(doctor.status);
    expect(doctor.stdout).toContain("Runtime lifecycle diagnosis:");
    expect(doctor.stdout).toContain("skills: ");
    expect(doctor.stdout).toContain("trust: unknown");
    expect(doctor.stdout).toContain("native step: /skills reload");
  });

  it("includes the same bounded summary in capability startup context", () => {
    const root = tempRoot("lifecycle-context-");
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    mkdirs([home, project]);
    const child = runCli(["prime", "--context", "build", "--format", "json"], project, {
      ...process.env,
      HOME: home,
      PATH: "",
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
    });
    expect(child.status, child.stderr).toBe(0);
    const payload = JSON.parse(child.stdout) as Record<string, unknown>;
    const lifecycle = payload.runtime_lifecycle as Record<string, unknown>;
    expect(lifecycle.activeRuntimeIds).toEqual(EXPECTED_RUNTIME_IDS);
    expect(Buffer.byteLength(JSON.stringify(lifecycle))).toBeLessThan(4_096);
    expect(JSON.stringify(lifecycle)).not.toContain("nativeActions");
  });
});

function readyFixture(): { context: RuntimeAdapterInspectionContext; ledger: ReturnType<typeof emptyLifecycleOwnershipLedger> } {
  const root = tempRoot("lifecycle-ready-");
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  mkdirs([
    home,
    project,
    path.join(home, ".agents", "skills"),
    path.join(home, ".config", "opencode", "plugins"),
    path.join(home, ".config", "opencode", "agents"),
    path.join(home, ".codex", "agents"),
    path.join(home, ".codex"),
    path.join(project, ".cursor", "agents"),
    path.join(project, ".cursor"),
  ]);
  const allSurfaceEvidence = {
    host: { host_present: true as const, enabled: true as const, trusted: true as const },
    cli: { host_present: true as const, enabled: true as const, trusted: true as const },
    ide: { host_present: true as const, enabled: true as const, trusted: true as const },
  };
  const context: RuntimeAdapterInspectionContext = {
    home,
    project,
    sourceRoot: REPO_ROOT,
    env: { PATH: "" },
    surfaceEvidence: allSurfaceEvidence,
    categoryEvidence: {
      trust: { host: true, cli: true, ide: true },
      enablement: { host: true, cli: true, ide: true },
    },
  };
  let ledger = emptyLifecycleOwnershipLedger();
  for (const adapter of runtimeLifecycleAdapters()) {
    const result = applyRuntimeAdapterRepair(adapter.inspect({ ...context, ledger }));
    expect(result.status).toBe("success");
    ledger = result.ownershipLedger;
  }
  return { context, ledger };
}

describe("lifecycle snapshot edge projections", () => {
  it("keeps all-ready and Cursor conditional surface states truthful", () => {
    const fixture = readyFixture();
    const ready = observeRuntimeLifecycle({ ...fixture.context, ledger: fixture.ledger });
    expect(ready.runtimes.map((runtime) => runtime.status)).toEqual(["ready", "ready", "ready", "ready"]);
    expect(ready.runtimes.every((runtime) => runtime.supportFloor.met)).toBe(true);

    const cliOnly = observeRuntimeLifecycle({
      ...fixture.context,
      ledger: fixture.ledger,
      surfaceEvidence: {
        cli: { host_present: true, enabled: true, trusted: true },
        ide: { host_present: false },
      },
      categoryEvidence: { trust: { cli: true, ide: "not_applicable" } },
    });
    const cliOnlyCursor = cliOnly.runtimes.find((runtime) => runtime.runtimeId === "cursor")!;
    expect(cliOnlyCursor.surfaces.map((surface) => [surface.id, surface.expected, surface.status])).toEqual([
      ["cli", true, "ready"],
      ["ide", false, "not_applicable"],
    ]);

    const ideOnly = observeRuntimeLifecycle({
      ...fixture.context,
      ledger: fixture.ledger,
      surfaceEvidence: {
        cli: { host_present: false, enabled: true, trusted: true },
        ide: { host_present: true, enabled: true, trusted: true },
      },
      categoryEvidence: { trust: { cli: true, ide: true } },
    });
    const ideOnlyCursor = ideOnly.runtimes.find((runtime) => runtime.runtimeId === "cursor")!;
    expect(ideOnlyCursor.status).toBe("degraded");
    expect(ideOnlyCursor.surfaces.find((surface) => surface.id === "cli")?.status).toBe("degraded");
    expect(ideOnlyCursor.surfaces.find((surface) => surface.id === "ide")?.status).toBe("ready");
  });

  it("preserves unknown, denied, shadowed, and unowned-collision detail without changing summary semantics", () => {
    const fixture = readyFixture();
    const projectSkill = path.join(fixture.context.project, ".agents", "skills", "agentera");
    fs.mkdirSync(projectSkill, { recursive: true });
    fs.writeFileSync(path.join(projectSkill, "SKILL.md"), "---\nname: agentera\n---\n");
    const detailed = observeRuntimeLifecycle({
      ...fixture.context,
      ledger: emptyLifecycleOwnershipLedger(),
      categoryEvidence: {
        trust: { host: "unknown", cli: "denied", ide: "not_applicable" },
      },
    });
    const codex = detailed.runtimes.find((runtime) => runtime.runtimeId === "codex")!;
    const codexSurface = codex.surfaces[0];
    expect(codexSurface.evidence.trusted).toBe("denied");
    expect(codexSurface.status).toBe("degraded");
    const skills = codexSurface.categories.find((category) => category.category === "skills")!;
    expect(skills.state).toBe("blocked_unowned");
    expect(skills.precedence?.winner?.path).toBe(projectSkill);
    expect(skills.precedence?.shadowing.some((entry) => entry.canonical)).toBe(true);
    expect(codex.blockers.some((blocker) => blocker.kind === "unowned_collision")).toBe(true);
    const copilotAgents = detailed.runtimes.find((runtime) => runtime.runtimeId === "copilot")!
      .surfaces[0].categories.find((category) => category.category === "agents")!;
    expect(copilotAgents.state).toBe("unsupported");

    const summary = summarizeRuntimeLifecycle(detailed);
    const codexSummary = summary.runtimes.find((runtime) => runtime.runtimeId === "codex")!;
    expect(codexSummary.status).toBe(codex.status);
    expect(codexSummary.supportFloor).toEqual(codex.supportFloor);
    expect(codexSummary.blockerCount).toBe(codex.blockers.length);
    expect(JSON.stringify(summary)).not.toMatch(/precedence|evidence|remediation/);
  });
});
