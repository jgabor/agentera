import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  issueCandidateApproval,
  issueCiAttestation,
  issueSourceReceipt,
  sha256,
  validateCandidateApproval,
  validateCandidateReceipt,
  validateCiAttestation,
} from "../../scripts/release-qualification.mjs";
import { prepareTargetMetadata } from "../../scripts/publication-transaction.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const temporary: string[] = [];

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

function sourceReceipt(repo: string, candidateDirectory: string) {
  return issueSourceReceipt({
    repo,
    candidateDirectory,
    gates: [{ name: "source", command: ["test", "source"] }],
    run: () => "",
  }).receipt;
}

afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});

describe("release qualification receipts", () => {
  it("reuses source evidence after committed version and gitRef-only metadata changes", () => {
    const { repo, candidateDirectory } = fixture();
    const first = sourceReceipt(repo, candidateDirectory);
    const manifestPath = path.join(repo, "packages/cli/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.version = "3.0.0-dev.42";
    manifest.agentera.gitRef = "abcdef0123456789abcdef0123456789abcdef01";
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    git(repo, "add", "packages/cli/package.json");
    git(repo, "commit", "--quiet", "-m", "prepared metadata");

    const replay = issueSourceReceipt({
      repo,
      candidateDirectory,
      gates: [{ name: "source", command: ["test", "source"] }],
      run: () => {
        throw new Error("matching source evidence must not rerun its gates");
      },
    });

    expect(replay.reused).toBe(true);
    expect(replay.receipt.receiptSha256).toBe(first.receiptSha256);
  });

  it("fails closed when an immutable receipt or its source component changes", () => {
    const { repo, candidateDirectory } = fixture();
    sourceReceipt(repo, candidateDirectory);
    write(repo, "packages/cli/src/release-marker.ts", "export const changed = true;\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "source change");

    expect(() => sourceReceipt(repo, candidateDirectory)).toThrow("source receipt inputs changed");
  });

  it("rejects a missing candidate directory without creating it", () => {
    const { repo, candidateDirectory } = fixture();

    expect(() => validateCandidateReceipt({ repo, candidateDirectory, adapterName: "development" }))
      .toThrow("candidate directory is missing");
    expect(fs.existsSync(candidateDirectory)).toBe(false);
  });

  it("binds a candidate receipt to the retained immutable artifact bytes", () => {
    const { repo, candidateDirectory, sourceCommit } = fixture();
    const source = sourceReceipt(repo, candidateDirectory);
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
      GITHUB_WORKFLOW: "qualify-candidate",
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

    fs.chmodSync(path.join(candidateDirectory, filename), 0o644);
    fs.appendFileSync(path.join(candidateDirectory, filename), "changed");
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
