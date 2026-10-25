import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";
import YAML from "yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const workflow = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/publish.yml"), "utf8"));
const developmentPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"), "utf8"));
const publicationContract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "references/adapters/package-publication.json"), "utf8"));
const verificationPolicy = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "references/analysis/verification-policy.yaml"), "utf8"));

const RELEASE_COMMAND = "vp run verify:development";
const SHARD_COMMAND = "vp run verify:development:shard";
const ISOLATED_COMMAND = "vp run verify:development:isolated";
const ASSEMBLE_COMMAND = "vp run verify:development:assemble";
const CHECKOUT_BUILD_COMMAND = "vp run build";
const MIGRATION_HARNESS = "bash scripts/sandbox/v2v3-upgrade-harness.sh";
const MIGRATION_STEP = "Run v2→v3 migration scenarios";
const CORE_JOB = "verify-development";
const ISOLATED_JOB = "verify-isolated-owners";
const SHARD_JOB = "verify-source-shard";
const BUILD_JOB = "build-development";
// Every partition the assembled development conjunction needs, in needs order.
const PARTITION_JOBS = [CORE_JOB, ISOLATED_JOB, SHARD_JOB];
const PARTITION_CONDITION = "needs.publication-state.outputs.mode == 'build'";
const BUILD_STEP_CONDITION = "steps.history.outputs.mode == 'build'";
// Shard 3 was the fastest shard in hosted run 40109973358, so it alone also
// builds the checkout CLI and runs the migration scenarios.
const MIGRATION_SHARD_CONDITION = "matrix.shard == 3";
const PARTITION_DIRECTORY = "${{ runner.temp }}/agentera-verification";
const PARTITION_UPLOADS: Record<string, string> = {
  [CORE_JOB]: "agentera-verification-core",
  [ISOLATED_JOB]: "agentera-verification-isolated",
  [SHARD_JOB]: "agentera-verification-shard-${{ matrix.shard }}",
};
// Each partition command runs exactly once, in its own job, and nowhere else.
const OWNER_PLACEMENT = [
  [RELEASE_COMMAND, CORE_JOB],
  [ISOLATED_COMMAND, ISOLATED_JOB],
  [SHARD_COMMAND, SHARD_JOB],
  [CHECKOUT_BUILD_COMMAND, SHARD_JOB],
  [MIGRATION_HARNESS, SHARD_JOB],
  [ASSEMBLE_COMMAND, BUILD_JOB],
] as const;
const PARITY_TEST = "packages/cli/test/cli/npmParityMatrix.test.ts";
const REMOVED_DUPLICATES = [
  {
    owner: "source",
    gate: "source",
    command: "pnpm -C packages/cli run test:source",
    forbidden: ["pnpm -C packages/cli test", "pnpm -C packages/cli run test:source"],
  },
  {
    owner: "package",
    gate: "package",
    command: "pnpm -C packages/cli run verify:package",
    forbidden: ["pnpm -C packages/cli run verify:package"],
  },
  {
    owner: "build",
    gate: "build",
    command: "pnpm -C packages/cli build",
    forbidden: ["pnpm -C packages/cli build"],
  },
] as const;

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown>; "continue-on-error"?: unknown };

function stepLines(step: Step): string[] {
  return typeof step.run === "string"
    ? step.run
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function runLines(candidate: any, job = CORE_JOB): string[] {
  return (candidate.jobs[job]?.steps ?? []).flatMap(stepLines);
}

function invokes(line: string, command: string): boolean {
  return line === command || line.startsWith(`${command} `);
}

// Evaluate checked-in Actions job conditions with GitHub's status-function
// semantics for a run that was not cancelled.
function condition(expression: string, needs: object): boolean {
  return Function(
    "needs",
    `return (${expression
      .replaceAll("always()", "true")
      .replaceAll("cancelled()", "false")
      .replace(/\bneeds\.([\w-]+)/g, 'needs["$1"]')})`,
  )(needs);
}

function validateRoutineCiOwnership(candidate: any): void {
  const jobs = Object.keys(candidate.jobs);

  // Every partition exists, and the candidate build needs every one of them.
  for (const name of PARTITION_JOBS) {
    if (!candidate.jobs[name]?.steps) throw new Error(`verification partition ${name} is missing`);
  }
  const build = candidate.jobs[BUILD_JOB];
  if (JSON.stringify(build.needs) !== JSON.stringify(["publication-state", ...PARTITION_JOBS])) {
    throw new Error("the candidate build must depend on every verification partition");
  }
  const shards = verificationPolicy.source_partitions.shards;
  const shardJob = candidate.jobs[SHARD_JOB];
  if (JSON.stringify(shardJob.strategy?.matrix) !== JSON.stringify({ shard: Array.from({ length: shards }, (_, index) => index + 1) })) {
    throw new Error("the shard matrix must cover every policy shard exactly once");
  }
  for (const name of PARTITION_JOBS) {
    const uploads = candidate.jobs[name].steps.filter((step: Step) => step.uses === "actions/upload-artifact@v4");
    if (uploads.length !== 1 || uploads[0].with?.name !== PARTITION_UPLOADS[name] || uploads[0].with?.path !== PARTITION_DIRECTORY || uploads[0].with?.["if-no-files-found"] !== "error") {
      throw new Error(`verification partition ${name} must upload its result`);
    }
  }

  // No partition, candidate build, or publisher overrides the success check.
  for (const name of PARTITION_JOBS) {
    const job = candidate.jobs[name];
    if (job.if !== PARTITION_CONDITION || job.needs !== "publication-state" || Object.hasOwn(job, "continue-on-error")) {
      throw new Error(`verification partition ${name} must not override the success check`);
    }
    for (const step of job.steps as Step[]) {
      const migrationOnly = name === SHARD_JOB && (step.name === MIGRATION_STEP || step.run === CHECKOUT_BUILD_COMMAND);
      if (Object.hasOwn(step, "continue-on-error") || (Object.hasOwn(step, "if") && !(migrationOnly && step.if === MIGRATION_SHARD_CONDITION))) {
        throw new Error(`verification partition ${name} must not override the success check`);
      }
    }
  }
  // The implicit success() check skips the build when any partition failed,
  // was cancelled, or was skipped. Its steps then gate only on its own history.
  if (Object.hasOwn(build, "if") || Object.hasOwn(build, "continue-on-error")) {
    throw new Error("the candidate build must keep the implicit success check");
  }
  for (const step of build.steps.slice(1) as Step[]) {
    if (step.if !== BUILD_STEP_CONDITION || Object.hasOwn(step, "continue-on-error")) {
      throw new Error("the candidate build must keep the implicit success check");
    }
  }
  for (const result of ["failure", "cancelled", "skipped"]) {
    const needs = {
      "publication-state": { result: "success", outputs: { mode: "build" } },
      [BUILD_JOB]: { result },
      "publish-development": { result: "skipped" },
    };
    if (condition(candidate.jobs["publish-development"].if, needs) || condition(candidate.jobs["confirm-development"].if, needs)) {
      throw new Error("publication must require a successful candidate build");
    }
  }
  if (JSON.stringify(candidate.jobs["publish-development"].needs) !== JSON.stringify(["publication-state", BUILD_JOB])) {
    throw new Error("publication must require a successful candidate build");
  }

  // Each owner runs only inside its own partition.
  for (const [command, owner] of OWNER_PLACEMENT) {
    for (const name of jobs) {
      const count = runLines(candidate, name).filter((line) => invokes(line, command)).length;
      if (count !== (name === owner ? 1 : 0)) throw new Error(`${command} must run exactly once, in ${owner}`);
    }
  }
  for (const name of jobs) {
    const lines = runLines(candidate, name);
    for (const entry of REMOVED_DUPLICATES) {
      if (entry.forbidden.some((command) => lines.some((line) => invokes(line, command)))) {
        throw new Error(`routine CI must not invoke ${entry.owner} outside generated overlap`);
      }
    }
    for (const gate of publicationContract.qualification.source.gates) {
      if (lines.some((line) => invokes(line, gate.command.join(" ")))) throw new Error(`routine CI must not invoke the ${gate.name} gate outside its partition`);
    }
  }
  const commandEnv = (name: string, command: string) => candidate.jobs[name].steps.find((step: Step) => step.run === command)?.env ?? {};
  const coreEnv = commandEnv(CORE_JOB, RELEASE_COMMAND);
  const shardEnv = commandEnv(SHARD_JOB, SHARD_COMMAND);
  const isolatedEnv = commandEnv(ISOLATED_JOB, ISOLATED_COMMAND);
  if (
    coreEnv.AGENTERA_SOURCE_PARTITION !== "core" ||
    coreEnv.AGENTERA_ISOLATED_OWNERS !== "delegate" ||
    Object.hasOwn(coreEnv, "AGENTERA_PERFORMANCE_RUNNER_IDENTITY") ||
    shardEnv.AGENTERA_SOURCE_PARTITION !== `shard:\${{ matrix.shard }}/${shards}` ||
    Object.hasOwn(shardEnv, "AGENTERA_ISOLATED_OWNERS") ||
    Object.hasOwn(isolatedEnv, "AGENTERA_SOURCE_PARTITION") ||
    Object.hasOwn(isolatedEnv, "AGENTERA_ISOLATED_OWNERS") ||
    isolatedEnv.AGENTERA_SOURCE_PARTITION_DIRECTORY !== PARTITION_DIRECTORY ||
    isolatedEnv.AGENTERA_PERFORMANCE_RUNNER_CLASS !== verificationPolicy.owners.performance.execution.authoritative_runner.runner_class ||
    isolatedEnv.AGENTERA_PERFORMANCE_RUNNER_IDENTITY !== "${{ runner.name }}"
  ) {
    throw new Error("each partition must select only its governed owners");
  }
  const isolatedJob = candidate.jobs[ISOLATED_JOB];
  if (isolatedJob["runs-on"] !== verificationPolicy.owners.performance.execution.authoritative_runner.runs_on || Object.hasOwn(isolatedJob, "strategy")) {
    throw new Error("the isolated owners must run alone on one authoritative runner");
  }
  const shardSteps: Step[] = shardJob.steps;
  const verifyIndex = shardSteps.findIndex((step) => step.run === SHARD_COMMAND);
  const buildIndex = shardSteps.findIndex((step) => step.run === CHECKOUT_BUILD_COMMAND);
  const migrationIndex = shardSteps.findIndex((step) => step.name === MIGRATION_STEP);
  const migration = shardSteps[migrationIndex];
  if (
    !(verifyIndex >= 0 && buildIndex === verifyIndex + 1 && migrationIndex === buildIndex + 1) ||
    shardSteps[buildIndex].if !== MIGRATION_SHARD_CONDITION ||
    migration.if !== MIGRATION_SHARD_CONDITION ||
    JSON.stringify(migration.env) !== JSON.stringify({ REPO_ROOT: "${{ github.workspace }}", AGENTERA_SANDBOX_TIER: "L1" }) ||
    migration.run !== 'set -euo pipefail\nfor scenario in happy-path-clean stable-safety noisy-app-home codex-plugin-vs-copied partial-only-runtime; do\n  bash scripts/sandbox/v2v3-upgrade-harness.sh "$scenario"\ndone\n'
  ) {
    throw new Error("the named shard must build the checkout CLI and run every migration scenario after its own verification");
  }

  // Assembly runs inside the candidate build, after every partition result is
  // downloaded and before any version allocation or construction.
  const buildSteps: Step[] = build.steps;
  const downloads = buildSteps.filter((step) => step.uses === "actions/download-artifact@v4");
  const downloadIndex = buildSteps.findIndex((step) => step.uses === "actions/download-artifact@v4");
  const assembleIndex = buildSteps.findIndex((step) => step.run === ASSEMBLE_COMMAND);
  const bootstrapIndex = buildSteps.findIndex((step) => step.run?.startsWith("node packages/cli/scripts/bootstrap-integrity.mjs"));
  const allocateIndex = buildSteps.findIndex((step) => step.id === "version");
  const constructIndex = buildSteps.findIndex((step) => step.run?.includes("packages/cli/scripts/pack-package.mjs"));
  const classifyIndex = buildSteps.findIndex((step) => step.id === "classification");
  const uploadIndex = buildSteps.findIndex((step) => step.uses === "actions/upload-artifact@v4");
  if (
    downloads.length !== 1 ||
    JSON.stringify(downloads[0].with) !== JSON.stringify({ pattern: "agentera-verification-*", path: PARTITION_DIRECTORY, "merge-multiple": true }) ||
    buildSteps[assembleIndex]?.env?.AGENTERA_SOURCE_PARTITION_DIRECTORY !== PARTITION_DIRECTORY ||
    !(bootstrapIndex >= 0 && bootstrapIndex < downloadIndex && downloadIndex < assembleIndex && assembleIndex < allocateIndex && allocateIndex < constructIndex && constructIndex < classifyIndex && classifyIndex < uploadIndex)
  ) {
    throw new Error("assembly must run on every downloaded partition before version allocation and construction");
  }
}

type Mutation = [string, (candidate: any) => void, string];

const steps = (candidate: any, job: string): Step[] => candidate.jobs[job].steps;
const stepBy = (candidate: any, job: string, match: (step: Step) => boolean): Step => steps(candidate, job).find(match)!;
const commandStep = (candidate: any, job: string, command: string) => stepBy(candidate, job, (step) => step.run === command);
const migrationStep = (candidate: any) => stepBy(candidate, SHARD_JOB, (step) => step.name === MIGRATION_STEP);
const moveStep = (candidate: any, job: string, match: (step: Step) => boolean, after: (step: Step) => boolean) => {
  const list = steps(candidate, job);
  const [moved] = list.splice(list.findIndex(match), 1);
  list.splice(list.findIndex(after) + 1, 0, moved!);
};
const isAssemble = (step: Step) => step.run === ASSEMBLE_COMMAND;
const isDownload = (step: Step) => step.uses === "actions/download-artifact@v4";

const PARTITION_MUTATIONS: Mutation[] = [
  ["isolated job missing from build needs", (candidate) => (candidate.jobs[BUILD_JOB].needs = ["publication-state", CORE_JOB, SHARD_JOB]), "the candidate build must depend on every verification partition"],
  ["core job missing from build needs", (candidate) => (candidate.jobs[BUILD_JOB].needs = ["publication-state", ISOLATED_JOB, SHARD_JOB]), "the candidate build must depend on every verification partition"],
  ["shard jobs missing from build needs", (candidate) => (candidate.jobs[BUILD_JOB].needs = ["publication-state", CORE_JOB, ISOLATED_JOB]), "the candidate build must depend on every verification partition"],
  ["build depends on routing only", (candidate) => (candidate.jobs[BUILD_JOB].needs = "route-development"), "the candidate build must depend on every verification partition"],
  ["isolated job deleted", (candidate) => delete candidate.jobs[ISOLATED_JOB], `verification partition ${ISOLATED_JOB} is missing`],
  ["short shard matrix", (candidate) => (candidate.jobs[SHARD_JOB].strategy.matrix.shard = [1, 2]), "the shard matrix must cover every policy shard exactly once"],
  ["isolated result not uploaded", (candidate) => candidate.jobs[ISOLATED_JOB].steps.pop(), `verification partition ${ISOLATED_JOB} must upload its result`],
  ["isolated result upload tolerates no files", (candidate) => (stepBy(candidate, ISOLATED_JOB, (step) => step.uses === "actions/upload-artifact@v4").with!["if-no-files-found"] = "warn"), `verification partition ${ISOLATED_JOB} must upload its result`],
  ["download skips partitions", (candidate) => (stepBy(candidate, BUILD_JOB, isDownload).with!.pattern = "agentera-verification-shard-*"), "assembly must run on every downloaded partition before version allocation and construction"],
  ["download keeps partitions apart", (candidate) => delete stepBy(candidate, BUILD_JOB, isDownload).with!["merge-multiple"], "assembly must run on every downloaded partition before version allocation and construction"],
];
const SUCCESS_MUTATIONS: Mutation[] = [
  ["build forced with always()", (candidate) => (candidate.jobs[BUILD_JOB].if = "always() && needs.publication-state.outputs.mode == 'build'"), "the candidate build must keep the implicit success check"],
  ["build forced with !cancelled()", (candidate) => (candidate.jobs[BUILD_JOB].if = "!cancelled()"), "the candidate build must keep the implicit success check"],
  ["build job continues on error", (candidate) => (candidate.jobs[BUILD_JOB]["continue-on-error"] = true), "the candidate build must keep the implicit success check"],
  ["assembly forced with always()", (candidate) => (stepBy(candidate, BUILD_JOB, isAssemble).if = "always() && steps.history.outputs.mode == 'build'"), "the candidate build must keep the implicit success check"],
  ["assembly continues on error", (candidate) => (stepBy(candidate, BUILD_JOB, isAssemble)["continue-on-error"] = true), "the candidate build must keep the implicit success check"],
  ["isolated job continues on error", (candidate) => (candidate.jobs[ISOLATED_JOB]["continue-on-error"] = true), `verification partition ${ISOLATED_JOB} must not override the success check`],
  ["isolated verification continues on error", (candidate) => (commandStep(candidate, ISOLATED_JOB, ISOLATED_COMMAND)["continue-on-error"] = true), `verification partition ${ISOLATED_JOB} must not override the success check`],
  ["core runs regardless of history", (candidate) => (candidate.jobs[CORE_JOB].if = "always()"), `verification partition ${CORE_JOB} must not override the success check`],
  ["shard upload runs after failure", (candidate) => (stepBy(candidate, SHARD_JOB, (step) => step.uses === "actions/upload-artifact@v4").if = "always()"), `verification partition ${SHARD_JOB} must not override the success check`],
  ["migration runs after failure", (candidate) => (migrationStep(candidate).if = "always() && matrix.shard == 3"), `verification partition ${SHARD_JOB} must not override the success check`],
  ["migration continues on error", (candidate) => (migrationStep(candidate)["continue-on-error"] = true), `verification partition ${SHARD_JOB} must not override the success check`],
  ["publisher accepts a failed build", (candidate) => (candidate.jobs["publish-development"].if = candidate.jobs["publish-development"].if.replace("needs.build-development.result == 'success'", "needs.build-development.result != 'cancelled'")), "publication must require a successful candidate build"],
  ["publisher ignores the build", (candidate) => (candidate.jobs["publish-development"].needs = ["publication-state"]), "publication must require a successful candidate build"],
];
const OWNER_MUTATIONS: Mutation[] = [
  ["core runs the isolated owners", (candidate) => delete commandStep(candidate, CORE_JOB, RELEASE_COMMAND).env!.AGENTERA_ISOLATED_OWNERS, "each partition must select only its governed owners"],
  ["core runs the complete source inventory", (candidate) => delete commandStep(candidate, CORE_JOB, RELEASE_COMMAND).env!.AGENTERA_SOURCE_PARTITION, "each partition must select only its governed owners"],
  ["core measures performance", (candidate) => (commandStep(candidate, CORE_JOB, RELEASE_COMMAND).env!.AGENTERA_PERFORMANCE_RUNNER_IDENTITY = "${{ runner.name }}"), "each partition must select only its governed owners"],
  ["shard delegates owners", (candidate) => (commandStep(candidate, SHARD_JOB, SHARD_COMMAND).env!.AGENTERA_ISOLATED_OWNERS = "delegate"), "each partition must select only its governed owners"],
  ["isolated job selects a source partition", (candidate) => (commandStep(candidate, ISOLATED_JOB, ISOLATED_COMMAND).env!.AGENTERA_SOURCE_PARTITION = "core"), "each partition must select only its governed owners"],
  ["isolated job loses runner identity", (candidate) => delete commandStep(candidate, ISOLATED_JOB, ISOLATED_COMMAND).env!.AGENTERA_PERFORMANCE_RUNNER_IDENTITY, "each partition must select only its governed owners"],
  ["isolated owners on another runner", (candidate) => (candidate.jobs[ISOLATED_JOB]["runs-on"] = "ubuntu-latest"), "the isolated owners must run alone on one authoritative runner"],
  ["isolated owners split across a matrix", (candidate) => (candidate.jobs[ISOLATED_JOB].strategy = { matrix: { owner: [1, 2] } }), "the isolated owners must run alone on one authoritative runner"],
  ["isolated owners in the core job", (candidate) => steps(candidate, CORE_JOB).push({ run: ISOLATED_COMMAND }), `${ISOLATED_COMMAND} must run exactly once, in ${ISOLATED_JOB}`],
  ["isolated owners in the shard job", (candidate) => steps(candidate, SHARD_JOB).push({ run: ISOLATED_COMMAND }), `${ISOLATED_COMMAND} must run exactly once, in ${ISOLATED_JOB}`],
  ["core conjunction in the isolated job", (candidate) => steps(candidate, ISOLATED_JOB).push({ run: RELEASE_COMMAND }), `${RELEASE_COMMAND} must run exactly once, in ${CORE_JOB}`],
  ["duplicate core conjunction", (candidate) => steps(candidate, CORE_JOB).push({ run: RELEASE_COMMAND }), `${RELEASE_COMMAND} must run exactly once, in ${CORE_JOB}`],
  ["checkout build back in the core", (candidate) => steps(candidate, CORE_JOB).push({ run: CHECKOUT_BUILD_COMMAND }), `${CHECKOUT_BUILD_COMMAND} must run exactly once, in ${SHARD_JOB}`],
  [
    "migration back in the core",
    (candidate) => {
      const [migration] = steps(candidate, SHARD_JOB).splice(
        steps(candidate, SHARD_JOB).findIndex((step) => step.name === MIGRATION_STEP),
        1,
      );
      delete migration!.if;
      steps(candidate, CORE_JOB).push(migration!);
    },
    `${MIGRATION_HARNESS} must run exactly once, in ${SHARD_JOB}`,
  ],
  ["migration on every shard", (candidate) => delete migrationStep(candidate).if, "the named shard must build the checkout CLI and run every migration scenario after its own verification"],
  ["migration on another shard", (candidate) => (migrationStep(candidate).if = "matrix.shard == 1"), `verification partition ${SHARD_JOB} must not override the success check`],
  [
    "migration before shard verification",
    (candidate) =>
      moveStep(
        candidate,
        SHARD_JOB,
        (step) => step.run === SHARD_COMMAND,
        (step) => step.name === MIGRATION_STEP,
      ),
    "the named shard must build the checkout CLI and run every migration scenario after its own verification",
  ],
  [
    "migration without a build",
    (candidate) =>
      steps(candidate, SHARD_JOB).splice(
        steps(candidate, SHARD_JOB).findIndex((step) => step.run === CHECKOUT_BUILD_COMMAND),
        1,
      ),
    `${CHECKOUT_BUILD_COMMAND} must run exactly once, in ${SHARD_JOB}`,
  ],
  ["migration ignores a scenario failure", (candidate) => (migrationStep(candidate).run = migrationStep(candidate).run!.replace('"$scenario"', '"$scenario" || true')), "the named shard must build the checkout CLI and run every migration scenario after its own verification"],
  ["shard runs the source owner directly", (candidate) => steps(candidate, SHARD_JOB).push({ run: "pnpm -C packages/cli run test:source" }), "routine CI must not invoke source outside generated overlap"],
  ["isolated job runs performance directly", (candidate) => steps(candidate, ISOLATED_JOB).push({ run: "pnpm -C packages/cli run test:performance" }), "routine CI must not invoke the performance gate outside its partition"],
  ["assembly in the isolated job", (candidate) => steps(candidate, ISOLATED_JOB).push({ run: ASSEMBLE_COMMAND }), `${ASSEMBLE_COMMAND} must run exactly once, in ${BUILD_JOB}`],
];
const ASSEMBLY_MUTATIONS: Mutation[] = [
  ["assembly after construction", (candidate) => moveStep(candidate, BUILD_JOB, isAssemble, (step) => step.run?.includes("pack-package.mjs") === true), "assembly must run on every downloaded partition before version allocation and construction"],
  ["assembly after version allocation", (candidate) => moveStep(candidate, BUILD_JOB, isAssemble, (step) => step.id === "version"), "assembly must run on every downloaded partition before version allocation and construction"],
  ["assembly after candidate upload", (candidate) => moveStep(candidate, BUILD_JOB, isAssemble, (step) => step.uses === "actions/upload-artifact@v4"), "assembly must run on every downloaded partition before version allocation and construction"],
  ["download after assembly", (candidate) => moveStep(candidate, BUILD_JOB, isDownload, isAssemble), "assembly must run on every downloaded partition before version allocation and construction"],
  ["download removed", (candidate) => steps(candidate, BUILD_JOB).splice(steps(candidate, BUILD_JOB).findIndex(isDownload), 1), "assembly must run on every downloaded partition before version allocation and construction"],
  ["assembly reads another directory", (candidate) => (stepBy(candidate, BUILD_JOB, isAssemble).env!.AGENTERA_SOURCE_PARTITION_DIRECTORY = "${{ runner.temp }}/elsewhere"), "assembly must run on every downloaded partition before version allocation and construction"],
  [
    "assembly moved to a separate job",
    (candidate) => {
      candidate.jobs.assemble = { needs: PARTITION_JOBS, steps: steps(candidate, BUILD_JOB).splice(steps(candidate, BUILD_JOB).findIndex(isAssemble), 1) };
    },
    `${ASSEMBLE_COMMAND} must run exactly once, in ${BUILD_JOB}`,
  ],
];

describe("routine CI owner DAG", () => {
  it("runs the core, isolated-owner, and shard partitions in parallel and assembles them before construction", () => {
    expect(() => validateRoutineCiOwnership(workflow)).not.toThrow();
    for (const name of PARTITION_JOBS) {
      expect(workflow.jobs[name]["runs-on"]).toBe("ubuntu-24.04");
      expect(workflow.jobs[name].if).toBe(PARTITION_CONDITION);
      // Partitions need only publication state, never each other, so they run in parallel.
      expect(workflow.jobs[name].needs).toBe("publication-state");
    }
    expect(workflow.on).toEqual({ push: null });
    expect(fs.existsSync(path.join(REPO_ROOT, ".github/workflows/verify-changes.yml"))).toBe(false);
    expect(JSON.stringify(workflow)).not.toMatch(/setup-bun|setup-uv/);
    expect(developmentPackage.scripts["verify:release"]).toBe("node scripts/release-qualification.mjs verify --json");
    expect(developmentPackage.scripts["verify:development:isolated"]).toBe("node scripts/release-qualification.mjs verify-isolated --json");
    expect(verificationPolicy.isolated_owners).toEqual(["stress", "performance", "capacity"]);
    expect(commandStep(workflow, CORE_JOB, RELEASE_COMMAND)).toMatchObject({
      env: {
        AGENTERA_VITEST_RUNNER_POLICY: "unmeasured",
        AGENTERA_GENERATED_OVERLAP_SOURCE_WORKERS: "2",
        AGENTERA_SOURCE_PARTITION: "core",
        AGENTERA_ISOLATED_OWNERS: "delegate",
      },
    });
    expect(commandStep(workflow, ISOLATED_JOB, ISOLATED_COMMAND)).toMatchObject({
      env: {
        AGENTERA_VITEST_RUNNER_POLICY: "unmeasured",
        AGENTERA_PERFORMANCE_RUNNER_CLASS: "github-hosted-ubuntu-24.04",
        AGENTERA_PERFORMANCE_RUNNER_IDENTITY: "${{ runner.name }}",
      },
    });
    const coreSteps = steps(workflow, CORE_JOB);
    const staticIndex = coreSteps.findIndex((candidate) => candidate.run === "vp check");
    const verifyIndex = coreSteps.findIndex((candidate) => candidate.run === RELEASE_COMMAND);
    expect(staticIndex).toBeGreaterThan(-1);
    expect(staticIndex).toBeLessThan(verifyIndex);
    expect(coreSteps.some((candidate) => candidate.run === "vp run typecheck")).toBe(false);
  });

  it.each(REMOVED_DUPLICATES)("retains positive $owner coverage through generated overlap", ({ owner, gate, command }) => {
    const source = publicationContract.qualification.source;
    expect(source.dag.generatedOverlapOrigins).toContain(owner);
    expect(source.gates.find((entry: { name: string }) => entry.name === gate)?.command.join(" ")).toBe(command);
  });

  it.each(REMOVED_DUPLICATES)("rejects a forbidden standalone $owner invocation", ({ owner, forbidden }) => {
    for (const job of [...PARTITION_JOBS, BUILD_JOB]) {
      const candidate = structuredClone(workflow);
      steps(candidate, job).push({ name: `Forbidden ${owner}`, run: forbidden[0], ...(job === BUILD_JOB ? { if: BUILD_STEP_CONDITION } : {}) });
      expect(() => validateRoutineCiOwnership(candidate)).toThrow(`routine CI must not invoke ${owner} outside generated overlap`);
    }
  });

  describe.each([
    ["drops a partition", PARTITION_MUTATIONS],
    ["overrides the success check", SUCCESS_MUTATIONS],
    ["runs an owner outside its partition", OWNER_MUTATIONS],
    ["moves assembly after construction", ASSEMBLY_MUTATIONS],
  ] as const)("rejects a layout that %s", (_family, mutations) => {
    it.each(mutations)("%s", (_name, mutate, message) => {
      const candidate = structuredClone(workflow);
      mutate(candidate);
      expect(() => validateRoutineCiOwnership(candidate)).toThrow(message);
    });
  });

  it("retains typecheck, parity, compact, stress, performance, and capacity coverage", () => {
    const source = publicationContract.qualification.source;
    const gateNames = source.gates.map((entry: { name: string }) => entry.name);
    expect(gateNames).toEqual(expect.arrayContaining(["typecheck", "compact", "stress", "performance", "capacity"]));
    expect(verificationPolicy.policies.release).toEqual(["source", "stress", "performance", "capacity", "package"]);
    expect(verificationPolicy.inventory.default_owner).toBe("source");
    // Hermetic parity drift tests stay in routine source verification.
    expect(verificationPolicy.inventory.rules.filter((rule: { path?: string; prefix?: string }) => rule.path === "packages/cli/test/scripts/pyTsParity.test.ts" || "packages/cli/test/scripts/pyTsParity.test.ts".startsWith(rule.prefix ?? "never/"))).toEqual([]);
    expect(verificationPolicy.inventory.rules.some((rule: { path?: string; prefix?: string }) => rule.path === PARITY_TEST || PARITY_TEST.startsWith(rule.prefix ?? "never/"))).toBe(false);
    expect(verificationPolicy.owners.performance.execution.authoritative_runner.runs_on).toBe("ubuntu-24.04");

    for (const [job, command] of [
      [CORE_JOB, RELEASE_COMMAND],
      [ISOLATED_JOB, ISOLATED_COMMAND],
      [SHARD_JOB, SHARD_COMMAND],
    ] as const) {
      const jobSteps = steps(workflow, job);
      const checkoutIndex = jobSteps.findIndex((step) => step.uses === "actions/checkout@v5");
      const conjunctionIndex = jobSteps.findIndex((step) => step.run === command);
      expect(checkoutIndex).toBeGreaterThanOrEqual(0);
      expect(checkoutIndex).toBeLessThan(conjunctionIndex);
      expect(jobSteps[checkoutIndex]!.with).toEqual({ ref: "${{ github.sha }}", "fetch-depth": 0 });
      expect(runLines(workflow, job)).not.toContain("bash packages/cli/scripts/py_ts_parity.sh --check --json");
    }
  });
});
