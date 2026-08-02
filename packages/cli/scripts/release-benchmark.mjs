#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPO_ROOT,
  RELEASE_CONTRACT,
  issueCandidateReceipt,
  issueSourceReceipt,
  qualificationPreflight,
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
    const ownerElapsedMs = owners.reduce((total, owner) => total + owner.elapsedMs, 0);
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
  let qualifiedPublication = {
    budgetMs: RELEASE_CONTRACT.benchmark.timeouts.qualifiedPublicationMs,
    executed: "not-run",
    reason: "qualification benchmark never invokes npm mutation; record approved publication timing separately",
  };
  if (options.qualifiedPublication) {
    try {
      const published = options.qualifiedPublication;
      const owners = normalizeOwners(published.owners);
      const ownerElapsedMs = owners.reduce((total, owner) => total + owner.elapsedMs, 0);
      if (!Number.isFinite(published.elapsedMs) || published.elapsedMs < ownerElapsedMs) {
        throw benchmarkError("qualified publication timing cannot reconcile its owner durations", "qualified-publication");
      }
      if (published.elapsedMs >= RELEASE_CONTRACT.benchmark.timeouts.qualifiedPublicationMs) {
        throw benchmarkError(
          `qualified publication exceeded its ${RELEASE_CONTRACT.benchmark.timeouts.qualifiedPublicationMs}ms budget`,
          "qualified-publication",
        );
      }
      qualifiedPublication = {
        elapsedMs: Math.round(published.elapsedMs),
        budgetMs: RELEASE_CONTRACT.benchmark.timeouts.qualifiedPublicationMs,
        executed: published.executed ?? "recorded",
        reused: Boolean(published.reused),
        owners,
        ownerElapsedMs,
        unattributedElapsedMs: Math.round(published.elapsedMs) - ownerElapsedMs,
        reconciled: true,
      };
    } catch (error) {
      const firstFailure = {
        owner: error?.owner ?? "qualified-publication",
        phase: "qualified-publication",
        detail: error instanceof Error ? error.message : String(error),
      };
      emit({ event: "failed", repetition: null, firstFailure });
      if (error && typeof error === "object") error.firstFailure ??= firstFailure;
      throw error;
    }
  }
  return {
    schemaVersion: "agentera.releaseBenchmark.v1",
    kind: "qualification-benchmark",
    repetitions: runs,
    medianElapsedMs: {
      preflight: median(runs.map((run) => run.preflight.elapsedMs)),
      fullQualification: median(runs.map((run) => run.qualification.elapsedMs)),
    },
    qualifiedPublication,
  };
}

function parseFlags(values) {
  const flags = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === "--json") {
      flags.set(flag, true);
      continue;
    }
    const value = values[index + 1];
    if (!flag.startsWith("--") || !value || value.startsWith("--")) throw new Error(`invalid argument '${flag}'`);
    flags.set(flag, value);
    index += 1;
  }
  return flags;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "qualification") {
    throw new Error("usage: release-benchmark.mjs qualification --adapter development|stable --candidate-root DIR [--json]");
  }
  const flags = parseFlags(args);
  const adapterName = flags.get("--adapter");
  const candidateRoot = flags.get("--candidate-root");
  if (!RELEASE_CONTRACT.packages[adapterName]) throw new Error("--adapter must be development or stable");
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
    runSource: ({ repetition }) => {
      const issued = issueSourceReceipt({ candidateDirectory: candidateDirectory(repetition) });
      return { owners: receiptOwners(issued.receipt, issued.reused), reused: issued.reused, executed: issued.reused ? "none" : "ordered" };
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
