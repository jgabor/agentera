import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  checkSourceReceipt,
  formatPhaseResult,
  issueCandidateApproval,
  issueCiAttestation,
  issueSourceReceipt,
  RELEASE_CONTRACT,
  runSourceReceiptCheckCommand,
  sha256,
  toolVersion,
  validateAdapterSourceProvenance,
  validateCandidateApproval,
  validateCandidateReceipt,
  validateCiAttestation,
  validateSourceReceipt,
} from "../../scripts/release-qualification.mjs";
import { prepareTargetMetadata } from "../../scripts/publication-transaction.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const temporary: string[] = [];
const GOVERNED_GATES = RELEASE_CONTRACT.qualification.source.gates;

function outputObservation() {
  return {
    stdoutSha256: "0".repeat(64),
    stdoutBytes: 0,
    stderrSha256: "0".repeat(64),
    stderrBytes: 0,
  };
}

function overlapObservation() {
  const command = (name: string) => GOVERNED_GATES.find((gate: { name: string }) => gate.name === name)!.command;
  return {
    schemaVersion: RELEASE_CONTRACT.qualification.source.overlapEvidenceSchema,
    status: "pass",
    inventory: { source: 1, package: 1, stress: 1, performance: 1 },
    participants: {
      source: { command: command("source"), elapsedMs: 1, files: 1, tests: 1, pending: [] },
      package: { command: command("package"), elapsedMs: 1, files: 1, tests: 1, pending: [] },
      build: { command: command("build"), elapsedMs: 1, status: "pass" },
    },
    reader: {
      observed: true,
      all_observations_complete: true,
      identity_mismatches: 0,
      surface_validation_failures: 0,
      generations: ["generation-a"],
    },
    generation: "generation-a",
    invocation: "3.0.0-dev.41",
  };
}

function gateRecord(gate: { name: string; command: string[] }) {
  const overlapParticipant = ["source", "package", "build"].includes(gate.name);
  const barrier = ["compact", "capability-contract"].includes(gate.name);
  const performanceBarrier = gate.name === "performance";
  let observation: any;
  if (["source", "package"].includes(gate.name)) {
    observation = { command: gate.command, files: 1, tests: 1, pending: [] };
  } else if (gate.name === "build") {
    observation = { command: gate.command, status: "pass", generation: "generation-a" };
  } else if (gate.name === "generated-overlap") {
    observation = overlapObservation();
  } else if (gate.name === "performance") {
    observation = {
      inventoryFiles: 1,
      evidence: {
        schemaVersion: RELEASE_CONTRACT.qualification.source.performanceEvidenceSchema,
        status: "pass",
        sha256: "0".repeat(64),
        bytes: 1,
        samples: 1,
        maxima: {},
        runner: {},
      },
    };
  } else {
    observation = {
      ...(gate.name === "stress" ? { inventoryFiles: 1 } : {}),
      ...(barrier ? { generation: "generation-a" } : {}),
      ...outputObservation(),
    };
  }
  return {
    name: gate.name,
    origin: [...RELEASE_CONTRACT.qualification.source.dag.generatedOverlapOrigins].includes(gate.name)
      ? "generated-overlap"
      : gate.name,
    phase: barrier ? "barrier-b" : performanceBarrier ? "performance-barrier" : "batch-a",
    outcome: "passed",
    elapsedMs: 1,
    executed: overlapParticipant ? "generated-overlap participant" : "command",
    reused: false,
    observation,
  };
}

function sha512Integrity(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function write(root: string, relative: string, contents: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function fixture(): { repo: string; candidateDirectory: string; sourceCommit: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-release-qualification-test-"));
  temporary.push(root);
  const repo = path.join(root, "repo");
  const candidateDirectory = path.join(root, "candidate");
  fs.mkdirSync(repo);
  git(repo, "init", "--quiet");
  git(repo, "config", "user.name", "Release Qualification Test");
  git(repo, "config", "user.email", "release-qualification@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  write(repo, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(repo, "references/analysis/verification-policy.yaml", "schemaVersion: test\n");
  write(repo, "packages/cli/package.json", JSON.stringify({
    name: "agentera",
    version: "3.0.0-dev.41",
    agentera: { gitRef: HEAD },
  }, null, 2));
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "source");
  const sourceCommit = git(repo, "rev-parse", "HEAD");
  write(repo, "packages/cli/package.json", JSON.stringify({
    name: "agentera",
    version: "3.0.0-dev.41",
    agentera: { gitRef: sourceCommit },
  }, null, 2));
  git(repo, "add", "packages/cli/package.json");
  git(repo, "commit", "--quiet", "-m", "metadata");
  return { repo, candidateDirectory, sourceCommit };
}

async function sourceReceipt(repo: string, candidateDirectory: string) {
  return issueSourceReceipt({
    repo,
    candidateDirectory,
    gates: GOVERNED_GATES,
    runDag: async ({ gates }: { gates: Array<{ name: string; command: string[] }> }) => ({
      gates: gates.map(gateRecord),
      execution: { strategy: "stub", elapsedMs: 1 },
    }),
  }).then(({ receipt }: { receipt: any }) => receipt);
}

afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});

describe("release qualification receipts", () => {
  it("reuses source evidence after committed version and gitRef-only metadata changes", async () => {
    const { repo, candidateDirectory } = fixture();
    const first = await sourceReceipt(repo, candidateDirectory);
    const manifestPath = path.join(repo, "packages/cli/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.version = "3.0.0-dev.42";
    manifest.agentera.gitRef = "abcdef0123456789abcdef0123456789abcdef01";
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    git(repo, "add", "packages/cli/package.json");
    git(repo, "commit", "--quiet", "-m", "prepared metadata");

    const replay = await issueSourceReceipt({
      repo,
      candidateDirectory,
      gates: GOVERNED_GATES,
      runDag: async () => {
        throw new Error("matching source evidence must not rerun its gates");
      },
    });

    expect(replay.reused).toBe(true);
    expect(replay.receipt.receiptSha256).toBe(first.receiptSha256);
  });

  it("checks metadata-only staged changes without running gates or writing candidate state", async () => {
    const { repo, candidateDirectory } = fixture();
    const receipt = await sourceReceipt(repo, candidateDirectory);
    const receiptFile = path.join(candidateDirectory, "source-receipt.json");
    const before = {
      bytes: fs.readFileSync(receiptFile),
      entries: fs.readdirSync(candidateDirectory).sort(),
      status: git(repo, "status", "--porcelain=v1"),
      mtimeMs: fs.statSync(receiptFile).mtimeMs,
    };
    const manifestPath = path.join(repo, "packages/cli/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.version = "3.0.0-dev.42";
    manifest.agentera.gitRef = "abcdef0123456789abcdef0123456789abcdef01";
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    git(repo, "add", "packages/cli/package.json");
    const stagedStatus = git(repo, "status", "--porcelain=v1");

    expect(checkSourceReceipt({ repo, candidateDirectory }).receiptSha256).toBe(receipt.receiptSha256);
    expect(fs.readFileSync(receiptFile)).toEqual(before.bytes);
    expect(fs.readdirSync(candidateDirectory).sort()).toEqual(before.entries);
    expect(fs.statSync(receiptFile).mtimeMs).toBe(before.mtimeMs);
    expect(git(repo, "status", "--porcelain=v1")).toBe(stagedStatus);
    expect(before.status).toBe("");
  });

  it.each([
    ["source change", (repo: string) => write(repo, "packages/cli/src/source-change.ts", "export const changed = true;\n")],
    ["non-version package field", (repo: string) => {
      const file = path.join(repo, "packages/cli/package.json");
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      manifest.description = "changed source metadata";
      fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    }],
  ])("invalidates source receipt reuse after a staged %s", async (_label, change) => {
    const { repo, candidateDirectory } = fixture();
    await sourceReceipt(repo, candidateDirectory);
    change(repo);
    git(repo, "add", ".");
    expect(() => checkSourceReceipt({ repo, candidateDirectory }))
      .toThrow("source receipt no longer matches current component inputs");
  });

  it("rejects staged source that differs from a receipt-matching working tree", async () => {
    const { repo, candidateDirectory } = fixture();
    await sourceReceipt(repo, candidateDirectory);
    const file = path.join(repo, "references/analysis/verification-policy.yaml");
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, "schemaVersion: staged-change\n");
    git(repo, "add", "references/analysis/verification-policy.yaml");
    fs.writeFileSync(file, original);
    expect(() => checkSourceReceipt({ repo, candidateDirectory }))
      .toThrow("staged and working source inputs differ");
  });

  it("rejects staged package fields outside normalized metadata when the working file was restored", async () => {
    const { repo, candidateDirectory } = fixture();
    await sourceReceipt(repo, candidateDirectory);
    const file = path.join(repo, "packages/cli/package.json");
    const original = fs.readFileSync(file, "utf8");
    const manifest = JSON.parse(original);
    manifest.description = "staged source change";
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    git(repo, "add", "packages/cli/package.json");
    fs.writeFileSync(file, original);
    expect(() => checkSourceReceipt({ repo, candidateDirectory }))
      .toThrow("staged and working package inputs differ outside version and agentera.gitRef");
  });

  it("rejects one-field source receipt tampering in the read-only check", async () => {
    const { repo, candidateDirectory } = fixture();
    await sourceReceipt(repo, candidateDirectory);
    const file = path.join(candidateDirectory, "source-receipt.json");
    const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    receipt.gates[0].outcome = "failed";
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, canonicalJson(receipt), { mode: 0o400 });
    fs.chmodSync(file, 0o400);
    expect(() => checkSourceReceipt({ repo, candidateDirectory })).toThrow("digest does not match");
  });

  it("fails closed when the external candidate has no source receipt", () => {
    const { repo, candidateDirectory } = fixture();
    fs.mkdirSync(candidateDirectory);
    expect(() => checkSourceReceipt({ repo, candidateDirectory }))
      .toThrow("source receipt is missing");
  });

  it("emits a redacted structured fallback when the source receipt check fails", () => {
    const { repo, candidateDirectory } = fixture();
    fs.mkdirSync(candidateDirectory);
    const emitted: any[] = [];
    expect(() => runSourceReceiptCheckCommand(new Map([
      ["--candidate-dir", candidateDirectory],
      ["--json", true],
    ]), {
      repo,
      emit: (record: any) => emitted.push(record),
    })).toThrow("source receipt is missing");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      phase: "source-receipt-check",
      outcome: "failed",
      executed: "none",
      reused: false,
      nextAction: "run the existing broader pre-commit test policy",
    });
    expect(JSON.stringify(emitted[0])).not.toContain(candidateDirectory);
  });

  it("emits bounded structured and human source receipt reuse output without private data", async () => {
    const { repo, candidateDirectory } = fixture();
    await sourceReceipt(repo, candidateDirectory);
    const emitted: Array<{ result: any; json: boolean }> = [];
    const result = runSourceReceiptCheckCommand(new Map([
      ["--candidate-dir", candidateDirectory],
      ["--json", true],
    ]), {
      repo,
      emit: (record: any, json: boolean) => emitted.push({ result: record, json }),
    });

    expect(result).toMatchObject({
      package: "agentera",
      phase: "source-receipt-check",
      outcome: "passed",
      executed: "none",
      reused: true,
    });
    expect(emitted).toEqual([{ result, json: true }]);
    expect(JSON.stringify(result)).not.toContain(candidateDirectory);
    expect(JSON.stringify(result)).not.toContain("receiptSha256");
    expect(formatPhaseResult(result)).toContain("executed:none; reused:true");
    expect(formatPhaseResult(result)).not.toContain(candidateDirectory);
  });

  it("fails closed when an immutable receipt or its source component changes", async () => {
    const { repo, candidateDirectory } = fixture();
    await sourceReceipt(repo, candidateDirectory);
    write(repo, "packages/cli/src/release-marker.ts", "export const changed = true;\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "source change");

    await expect(sourceReceipt(repo, candidateDirectory)).rejects.toThrow("source receipt inputs changed");
  });

  it("does not issue a source receipt when the performance barrier fails", async () => {
    const { repo, candidateDirectory } = fixture();
    await expect(issueSourceReceipt({
      repo,
      candidateDirectory,
      gates: GOVERNED_GATES,
      runDag: async () => {
        const error = new Error("performance exceeded its remaining source deadline") as Error & { owner?: string };
        error.owner = "performance";
        throw error;
      },
    })).rejects.toMatchObject({ owner: "performance" });
    expect(fs.existsSync(path.join(candidateDirectory, "source-receipt.json"))).toBe(false);
  });

  it("seals all nine governed DAG gates and execution evidence in one source receipt", async () => {
    const { repo, candidateDirectory } = fixture();
    const governed = GOVERNED_GATES;
    const issued = await issueSourceReceipt({
      repo,
      candidateDirectory,
      gates: governed,
      runDag: async () => ({
        gates: governed.map(gateRecord),
        execution: {
          strategy: "parallel-overlap-dag",
          elapsedMs: 2,
          generation: "generation-a",
          leasesAfterBarrier: 0,
        },
      }),
    });

    expect(issued.receipt.gates.map((gate: { name: string }) => gate.name))
      .toEqual(governed.map((gate: { name: string }) => gate.name));
    expect(issued.receipt.gates).toHaveLength(9);
    expect(issued.receipt.gates.every((gate: { outcome: string }) => gate.outcome === "passed")).toBe(true);
    expect(issued.receipt.execution).toMatchObject({
      strategy: "parallel-overlap-dag",
      generation: "generation-a",
      leasesAfterBarrier: 0,
    });
    expect(JSON.parse(fs.readFileSync(path.join(candidateDirectory, "source-receipt.json"), "utf8")))
      .toEqual(issued.receipt);
  });

  it("rejects one-field digest tampering and semantic tampering for every governed gate", async () => {
    const { repo, candidateDirectory } = fixture();
    const receipt = await sourceReceipt(repo, candidateDirectory);
    const digestTamper = structuredClone(receipt);
    digestTamper.gates[0].outcome = "failed";
    expect(() => validateSourceReceipt({ repo, receipt: digestTamper })).toThrow("digest does not match");

    for (let index = 0; index < receipt.gates.length; index += 1) {
      const semanticTamper = structuredClone(receipt);
      semanticTamper.gates[index].outcome = "failed";
      const { receiptSha256: _discarded, ...content } = semanticTamper;
      semanticTamper.receiptSha256 = sha256(canonicalJson(content));
      expect(() => validateSourceReceipt({ repo, receipt: semanticTamper }))
        .toThrow(`source receipt gate '${receipt.gates[index].name}' has invalid execution evidence`);
    }

    const semanticMutations = [
      (candidate: any) => candidate.gates.pop(),
      (candidate: any) => { candidate.gates[0].origin = "source"; },
      (candidate: any) => { candidate.gates[0].phase = "barrier-b"; },
      (candidate: any) => { candidate.gates[0].elapsedMs = Number.POSITIVE_INFINITY; },
      (candidate: any) => { candidate.gates[0].executed = "none"; },
      (candidate: any) => { candidate.gates[0].reused = true; },
      (candidate: any) => { candidate.gates[0].observation = {}; },
    ];
    for (const mutate of semanticMutations) {
      const semanticTamper = structuredClone(receipt);
      mutate(semanticTamper);
      const { receiptSha256: _discarded, ...content } = semanticTamper;
      semanticTamper.receiptSha256 = sha256(canonicalJson(content));
      expect(() => validateSourceReceipt({ repo, receipt: semanticTamper })).toThrow();
    }
  });

  it("probes tool versions in a fresh isolated npm state even when the caller has a token", () => {
    const { repo } = fixture();
    let environment: NodeJS.ProcessEnv | undefined;
    expect(toolVersion("npm", ["--version"], repo, {
      environment: {
        HOME: "/hostile/home",
        NPM_TOKEN: "secret",
        NODE_AUTH_TOKEN: "secret",
        PNPM_HOME: "/hostile/pnpm",
      },
      run: (_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        environment = options.env;
        return "10.30.3\n";
      },
    })).toBe("10.30.3");
    expect(environment).toMatchObject({
      HOME: expect.stringContaining("agentera-release-tool-version-"),
      NPM_CONFIG_USERCONFIG: expect.any(String),
      NPM_CONFIG_GLOBALCONFIG: expect.any(String),
      NPM_CONFIG_CACHE: expect.any(String),
    });
    expect(environment).not.toHaveProperty("NPM_TOKEN");
    expect(environment).not.toHaveProperty("NODE_AUTH_TOKEN");
    expect(environment).not.toHaveProperty("PNPM_HOME");
  });

  it("requires stable shim gitRef to identify its current packaged inputs", () => {
    const { repo } = fixture();
    write(repo, "packages/cli/shim/bin/agentera.mjs", "export {};\n");
    write(repo, "packages/cli/shim/lib/resolve.mjs", "export {};\n");
    write(repo, "packages/cli/shim/README.md", "# Shim\n");
    write(repo, "packages/cli/shim/LICENSE", "Apache-2.0\n");
    write(repo, "packages/cli/shim/package.json", JSON.stringify({
      name: "agentera",
      version: "0.0.2",
      agentera: { gitRef: HEAD },
    }));
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "shim source");
    const sourceCommit = git(repo, "rev-parse", "HEAD");
    const manifestPath = path.join(repo, "packages/cli/shim/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.version = "0.0.3";
    manifest.agentera.gitRef = sourceCommit;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    git(repo, "add", manifestPath);
    git(repo, "commit", "--quiet", "-m", "shim preparation");

    expect(() => validateAdapterSourceProvenance({
      repo,
      adapter: RELEASE_CONTRACT.packages.stable,
      manifest,
    })).not.toThrow();

    write(repo, "packages/cli/shim/lib/resolve.mjs", "export const changed = true;\n");
    git(repo, "add", "packages/cli/shim/lib/resolve.mjs");
    git(repo, "commit", "--quiet", "-m", "unrelated historical gitRef");
    expect(() => validateAdapterSourceProvenance({
      repo,
      adapter: RELEASE_CONTRACT.packages.stable,
      manifest,
    })).toThrow("does not match the stable shim packaged inputs");
  });

  it("rejects a missing candidate directory without creating it", () => {
    const { repo, candidateDirectory } = fixture();

    expect(() => validateCandidateReceipt({ repo, candidateDirectory, adapterName: "development" }))
      .toThrow("candidate directory is missing");
    expect(fs.existsSync(candidateDirectory)).toBe(false);
  });

  it("binds a candidate receipt to the retained immutable artifact bytes", async () => {
    const { repo, candidateDirectory, sourceCommit } = fixture();
    const source = await sourceReceipt(repo, candidateDirectory);
    const artifact = Buffer.from("exact candidate bytes");
    const filename = "agentera-3.0.0-dev.41.tgz";
    fs.writeFileSync(path.join(candidateDirectory, filename), artifact, { mode: 0o444 });
    const candidate: Record<string, unknown> = {
      schemaVersion: "agentera.releaseQualification.v1",
      kind: "candidate",
      sourceReceiptSha256: source.receiptSha256,
      metadataCommit: git(repo, "rev-parse", "HEAD"),
      sourceCommit,
      adapter: "development",
      package: "agentera",
      version: "3.0.0-dev.41",
      registry: "https://registry.npmjs.org/",
      expectedTag: "next",
      candidateTag: "candidate-3.0.0-dev.41",
      artifact: {
        filename,
        sha256: sha256(artifact),
        integrity: sha512Integrity(artifact),
        bytes: artifact.byteLength,
        mode: 0o444,
        construction: { name: "agentera", version: "3.0.0-dev.41", fileCount: 1, packedSize: 21, unpackedSize: 21, shasum: "test" },
        dryPackEquivalent: true,
      },
      gates: [],
    };
    candidate.receiptSha256 = sha256(canonicalJson(candidate));

    const checked = validateCandidateReceipt({
      repo,
      candidateDirectory,
      receipt: candidate,
      adapterName: "development",
    });
    expect(checked.artifact).toBe(path.join(candidateDirectory, filename));

    fs.writeFileSync(path.join(candidateDirectory, "candidate-receipt.json"), canonicalJson(candidate), { mode: 0o400 });
    const approval = issueCandidateApproval({
      repo,
      candidateDirectory,
      adapterName: "development",
      approvedBy: "release-owner",
    });
    expect(validateCandidateApproval({ repo, candidateDirectory, candidate: checked })).toMatchObject({
      receiptSha256: approval.receiptSha256,
      candidateReceiptSha256: candidate.receiptSha256,
    });
    const environment = {
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: candidate.metadataCommit as string,
      GITHUB_REPOSITORY: "jgabor/agentera",
      GITHUB_WORKFLOW: "Qualify release candidate",
      GITHUB_WORKFLOW_REF: "jgabor/agentera/.github/workflows/qualify-candidate.yml@refs/heads/feat/v3",
      GITHUB_RUN_ID: "123",
    };
    issueCiAttestation({ repo, candidateDirectory, adapterName: "development", environment });
    expect(validateCiAttestation({
      repo,
      candidateDirectory,
      candidate: checked,
      sourceRunId: "123",
      environment,
    })).toMatchObject({ candidateReceiptSha256: candidate.receiptSha256 });
    expect(() => issueCandidateApproval({
      repo,
      candidateDirectory,
      adapterName: "development",
      approvedBy: "release-owner",
      environment,
      sourceRunId: "456",
    })).toThrow("CI attestation is not bound");

    const attestation = issueCiAttestation({ repo, candidateDirectory, adapterName: "development", environment });
    for (const [field, value] of Object.entries({
      repository: "other/repository",
      workflow: "Other workflow",
      workflowRef: "jgabor/agentera/.github/workflows/other.yml@refs/heads/feat/v3",
      runId: "456",
    })) {
      const substituted = { ...attestation, [field]: value };
      substituted.receiptSha256 = sha256(canonicalJson({
        ...substituted,
        receiptSha256: undefined,
      }));
      delete substituted.receiptSha256;
      substituted.receiptSha256 = sha256(canonicalJson(substituted));
      expect(() => validateCiAttestation({
        repo,
        candidateDirectory,
        candidate: checked,
        sourceRunId: "123",
        environment,
        attestation: substituted,
      })).toThrow("CI attestation is not bound");
    }

    fs.chmodSync(path.join(candidateDirectory, filename), 0o644);
    expect(() => validateCandidateReceipt({ repo, candidateDirectory, receipt: candidate, adapterName: "development" }))
      .toThrow("candidate artifact permissions changed after qualification");
    fs.chmodSync(path.join(candidateDirectory, filename), 0o644);
    fs.appendFileSync(path.join(candidateDirectory, filename), "changed");
    fs.chmodSync(path.join(candidateDirectory, filename), 0o444);
    expect(() => validateCandidateReceipt({ repo, candidateDirectory, receipt: candidate, adapterName: "development" }))
      .toThrow("candidate artifact changed after qualification");
  });
});

describe("explicit preparation", () => {
  const manifest = {
    name: "agentera",
    version: "3.0.0-dev.41",
    dependencies: { yaml: "^2" },
    agentera: { suiteVersion: "3.0.0", gitRef: HEAD },
  };

  it("changes only the requested next version and source commit", () => {
    const prepared = prepareTargetMetadata(
      "development",
      manifest,
      "3.0.0-dev.42",
      "abcdef0123456789abcdef0123456789abcdef01",
    );
    expect(prepared.changed).toBe(true);
    expect(prepared.manifest).toEqual({
      ...manifest,
      version: "3.0.0-dev.42",
      agentera: { suiteVersion: "3.0.0", gitRef: "abcdef0123456789abcdef0123456789abcdef01" },
    });
  });

  it("makes the exact current target a no-op and rejects stale or skipped targets", () => {
    expect(prepareTargetMetadata("development", manifest, manifest.version, manifest.agentera.gitRef).changed).toBe(false);
    expect(() => prepareTargetMetadata("development", manifest, "3.0.0-dev.41", "abcdef0123456789abcdef0123456789abcdef01"))
      .toThrow("not the next");
    expect(() => prepareTargetMetadata("development", manifest, "3.0.0-dev.43", "abcdef0123456789abcdef0123456789abcdef01"))
      .toThrow("not the next");
  });
});
