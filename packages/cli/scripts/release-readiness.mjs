#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseFlags } from "./release-arguments.mjs";
import {
  checkSourceReceipt,
  issueCandidateReceipt,
  issueSourceReceipt,
  RELEASE_CONTRACT,
  RELEASE_MODEL,
  validateCandidateReceipt,
} from "./release-qualification.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(scriptDirectory, "../../..");
export const READINESS_CONTRACT = RELEASE_MODEL.readiness;
const DEVELOPMENT_ADAPTER = RELEASE_CONTRACT.packages[READINESS_CONTRACT.adapter];
const SOURCE_RECEIPT = READINESS_CONTRACT.receipts.source;
const CANDIDATE_RECEIPT = READINESS_CONTRACT.receipts.candidate;
const USAGE = "usage: release-readiness.mjs development --candidate-dir DIR --source-commit SHA [--metadata-commit SHA] [--json]";

function git(repo, args) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
  return result.stdout.trim();
}

function commitExists(repo, commit) {
  return spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
    cwd: repo,
    env: process.env,
    stdio: "ignore",
  }).status === 0;
}

function readDevelopmentManifest(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, DEVELOPMENT_ADAPTER.manifestPath), "utf8"));
}

function receiptExists(candidateDirectory, filename) {
  return fs.existsSync(path.join(path.resolve(candidateDirectory), filename));
}

function assertEmptyCandidateDirectory(candidateDirectory) {
  const resolved = path.resolve(candidateDirectory);
  if (!fs.existsSync(resolved)) return;
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("artifact directory must be regular");
  }
  if (fs.readdirSync(resolved).length !== 0) {
    throw new Error("source verification requires a new empty artifact directory when no source receipt exists");
  }
}

function validateRequest(request, repo) {
  if (request.adapter !== READINESS_CONTRACT.adapter) {
    throw new Error("release readiness supports only the development adapter");
  }
  if (typeof request.candidateDirectory !== "string" || request.candidateDirectory.length === 0) {
    throw new Error("missing required --candidate-dir");
  }
  if (request.targetVersion !== undefined) {
    throw new Error("development readiness does not accept --target-version; commit the package version in the manifest");
  }
  if (typeof request.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(request.sourceCommit)) {
    throw new Error("--source-commit must be an explicit 40-character commit SHA");
  }
  if (!commitExists(repo, request.sourceCommit)) {
    throw new Error("source commit does not name an existing immutable commit");
  }
  if (
    request.metadataCommit !== undefined
    && (typeof request.metadataCommit !== "string" || !/^[0-9a-f]{40}$/.test(request.metadataCommit))
  ) {
    throw new Error("--metadata-commit must be an explicit 40-character commit SHA");
  }
  if (request.metadataCommit !== undefined && !commitExists(repo, request.metadataCommit)) {
    throw new Error("metadata commit does not name an existing immutable commit");
  }
}

function redact(value, request, repo) {
  let diagnostic = String(value ?? "");
  for (const privatePath of [repo, request?.candidateDirectory, os.homedir()].filter(Boolean)) {
    diagnostic = diagnostic.replaceAll(String(privatePath), privatePath === repo ? "<repository>" : "<private>");
  }
  return diagnostic
    .replace(/(?:NPM_TOKEN|NODE_AUTH_TOKEN)=\S+/g, "$1=<redacted>")
    .slice(0, RELEASE_CONTRACT.bounds.diagnosticCharacters);
}

function initialExecution() {
  return {
    sourceQualificationInvocations: 0,
    sourceGateExecutions: 0,
    candidateQualificationInvocations: 0,
    candidateConstructionExecutions: 0,
  };
}

function result(request, values = {}) {
  const execution = values.execution ?? initialExecution();
  const source = values.source ?? {
    receipt: SOURCE_RECEIPT,
    status: "not_checked",
    executed: "none",
    reused: false,
  };
  const candidate = values.candidate ?? {
    receipt: CANDIDATE_RECEIPT,
    status: "blocked",
    executed: "none",
    reused: false,
  };
  const executed = execution.sourceQualificationInvocations > 0
    ? "source-qualification"
    : execution.candidateQualificationInvocations > 0
      ? "candidate-qualification"
      : "none";
  const reused = source.reused === true
    && (candidate.status.startsWith("blocked") || candidate.reused === true);
  return {
    schemaVersion: READINESS_CONTRACT.schemaVersion,
    package: READINESS_CONTRACT.adapter,
    version: request?.version ?? null,
    expectedTag: DEVELOPMENT_ADAPTER.expectedTag,
    adapter: READINESS_CONTRACT.adapter,
    outcome: values.outcome ?? "rejected",
    state: values.state ?? "rejected",
    phase: values.phase ?? "preflight",
    sourceCommit: request?.sourceCommit ?? null,
    metadataCommit: request?.metadataCommit ?? null,
    executed,
    reused,
    source,
    candidate,
    execution,
    prohibitedEffects: {
      metadataChanged: false,
      commitCreated: false,
      approvalCreated: false,
      candidateRebuilt: false,
      registryMutated: false,
    },
    elapsedMs: Math.max(0, Math.round(values.elapsedMs ?? 0)),
    nextAction: values.nextAction ?? "Correct the reported failure and retry with explicit inputs.",
    ...(values.detail ? { detail: values.detail } : {}),
  };
}

function metadataPause(request, source, execution, elapsedMs) {
  return result(request, {
    outcome: "paused",
    state: "awaiting_metadata_review",
    phase: READINESS_CONTRACT.phases[1],
    source,
    candidate: {
      receipt: CANDIDATE_RECEIPT,
      status: "blocked_by_metadata_review",
      executed: "none",
      reused: false,
    },
    execution,
    elapsedMs,
    nextAction: "Review the committed manifest metadata, then rerun with the same source commit and --metadata-commit COMMIT.",
  });
}

export function formatReadinessResult(value) {
  return `development readiness ${value.outcome}; state:${value.state}; phase:${value.phase}; source:${value.source.status}; package:${value.candidate.status}; next:${value.nextAction}`;
}

export async function coordinateDevelopmentReadiness(request, options = {}) {
  const repo = options.repo ?? REPO_ROOT;
  const started = (options.clock ?? (() => performance.now()))();
  const clock = options.clock ?? (() => performance.now());
  const execution = initialExecution();
  let phase = "preflight";
  let source = {
    receipt: SOURCE_RECEIPT,
    status: "not_checked",
    executed: "none",
    reused: false,
  };
  let candidate = {
    receipt: CANDIDATE_RECEIPT,
    status: "blocked",
    executed: "none",
    reused: false,
  };

  try {
    validateRequest(request, repo);
    const manifest = readDevelopmentManifest(repo);
    if (!/^\d+\.\d+\.\d+-dev\.(?:0|[1-9]\d*)$/.test(manifest.version)) {
      throw new Error("development manifest version must match X.Y.Z-dev.N");
    }
    request = { ...request, version: manifest.version };
    const sourcePresent = receiptExists(request.candidateDirectory, SOURCE_RECEIPT);
    const candidatePresent = receiptExists(request.candidateDirectory, CANDIDATE_RECEIPT);

    phase = READINESS_CONTRACT.phases[0];
    if (!sourcePresent) {
      if (request.metadataCommit !== undefined) {
        throw new Error("metadata resume requires the existing source receipt from the prior readiness pause");
      }
      if (candidatePresent) {
        throw new Error("package evidence cannot exist before the source receipt");
      }
      if (git(repo, ["rev-parse", "HEAD"]) !== request.sourceCommit) {
        throw new Error("fresh source readiness requires HEAD to equal the explicit source commit");
      }
      assertEmptyCandidateDirectory(request.candidateDirectory);
      execution.sourceQualificationInvocations = 1;
      const issued = await (options.issueSource ?? issueSourceReceipt)({
        repo,
        candidateDirectory: request.candidateDirectory,
        environment: options.environment,
        ...(options.sourceOptions ?? {}),
      });
      execution.sourceQualificationInvocations = issued.reused ? 0 : 1;
      execution.sourceGateExecutions = issued.reused ? 0 : issued.gates.length;
      source = {
        receipt: SOURCE_RECEIPT,
        status: issued.reused ? "reused" : "created",
        executed: issued.reused ? "none" : "ordered-gates",
        reused: issued.reused,
      };
      return metadataPause(request, source, execution, clock() - started);
    }

    (options.checkSource ?? checkSourceReceipt)({
      repo,
      candidateDirectory: request.candidateDirectory,
      ...(options.sourceCheckOptions ?? {}),
    });
    source = {
      receipt: SOURCE_RECEIPT,
      status: "reused",
      executed: "none",
      reused: true,
    };

    phase = READINESS_CONTRACT.phases[1];
    if (request.metadataCommit === undefined) {
      if (candidatePresent) {
        throw new Error("package evidence requires an explicit reviewed metadata commit");
      }
      return metadataPause(
        request,
        source,
        execution,
        clock() - started,
      );
    }

    if (git(repo, ["rev-parse", "HEAD"]) !== request.metadataCommit) {
      throw new Error("--metadata-commit must equal the current reviewed HEAD");
    }
    if (git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
      throw new Error("metadata review resume requires a clean committed tree");
    }

    phase = READINESS_CONTRACT.phases[2];
    if (candidatePresent) {
      (options.validateCandidate ?? validateCandidateReceipt)({
        repo,
        candidateDirectory: request.candidateDirectory,
        adapterName: READINESS_CONTRACT.adapter,
        ...(options.candidateValidationOptions ?? {}),
      });
      candidate = {
        receipt: CANDIDATE_RECEIPT,
        status: "reused",
        executed: "none",
        reused: true,
      };
    } else {
      execution.candidateQualificationInvocations = 1;
      const issued = (options.issueCandidate ?? issueCandidateReceipt)({
        repo,
        candidateDirectory: request.candidateDirectory,
        adapterName: READINESS_CONTRACT.adapter,
        sourceCommit: request.sourceCommit,
        environment: options.environment,
        ...(options.candidateOptions ?? {}),
      });
      execution.candidateQualificationInvocations = issued.reused ? 0 : 1;
      execution.candidateConstructionExecutions = issued.reused ? 0 : 1;
      candidate = {
        receipt: CANDIDATE_RECEIPT,
        status: issued.reused ? "reused" : "created",
        executed: issued.reused ? "none" : "ordered-gates",
        reused: issued.reused,
      };
    }

    return result(request, {
      outcome: "ready",
      state: "ready_for_approval",
      phase,
      source,
      candidate,
      execution,
      elapsedMs: clock() - started,
      nextAction: "Review the retained package artifact, then run the separate explicit approval command when authorized.",
    });
  } catch (error) {
    const detail = redact(error instanceof Error ? error.message : error, request, repo);
    if (phase === READINESS_CONTRACT.phases[0]) {
      source = { ...source, status: "rejected", reused: false };
    } else if (phase === READINESS_CONTRACT.phases[2]) {
      candidate = { ...candidate, status: "rejected", reused: false };
    }
    return result(request, {
      outcome: "rejected",
      state: "rejected",
      phase,
      source,
      candidate,
      execution,
      elapsedMs: clock() - started,
      detail,
      nextAction: "Correct the reported mismatch and retry without replacing or rebuilding valid evidence.",
    });
  }
}

function emitReadinessResult(value, json) {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${formatReadinessResult(value)}\n`);
}

function helpText() {
  return `${USAGE}\n\nRuns source readiness once, pauses for separate metadata review and commit, then validates or builds one package on explicit resume.\nThe command never prepares metadata, commits, approves, publishes, or mutates registry state.\nExit codes: 0 paused or ready; 1 rejected or invalid usage.\n`;
}

async function main() {
  const [adapter, ...rest] = process.argv.slice(2);
  if (adapter === "--help" || rest.includes("--help")) {
    process.stdout.write(helpText());
    return;
  }
  if (adapter !== READINESS_CONTRACT.adapter) throw new Error(USAGE);
  const flags = parseReleaseFlags(rest, {
    boolean: ["--json"],
    value: ["--candidate-dir", "--source-commit", "--metadata-commit"],
  });
  const value = await coordinateDevelopmentReadiness({
    adapter,
    candidateDirectory: flags.get("--candidate-dir"),
    sourceCommit: flags.get("--source-commit"),
    metadataCommit: flags.get("--metadata-commit"),
  });
  emitReadinessResult(value, Boolean(flags.get("--json")));
  if (value.outcome === "rejected") {
    process.stderr.write(`release-readiness: ${value.detail}\n`);
    process.exitCode = READINESS_CONTRACT.exitCodes.rejected;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const json = process.argv.includes("--json");
    const value = result({}, {
      outcome: "rejected",
      state: "rejected",
      phase: "usage",
      detail: redact(error instanceof Error ? error.message : error, {}, REPO_ROOT),
      nextAction: USAGE,
    });
    emitReadinessResult(value, json);
    process.stderr.write(`release-readiness: ${value.detail}\n`);
    process.exitCode = READINESS_CONTRACT.exitCodes.rejected;
  });
}
