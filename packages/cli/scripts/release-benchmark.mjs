#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { npmChildEnvironment } from "./package-construction.mjs";
import { parseReleaseFlags } from "./release-arguments.mjs";
import {
  REPO_ROOT,
  RELEASE_CONTRACT,
  canonicalJson,
  isolatedNpmState,
  issueCandidateReceipt,
  issueSourceReceipt,
  qualificationPreflight,
  sha256,
  validateCandidateReceipt,
} from "./release-qualification.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const QUALIFICATION_BUDGET_MS = RELEASE_CONTRACT.benchmark.timeouts.sourceQualificationMs;
let failureWasEmitted = false;

function benchmarkError(message, owner) {
  const error = new Error(message);
  error.owner = owner;
  return error;
}

function elapsedMs(value, started, clock) {
  const measured = Math.max(0, Math.round(clock() - started));
  if (value === undefined) return measured;
  if (!Number.isFinite(value) || value < 0) throw benchmarkError("benchmark phase returned an invalid elapsedMs", "benchmark");
  return Math.round(value);
}

function normalizeOwners(owners) {
  if (!Array.isArray(owners)) return [];
  return owners.map((owner) => {
    if (typeof owner?.name !== "string" || owner.name.length === 0) {
      throw benchmarkError("benchmark owner is missing a name", "benchmark");
    }
    if (!Number.isFinite(owner.elapsedMs) || owner.elapsedMs < 0) {
      throw benchmarkError(`benchmark owner '${owner.name}' has an invalid elapsedMs`, owner.name);
    }
    return {
      name: owner.name,
      ...(typeof owner.phase === "string" ? { phase: owner.phase } : {}),
      elapsedMs: Math.round(owner.elapsedMs),
      executed: owner.executed ?? "ordered",
      reused: Boolean(owner.reused),
    };
  });
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

async function runPhase(name, budgetMs, invoke, context) {
  const started = context.clock();
  context.emit({ event: "started", repetition: context.repetition, phase: name });
  try {
    const result = (await invoke()) ?? {};
    const elapsed = elapsedMs(result.elapsedMs, started, context.clock);
    const owners = normalizeOwners(result.owners);
    const ownerDurationTotalMs = owners.reduce((total, owner) => total + owner.elapsedMs, 0);
    const ownerElapsedMs = result.ownerElapsedMs ?? ownerDurationTotalMs;
    if (!Number.isFinite(ownerElapsedMs) || ownerElapsedMs < 0) {
      throw benchmarkError(`benchmark phase '${name}' returned invalid reconciled owner time`, name);
    }
    if (ownerElapsedMs > elapsed) {
      throw benchmarkError(`benchmark phase '${name}' owner durations exceed its phase duration`, name);
    }
    if (elapsed >= budgetMs) {
      throw benchmarkError(`benchmark phase '${name}' exceeded its ${budgetMs}ms budget`, name);
    }
    const phase = {
      name,
      elapsedMs: elapsed,
      budgetMs,
      executed: result.executed ?? "ordered",
      reused: Boolean(result.reused),
      owners,
      ownerDurationTotalMs,
      ownerElapsedMs,
      unattributedElapsedMs: elapsed - ownerElapsedMs,
      reconciled: ownerElapsedMs + (elapsed - ownerElapsedMs) === elapsed,
    };
    context.emit({ event: "passed", repetition: context.repetition, phase });
    return phase;
  } catch (error) {
    const owner = error?.owner ?? name;
    const firstFailure = {
      owner,
      phase: name,
      detail: error instanceof Error ? error.message : String(error),
    };
    // This event is deliberately emitted before control leaves the failed owner.
    context.emit({ event: "failed", repetition: context.repetition, firstFailure });
    if (error && typeof error === "object") error.firstFailure ??= firstFailure;
    throw error;
  }
}

function receiptOwners(receipt, reused) {
  return (receipt.gates ?? []).map((gate) => ({
    name: gate.name,
    phase: gate.phase,
    elapsedMs: gate.elapsedMs ?? 0,
    executed: reused ? "none" : gate.executed ?? "ordered",
    reused,
  }));
}

/**
 * Run exactly three non-mutating cold-cache qualification repetitions.
 * Callers supply phase functions so focused tests can use deterministic timings.
 */
export async function runQualificationBenchmark(options = {}) {
  const repetitions = options.repetitions ?? RELEASE_CONTRACT.benchmark.repetitions;
  if (repetitions !== 3) throw new Error("qualification benchmark requires exactly three cold-cache repetitions");
  for (const name of ["preflight", "source", "candidate"]) {
    if (typeof options[`run${name[0].toUpperCase()}${name.slice(1)}`] !== "function") {
      throw new Error(`qualification benchmark requires run${name[0].toUpperCase()}${name.slice(1)}`);
    }
  }
  const clock = options.clock ?? (() => performance.now());
  const emit = options.emit ?? (() => {});
  const runs = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const context = { repetition, clock, emit };
    const preflight = await runPhase(
      "preflight",
      RELEASE_CONTRACT.benchmark.timeouts.preflightMs,
      () => options.runPreflight({ repetition }),
      context,
    );
    const source = await runPhase(
      "source-qualification",
      QUALIFICATION_BUDGET_MS,
      () => options.runSource({ repetition }),
      context,
    );
    const candidate = await runPhase(
      "candidate-qualification",
      QUALIFICATION_BUDGET_MS,
      () => options.runCandidate({ repetition }),
      context,
    );
    const qualificationElapsedMs = source.elapsedMs + candidate.elapsedMs;
    if (qualificationElapsedMs >= QUALIFICATION_BUDGET_MS) {
      const error = benchmarkError(
        `benchmark phase 'full-qualification' exceeded its ${QUALIFICATION_BUDGET_MS}ms budget`,
        "full-qualification",
      );
      const firstFailure = { owner: error.owner, phase: "full-qualification", detail: error.message };
      emit({ event: "failed", repetition, firstFailure });
      error.firstFailure = firstFailure;
      throw error;
    }
    runs.push({
      repetition,
      coldCache: true,
      preflight,
      source,
      candidate,
      qualification: {
        name: "full-qualification",
        elapsedMs: qualificationElapsedMs,
        budgetMs: QUALIFICATION_BUDGET_MS,
        executed: source.reused && candidate.reused ? "none" : "ordered",
        reused: source.reused && candidate.reused,
        ownerElapsedMs: source.elapsedMs + candidate.elapsedMs,
        unattributedElapsedMs: 0,
        reconciled: true,
      },
    });
  }
  return {
    schemaVersion: "agentera.releaseBenchmark.v1",
    kind: "qualification-benchmark",
    repetitions: runs,
    medianElapsedMs: {
      preflight: median(runs.map((run) => run.preflight.elapsedMs)),
      fullQualification: median(runs.map((run) => run.qualification.elapsedMs)),
    },
  };
}

function redactPublicationDiagnostic(value, candidateDirectory) {
  let text = String(value ?? "");
  for (const privatePath of [REPO_ROOT, candidateDirectory, os.homedir()].filter(Boolean)) {
    text = text.replaceAll(privatePath, privatePath === REPO_ROOT ? "<repository>" : "<private>");
  }
  return text
    .replace(/(?:NPM_TOKEN|NODE_AUTH_TOKEN)=\S+/g, "$1=<redacted>")
    .slice(0, RELEASE_CONTRACT.bounds.diagnosticCharacters);
}

function parseTransactionResults(stdout) {
  return String(stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return value && typeof value === "object" ? [value] : [];
      } catch {
        return [];
      }
    });
}

function defaultCommandRunner(specification) {
  const invocation = spawnSync(specification.command, specification.args, {
    cwd: specification.cwd,
    env: specification.env,
    encoding: "utf8",
    timeout: Math.max(1, Math.floor(specification.timeoutMs)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const results = parseTransactionResults(invocation.stdout);
  if (invocation.error || invocation.status !== 0) {
    const failed = results.find((entry) => entry.outcome === "failed");
    const detail = failed?.detail
      ?? invocation.error?.message
      ?? invocation.stderr
      ?? invocation.stdout
      ?? `exit ${invocation.status ?? "signal"}`;
    const error = new Error(String(detail).trim());
    error.owner = failed?.phase ?? specification.name;
    throw error;
  }
  return { stdout: invocation.stdout, stderr: invocation.stderr };
}

function transactionArguments(phase, adapterName, candidateDirectory, sourceRunId) {
  return [
    path.join(REPO_ROOT, "packages/cli/scripts/publication-transaction.mjs"),
    phase,
    adapterName,
    "--approve",
    "--candidate-dir",
    candidateDirectory,
    ...(sourceRunId ? ["--source-run-id", sourceRunId] : []),
    "--json",
  ];
}

function publicationPhases(
  adapterName,
  candidateDirectory,
  candidate,
  sourceRunId,
  environment,
  l2Environment,
) {
  const transaction = (name, phase) => ({
    name,
    transactionPhase: phase,
    command: process.execPath,
    args: transactionArguments(phase, adapterName, candidateDirectory, sourceRunId),
    cwd: REPO_ROOT,
    env: environment,
  });
  const exactVersionL2 = adapterName === "development"
    ? {
        name: "exact-version-l2",
        command: "bash",
        args: [path.join(REPO_ROOT, "scripts/sandbox/v2v3-upgrade-harness.sh"), "happy-path-clean"],
        cwd: REPO_ROOT,
        env: {
          ...l2Environment,
          REPO_ROOT,
          AGENTERA_SANDBOX_TIER: "L2",
          AGENTERA_NPM_PIN: `${candidate.package}@${candidate.version}`,
        },
      }
    : {
        ...transaction("exact-version-l2", "smoke"),
        name: "exact-version-l2",
        env: npmChildEnvironment(environment),
      };
  return [
    transaction("stage", "stage"),
    exactVersionL2,
    transaction("promote", "promote"),
  ];
}

function successfulTransaction(specification, output) {
  if (!specification.transactionPhase) {
    return { reused: false, observations: [] };
  }
  const results = parseTransactionResults(output.stdout);
  const completed = [...results].reverse().find(
    (entry) => entry.phase === specification.transactionPhase && entry.outcome === "passed",
  );
  if (!completed) {
    throw benchmarkError(
      `qualified publication owner '${specification.name}' returned no successful transaction result`,
      specification.name,
    );
  }
  return {
    reused: Boolean(completed.reused),
    observations: results
      .filter((entry) => typeof entry.phase === "string" && typeof entry.outcome === "string")
      .map((entry) => ({ phase: entry.phase, outcome: entry.outcome, reused: Boolean(entry.reused) })),
  };
}

function publicationReceipt(candidate, sourceRunId, phases, started, ended, outcome, firstFailure) {
  const elapsedMs = Math.max(0, Math.floor(ended - started));
  const ownerElapsedMs = phases.reduce((total, phase) => total + phase.elapsedMs, 0);
  if (ownerElapsedMs > elapsedMs) {
    throw benchmarkError("qualified publication component timings exceed total elapsed time", "qualified-publication");
  }
  const receipt = {
    schemaVersion: "agentera.qualifiedPublicationTiming.v1",
    kind: "qualified-publication-timing",
    outcome,
    candidate: {
      receiptSha256: candidate.receiptSha256,
      metadataCommit: candidate.metadataCommit,
      package: candidate.package,
      version: candidate.version,
      integrity: candidate.artifact.integrity,
      artifactSha256: candidate.artifact.sha256,
      sourceRunId: sourceRunId ?? null,
    },
    budgetMs: RELEASE_CONTRACT.benchmark.timeouts.qualifiedPublicationMs,
    elapsedMs,
    withinBudget: elapsedMs < RELEASE_CONTRACT.benchmark.timeouts.qualifiedPublicationMs,
    executed: "ordered",
    reused: phases.length === 3
      && phases.filter((phase) => phase.name !== "exact-version-l2").every((phase) => phase.reused),
    phases,
    ownerElapsedMs,
    unattributedElapsedMs: elapsedMs - ownerElapsedMs,
    reconciled: ownerElapsedMs + (elapsedMs - ownerElapsedMs) === elapsedMs,
    noRollback: true,
    ...(firstFailure ? { firstFailure } : {}),
  };
  receipt.receiptSha256 = sha256(canonicalJson(receipt));
  return receipt;
}

function assertPublicationCandidate(candidate) {
  if (
    typeof candidate?.receiptSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(candidate.receiptSha256)
    || typeof candidate?.metadataCommit !== "string"
    || !/^[0-9a-f]{40}$/.test(candidate.metadataCommit)
    || typeof candidate?.package !== "string"
    || typeof candidate?.version !== "string"
    || typeof candidate?.artifact?.integrity !== "string"
    || typeof candidate?.artifact?.sha256 !== "string"
  ) {
    throw new Error("qualified publication requires a valid content-bound candidate receipt");
  }
  return candidate;
}

/** Run one approved, content-bound stage/L2/promote publication envelope. */
export async function runQualifiedPublication(options = {}) {
  const adapterName = options.adapterName;
  if (!RELEASE_CONTRACT.packages[adapterName]) {
    throw new Error("qualified publication requires adapterName development or stable");
  }
  if (!options.candidateDirectory) throw new Error("qualified publication requires candidateDirectory");
  if (options.sourceRunId !== undefined && !/^[1-9]\d{0,19}$/.test(options.sourceRunId)) {
    throw new Error("qualified publication sourceRunId must be a positive GitHub Actions run ID");
  }
  const loaded = options.candidate
    ?? validateCandidateReceipt({ candidateDirectory: options.candidateDirectory, adapterName });
  const candidate = assertPublicationCandidate(loaded.receipt ?? loaded);
  const clock = options.clock ?? (() => performance.now());
  const commandRunner = options.runCommand ?? defaultCommandRunner;
  const emit = options.emit ?? (() => {});
  const environment = options.environment ?? process.env;
  const l2State = adapterName === "development"
    ? isolatedNpmState("agentera-qualified-l2-", {
        environment,
        ignoreScripts: false,
        registryInGlobalConfig: true,
      })
    : null;
  const specifications = publicationPhases(
    adapterName,
    options.candidateDirectory,
    candidate,
    options.sourceRunId,
    environment,
    l2State?.environment,
  );
  const budgetMs = RELEASE_CONTRACT.benchmark.timeouts.qualifiedPublicationMs;
  const phases = [];
  let lastClock = clock();
  const started = lastClock;
  const now = () => {
    const value = clock();
    if (!Number.isFinite(value) || value < lastClock) {
      throw benchmarkError("qualified publication requires a monotonic clock", "qualified-publication");
    }
    lastClock = value;
    return value;
  };
  emit({ event: "started", phase: "qualified-publication", candidateReceiptSha256: candidate.receiptSha256 });
  try {
    for (const specification of specifications) {
      const phaseStarted = now();
      const remainingMs = budgetMs - (phaseStarted - started);
      if (remainingMs <= 0) {
        throw benchmarkError(`qualified publication exceeded its ${budgetMs}ms budget before ${specification.name}`, specification.name);
      }
      emit({ event: "started", phase: specification.name });
      try {
        const output = await commandRunner({ ...specification, timeoutMs: remainingMs });
        const phaseEnded = now();
        const transaction = successfulTransaction(specification, output ?? {});
        const phase = {
          name: specification.name,
          outcome: "passed",
          elapsedMs: Math.max(0, Math.floor(phaseEnded - phaseStarted)),
          executed: "command",
          reused: transaction.reused,
          observations: transaction.observations,
        };
        if (phaseEnded - started >= budgetMs) {
          phase.outcome = "failed";
          phases.push(phase);
          throw benchmarkError(
            `qualified publication exceeded its ${budgetMs}ms budget during ${specification.name}`,
            specification.name,
          );
        }
        phases.push(phase);
        emit({ event: "passed", phase });
      } catch (error) {
        if (!phases.some((phase) => phase.name === specification.name)) {
          const phaseEnded = now();
          phases.push({
            name: specification.name,
            outcome: "failed",
            elapsedMs: Math.max(0, Math.floor(phaseEnded - phaseStarted)),
            executed: "command",
            reused: false,
            observations: [],
          });
        }
        if (error && typeof error === "object") error.owner ??= specification.name;
        throw error;
      }
    }
    const ended = now();
    if (ended - started >= budgetMs) {
      throw benchmarkError(
        `qualified publication exceeded its ${budgetMs}ms budget during final reconciliation`,
        "qualified-publication",
      );
    }
    const receipt = publicationReceipt(candidate, options.sourceRunId, phases, started, ended, "passed");
    emit({ event: "passed", phase: "qualified-publication", receipt });
    return receipt;
  } catch (error) {
    const ended = now();
    const firstFailure = {
      owner: error?.owner ?? "qualified-publication",
      phase: "qualified-publication",
      detail: redactPublicationDiagnostic(
        error instanceof Error ? error.message : String(error),
        options.candidateDirectory,
      ),
    };
    const receipt = publicationReceipt(candidate, options.sourceRunId, phases, started, ended, "failed", firstFailure);
    emit({ event: "failed", phase: "qualified-publication", firstFailure, receipt });
    if (error && typeof error === "object") {
      error.firstFailure ??= firstFailure;
      error.publicationReceipt = receipt;
    }
    throw error;
  } finally {
    if (l2State) fs.rmSync(l2State.root, { recursive: true, force: true });
  }
}

function writePublicationReceipt(file, receipt) {
  fs.writeFileSync(path.resolve(file), canonicalJson(receipt), {
    encoding: "utf8",
    mode: 0o400,
    flag: "wx",
  });
}

export function formatPublicationReceipt(receipt) {
  const phases = receipt.phases.map((phase) => `${phase.name} ${phase.elapsedMs}ms${phase.reused ? " replayed" : ""}`).join("; ");
  const bound = receipt.withinBudget ? "<" : ">=";
  const failure = receipt.firstFailure
    ? `; first failure ${receipt.firstFailure.owner}: ${receipt.firstFailure.detail}`
    : "";
  return `qualified publication ${receipt.outcome}; ${phases}; total ${receipt.elapsedMs}ms ${bound} ${receipt.budgetMs}ms; reconciled ${receipt.reconciled}${failure}; receipt ${receipt.receiptSha256}`;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!["qualification", "publication"].includes(command)) {
    throw new Error(
      "usage: release-benchmark.mjs <qualification --candidate-root DIR|publication --candidate-dir DIR> --adapter development|stable [--json]",
    );
  }
  const flags = parseReleaseFlags(args, {
    boolean: ["--json"],
    value: command === "qualification"
      ? ["--adapter", "--candidate-root"]
      : ["--adapter", "--candidate-dir", "--source-run-id", "--receipt-file"],
  });
  const adapterName = flags.get("--adapter");
  if (!RELEASE_CONTRACT.packages[adapterName]) throw new Error("--adapter must be development or stable");
  if (command === "publication") {
    const candidateDirectory = flags.get("--candidate-dir");
    if (!candidateDirectory) throw new Error("publication requires --candidate-dir");
    try {
      const report = await runQualifiedPublication({
        adapterName,
        candidateDirectory,
        sourceRunId: flags.get("--source-run-id"),
      });
      if (flags.get("--receipt-file")) writePublicationReceipt(flags.get("--receipt-file"), report);
      process.stdout.write(`${flags.get("--json") ? JSON.stringify(report) : formatPublicationReceipt(report)}\n`);
      return;
    } catch (error) {
      if (error?.publicationReceipt) {
        if (flags.get("--receipt-file")) {
          try {
            writePublicationReceipt(flags.get("--receipt-file"), error.publicationReceipt);
          } catch {}
        }
        process.stdout.write(`${flags.get("--json") ? JSON.stringify(error.publicationReceipt) : formatPublicationReceipt(error.publicationReceipt)}\n`);
      }
      if (error && typeof error === "object" && !error.firstFailure) {
        let detail = redactPublicationDiagnostic(
          error instanceof Error ? error.message : String(error),
          candidateDirectory,
        );
        if (flags.get("--receipt-file")) {
          detail = detail.replaceAll(path.resolve(flags.get("--receipt-file")), "<private>");
        }
        error.firstFailure = {
          owner: error.owner ?? "publication-preflight",
          phase: "qualified-publication",
          detail,
        };
      }
      throw error;
    }
  }
  const candidateRoot = flags.get("--candidate-root");
  if (!candidateRoot) throw new Error("--candidate-root is required");
  const root = path.resolve(candidateRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error("--candidate-root must be an existing external directory");
  const candidateDirectory = (repetition) => path.join(root, `qualification-${repetition}`);
  const report = await runQualificationBenchmark({
    emit: (event) => {
      if (event.event === "failed") {
        failureWasEmitted = true;
        process.stderr.write(`release-benchmark: first failing owner ${event.firstFailure.owner}: ${event.firstFailure.detail}\n`);
      }
    },
    runPreflight: ({ repetition }) => {
      qualificationPreflight({ repo: REPO_ROOT, adapterName, candidateDirectory: candidateDirectory(repetition) });
      return { owners: [{ name: "preflight", elapsedMs: 0, executed: "ordered", reused: false }] };
    },
    runSource: async ({ repetition }) => {
      const issued = await issueSourceReceipt({ candidateDirectory: candidateDirectory(repetition) });
      return {
        ownerElapsedMs: issued.receipt.execution?.elapsedMs,
        owners: receiptOwners(issued.receipt, issued.reused),
        reused: issued.reused,
        executed: issued.reused ? "none" : "parallel DAG",
      };
    },
    runCandidate: ({ repetition }) => {
      const issued = issueCandidateReceipt({ candidateDirectory: candidateDirectory(repetition), adapterName });
      return { owners: receiptOwners(issued.receipt, issued.reused), reused: issued.reused, executed: issued.reused ? "none" : "ordered" };
    },
  });
  process.stdout.write(`${flags.get("--json") ? JSON.stringify(report) : `qualification median ${report.medianElapsedMs.fullQualification}ms; preflight median ${report.medianElapsedMs.preflight}ms`}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    const firstFailure = error?.firstFailure;
    if (firstFailure) {
      if (!failureWasEmitted) {
        process.stderr.write(`release-benchmark: first failing owner ${firstFailure.owner}: ${firstFailure.detail}\n`);
      }
    } else {
      process.stderr.write(`release-benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  });
}
