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
  const supportFloor = runtime.supportFloor as Record<string, unknown>;
  return {
    runtimeId: runtime.runtimeId,
    status: runtime.status,
    readiness: runtime.readiness,
    supportFloor: {
      met: supportFloor.met,
      releaseBlocking: supportFloor.releaseBlocking,
      unmet: supportFloor.unmet,
    },
    surfaces: (runtime.surfaces as Array<Record<string, unknown>>).map((surface) => ({
      id: surface.id,
      expected: surface.expected,
      status: surface.status,
    })),
  };
}

function assertProjectionParity(
  summary: Record<string, unknown>,
  diagnosis: Record<string, unknown>,
): void {
  expect(summary.activeRuntimeIds).toEqual(EXPECTED_RUNTIME_IDS);
  expect(diagnosis.activeRuntimeIds).toEqual(EXPECTED_RUNTIME_IDS);
  expect(summary.snapshotVersion).toBe(diagnosis.schemaVersion);
  expect(summary.statusVocabularyVersion).toBe(diagnosis.statusVocabularyVersion);
  expect(summary.authority).toBe(diagnosis.authority);
  expect(summary.releaseBlocked).toBe(diagnosis.releaseBlocked);

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
}

type LifecycleFixtureName =
  | "unknown trust"
  | "denied trust"
  | "Cursor Agentera-integrated / IDE conditional"
  | "skill shadowing"
  | "absent host / missing parent"
  | "unowned collision"
  | "all ready";

interface LifecycleHarnessFixture {
  name: LifecycleFixtureName;
  doctorStatus: 0 | 1;
  releaseBlocked: boolean;
  arrange: (home: string, project: string) => {
    surfaceEvidence: RuntimeAdapterInspectionContext["surfaceEvidence"];
    ledger?: ReturnType<typeof emptyLifecycleOwnershipLedger>;
  };
  assertDiagnosis: (snapshot: Record<string, unknown>) => void;
}

const trustedEvidence = (trusted: true | "unknown" | "denied", idePresent = true) => ({
  host: { host_present: true as const, enabled: true as const, trusted },
  cli: { host_present: true as const, enabled: true as const, trusted },
  ide: idePresent
    ? { host_present: true as const, enabled: true as const, trusted }
    : { host_present: false as const },
});

function readyContext(home: string, project: string): RuntimeAdapterInspectionContext {
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
  return {
    home,
    project,
    sourceRoot: REPO_ROOT,
    env: { PATH: "" },
    surfaceEvidence: trustedEvidence(true),
    categoryEvidence: {
      trust: { host: true, cli: true, ide: true },
      enablement: { host: true, cli: true, ide: true },
    },
  };
}

function installReadyLifecycle(home: string, project: string): ReturnType<typeof emptyLifecycleOwnershipLedger> {
  const context = readyContext(home, project);
  let ledger = emptyLifecycleOwnershipLedger();
  for (const adapter of runtimeLifecycleAdapters()) {
    const result = applyRuntimeAdapterRepair(adapter.inspect({ ...context, ledger }));
    expect(result.status).toBe("success");
    ledger = result.ownershipLedger;
  }
  return ledger;
}

function runtimeById(snapshot: Record<string, unknown>, runtimeId: string): Record<string, unknown> {
  return (snapshot.runtimes as Array<Record<string, unknown>>)
    .find((runtime) => runtime.runtimeId === runtimeId)!;
}

const lifecycleHarnessFixtures: LifecycleHarnessFixture[] = [
  {
    name: "unknown trust",
    doctorStatus: 1,
    releaseBlocked: true,
    arrange: (home, project) => ({
      surfaceEvidence: trustedEvidence("unknown"),
      ledger: installReadyLifecycle(home, project),
    }),
    assertDiagnosis: (snapshot) => {
      const codex = runtimeById(snapshot, "codex");
      expect(codex.status).toBe("blocked");
      expect(codex.blockers).toContainEqual(expect.objectContaining({
        code: "mandatory_evidence_unknown",
        evidence: { field: "trusted", observed: "unknown" },
      }));
    },
  },
  {
    name: "denied trust",
    doctorStatus: 1,
    releaseBlocked: true,
    arrange: (home, project) => ({
      surfaceEvidence: trustedEvidence("denied"),
      ledger: installReadyLifecycle(home, project),
    }),
    assertDiagnosis: (snapshot) => {
      const codex = runtimeById(snapshot, "codex");
      expect((codex.surfaces as Array<Record<string, unknown>>)[0]).toMatchObject({
        status: "blocked",
        releaseBlocking: true,
      });
      expect(codex.blockers).toContainEqual(expect.objectContaining({
        code: "mandatory_trust_denied",
        evidence: { field: "trusted", observed: "denied" },
      }));
    },
  },
  {
    name: "Cursor Agentera-integrated / IDE conditional",
    doctorStatus: 0,
    releaseBlocked: false,
    arrange: (home, project) => ({
      surfaceEvidence: {
        ...trustedEvidence(true, false),
        ide: { host_present: false, enabled: true, trusted: true },
      },
      ledger: installReadyLifecycle(home, project),
    }),
    assertDiagnosis: (snapshot) => {
      const cursor = runtimeById(snapshot, "cursor");
      expect(cursor.status).toBe("degraded");
      expect(cursor.surfaces).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "cli", expected: true, status: "ready" }),
        expect.objectContaining({ id: "ide", expected: true, applicability: "conditional", status: "degraded", releaseBlocking: false }),
      ]));
    },
  },
  {
    name: "skill shadowing",
    doctorStatus: 0,
    releaseBlocked: false,
    arrange: (home, project) => {
      const ledger = installReadyLifecycle(home, project);
      const projectSkill = path.join(project, ".agents", "skills", "agentera");
      fs.mkdirSync(projectSkill, { recursive: true });
      fs.writeFileSync(path.join(projectSkill, "SKILL.md"), "---\nname: agentera\n---\n");
      return { surfaceEvidence: trustedEvidence(true), ledger };
    },
    assertDiagnosis: (snapshot) => {
      const codex = runtimeById(snapshot, "codex");
      const skills = ((codex.surfaces as Array<Record<string, unknown>>)[0].categories as Array<Record<string, unknown>>)
        .find((category) => category.category === "skills")!;
      expect((skills.precedence as Record<string, unknown>).shadowing).toEqual([
        expect.objectContaining({ canonical: true }),
      ]);
    },
  },
  {
    name: "absent host / missing parent",
    doctorStatus: 1,
    releaseBlocked: true,
    arrange: () => ({
      surfaceEvidence: {
        host: { host_present: false, enabled: false, trusted: true },
        cli: { host_present: false, enabled: false, trusted: true },
        ide: { host_present: false },
      },
    }),
    assertDiagnosis: (snapshot) => {
      const opencode = runtimeById(snapshot, "opencode");
      expect(opencode.status).toBe("blocked");
      expect((opencode.surfaces as Array<Record<string, unknown>>)[0]).toMatchObject({
        status: "degraded",
        evidence: { host_present: false, installed: false, enabled: false, trusted: true },
      });
      expect(opencode.blockers).toContainEqual(expect.objectContaining({
        code: "canonical_skill_not_detected",
      }));
    },
  },
  {
    name: "unowned collision",
    doctorStatus: 0,
    releaseBlocked: false,
    arrange: (home, project) => {
      mkdirs([home, project, path.join(home, ".agents", "skills"), path.join(home, ".config", "opencode", "plugins")]);
      const context = readyContext(home, project);
      const copilot = runtimeLifecycleAdapters().find((adapter) => adapter.runtimeId === "copilot")!;
      const installed = applyRuntimeAdapterRepair(copilot.inspect(context));
      expect(installed.status).toBe("success");
      fs.copyFileSync(
        path.join(REPO_ROOT, ".opencode", "plugins", "agentera.js"),
        path.join(home, ".config", "opencode", "plugins", "agentera.js"),
      );
      return { surfaceEvidence: trustedEvidence(true), ledger: installed.ownershipLedger };
    },
    assertDiagnosis: (snapshot) => {
      const opencode = runtimeById(snapshot, "opencode");
      expect(opencode.blockers).toContainEqual(expect.objectContaining({
        code: "unowned_collision",
        category: "plugins",
      }));
      expect((opencode.supportFloor as Record<string, unknown>).met).toBe(true);
    },
  },
  {
    name: "all ready",
    doctorStatus: 0,
    releaseBlocked: false,
    arrange: (home, project) => ({
      surfaceEvidence: trustedEvidence(true),
      ledger: installReadyLifecycle(home, project),
    }),
    assertDiagnosis: (snapshot) => {
      const runtimes = snapshot.runtimes as Array<Record<string, unknown>>;
      expect(runtimes.map((runtime) => runtime.status)).toEqual(["ready", "ready", "ready", "ready"]);
      expect(runtimes.every((runtime) =>
        (runtime.supportFloor as Record<string, unknown>).met === true)).toBe(true);
      expect(runtimes.flatMap((runtime) => runtime.blockers as Array<Record<string, unknown>>)
        .filter((blocker) => blocker.kind === "support_floor")).toEqual([]);
      const copilot = runtimeById(snapshot, "copilot");
      const agents = ((copilot.surfaces as Array<Record<string, unknown>>)[0].categories as Array<Record<string, unknown>>)
        .find((category) => category.category === "agents")!;
      expect(agents.state).toBe("unsupported");
    },
  },
];

describe("test-only lifecycle observer harness parity", () => {
  it.each(lifecycleHarnessFixtures)("projects identical prime and doctor semantics for $name", (fixture) => {
    const root = tempRoot("lifecycle-harness-");
    const home = fixture.name === "unknown trust" ? deepPath(root, "home", 9) : path.join(root, "home");
    const project = fixture.name === "unknown trust" ? deepPath(root, "project", 4) : path.join(root, "project");
    const bin = path.join(root, "bin");
    const invocationMarker = path.join(root, "native-process-invoked");
    mkdirs([home, project]);
    writeTrapBinaries(bin, invocationMarker);
    const arranged = fixture.arrange(home, project);
    const before = treeSnapshot(root);
    const observed = observeRuntimeLifecycle({
      home,
      project,
      sourceRoot: REPO_ROOT,
      env: { PATH: bin },
      ...arranged,
    });
    const diagnosis = observed as unknown as Record<string, unknown>;
    const summary = summarizeRuntimeLifecycle(observed) as unknown as Record<string, unknown>;

    assertProjectionParity(summary, diagnosis);
    expect(summary.releaseBlocked).toBe(fixture.releaseBlocked);
    expect(diagnosis.releaseBlocked).toBe(fixture.releaseBlocked);
    expect(fixture.doctorStatus).toBe(fixture.releaseBlocked ? 1 : 0);
    const summaryBytes = Buffer.byteLength(JSON.stringify(summary));
    const diagnosisBytes = Buffer.byteLength(JSON.stringify(diagnosis));
    expect(summaryBytes).toBeLessThan(4_096);
    expect(JSON.stringify(summary)).not.toMatch(/categories|"evidence":|remediation|nativeActions|"command":/);
    expect(diagnosisBytes).toBeGreaterThan(summaryBytes * 8);
    const doctorRuntimes = diagnosis.runtimes as Array<Record<string, unknown>>;
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
    fixture.assertDiagnosis(diagnosis);
    expect(fs.existsSync(invocationMarker)).toBe(false);
    expect(treeSnapshot(root)).toEqual(before);
  });
});

describe("prime and doctor lifecycle integration", () => {
  it("ignores all test environment evidence in the built CLI", () => {
    const root = tempRoot("lifecycle-production-guard-");
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const bin = path.join(root, "bin");
    const invocationMarker = path.join(root, "native-process-invoked");
    mkdirs([home, project]);
    writeTrapBinaries(bin, invocationMarker);
    const fakeInputPath = path.join(root, "runtime-lifecycle-input.json");
    fs.writeFileSync(fakeInputPath, JSON.stringify({
      surfaceEvidence: trustedEvidence(true),
      ledger: installReadyLifecycle(home, project),
    }));
    const baselineEnv = {
      ...process.env,
      HOME: home,
      PATH: bin,
      AGENTERA_HOME: REPO_ROOT,
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
    };
    delete baselineEnv.NODE_ENV;
    for (const key of Object.keys(baselineEnv)) {
      if (key.startsWith("AGENTERA_TEST_")) delete baselineEnv[key];
    }
    const spoofedEnv = {
      ...baselineEnv,
      NODE_ENV: "test",
      AGENTERA_TEST_RUNTIME_LIFECYCLE_INPUT: fakeInputPath,
      AGENTERA_TEST_UNUSED: "must-not-affect-lifecycle-evidence",
    };
    const before = treeSnapshot(root);
    const primeArgs = ["prime", "--format", "json", "--fields", "runtime_lifecycle"];
    const doctorArgs = ["doctor", "--home", home, "--project", project, "--format", "json"];

    const baselinePrime = runCli(primeArgs, project, baselineEnv);
    const baselineDoctor = runCli(doctorArgs, project, baselineEnv);
    const spoofedPrime = runCli(primeArgs, project, spoofedEnv);
    const spoofedDoctor = runCli(doctorArgs, project, spoofedEnv);

    expect(baselinePrime.status, baselinePrime.stderr).toBe(0);
    expect(spoofedPrime.status, spoofedPrime.stderr).toBe(0);
    expect(baselineDoctor.status, baselineDoctor.stderr).toBe(1);
    expect(spoofedDoctor.status, spoofedDoctor.stderr).toBe(baselineDoctor.status);
    const baselineSummary = (JSON.parse(baselinePrime.stdout) as Record<string, unknown>)
      .runtime_lifecycle as Record<string, unknown>;
    const spoofedSummary = (JSON.parse(spoofedPrime.stdout) as Record<string, unknown>)
      .runtime_lifecycle as Record<string, unknown>;
    const baselineDiagnosis = (JSON.parse(baselineDoctor.stdout) as Record<string, unknown>)
      .runtime_lifecycle as Record<string, unknown>;
    const spoofedDiagnosis = (JSON.parse(spoofedDoctor.stdout) as Record<string, unknown>)
      .runtime_lifecycle as Record<string, unknown>;
    expect(spoofedSummary).toEqual(baselineSummary);
    expect(spoofedDiagnosis).toEqual(baselineDiagnosis);
    assertProjectionParity(baselineSummary, baselineDiagnosis);
    expect(baselineDiagnosis.releaseBlocked).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(baselineSummary))).toBeLessThan(4_096);
    expect(Buffer.byteLength(baselineDoctor.stdout)).toBeGreaterThan(32_768);
    expect(fs.existsSync(invocationMarker)).toBe(false);
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("renders bounded prime text and detailed doctor text from lifecycle projections", () => {
    const root = tempRoot("lifecycle-text-");
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const bin = path.join(root, "bin");
    const invocationMarker = path.join(root, "native-process-invoked");
    mkdirs([home, project]);
    writeTrapBinaries(bin, invocationMarker);
    const env = {
      ...process.env,
      HOME: home,
      PATH: bin,
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
    };
    const before = treeSnapshot(root);
    const prime = runCli(["prime"], project, env);
    const doctor = runCli(["doctor", "--home", home, "--project", project], project, env);
    expect(prime.status, prime.stderr).toBe(0);
    expect(prime.stdout).toContain("runtime_lifecycle: snapshot=agentera.runtimeLifecycleSnapshot.v1");
    expect(prime.stdout).toContain("- cursor: status=");
    expect(prime.stdout).not.toContain("native step:");
    expect(doctor.status, doctor.stderr).toBe(1);
    expect(doctor.stdout).toContain("Runtime lifecycle diagnosis:");
    expect(doctor.stdout).toContain("skills: ");
    expect(doctor.stdout).toContain("trust: unknown");
    expect(doctor.stdout).toContain("native step: /skills reload");
    expect(fs.existsSync(invocationMarker)).toBe(false);
    expect(treeSnapshot(root)).toEqual(before);
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

    const integrated = observeRuntimeLifecycle({
      ...fixture.context,
      ledger: fixture.ledger,
      surfaceEvidence: {
        cli: { host_present: true, enabled: true, trusted: true },
        ide: { host_present: false, enabled: true, trusted: true },
      },
      categoryEvidence: { trust: { cli: true, ide: true } },
    });
    const integratedCursor = integrated.runtimes.find((runtime) => runtime.runtimeId === "cursor")!;
    expect(integratedCursor.surfaces.map((surface) => [surface.id, surface.expected, surface.status])).toEqual([
      ["cli", true, "ready"],
      ["ide", true, "degraded"],
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
    expect(codexSurface.status).toBe("blocked");
    expect(codexSurface.releaseBlocking).toBe(true);
    expect(codex.supportFloor.met).toBe(false);
    expect(codex.blockers).toContainEqual(expect.objectContaining({
      code: "mandatory_trust_denied",
      evidence: { field: "trusted", observed: "denied" },
    }));
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
    expect(codexSummary.supportFloor).toEqual({
      met: codex.supportFloor.met,
      releaseBlocking: codex.supportFloor.releaseBlocking,
      unmet: codex.supportFloor.unmet,
    });
    expect(codexSummary.blockerCount).toBe(codex.blockers.length);
    expect(JSON.stringify(summary)).not.toMatch(/precedence|"evidence":|remediation/);
  });
});
