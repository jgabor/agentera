import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sourceSubprocessEnv } from "./sourceSubprocess.js";

const publicationWorker = fileURLToPath(new URL("../state/entityPublicationWorker.mjs", import.meta.url));
const OUTPUT_LIMIT = 2_048;
const OBSERVATION_LIMIT = 1_000;
const WORKER_TIMEOUT_MS = 10_000;

export interface PublicationResult {
  published: boolean;
  error?: string;
}

interface WorkerControls {
  ownerOpenedPath?: string;
  continuePath?: string;
  waitingPath?: string;
  reclaimReadyPath?: string;
  reclaimContinuePath?: string;
  preparationReadyPath?: string;
  preparationContinuePath?: string;
  fault?: "nonzero" | "malformed" | "timeout";
}

interface WorkerOutcome {
  artifact: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

interface WorkerHandle {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<WorkerOutcome>;
  outcome?: WorkerOutcome;
}

interface RaceOptions {
  repetition?: number;
  reclaimBarrier?: boolean;
  timeoutMs?: number;
  fault?: WorkerControls["fault"];
}

export interface PublicationRaceResult {
  results: PublicationResult[];
  reclaimOverlap: boolean;
}

function appendBounded(current: string, chunk: unknown): string {
  if (current.length >= OUTPUT_LIMIT) return current;
  return `${current}${String(chunk)}`.slice(0, OUTPUT_LIMIT);
}

function observation(value: unknown): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value, (_key, item) => (item instanceof Error ? { name: item.name, message: item.message } : item)) ?? String(value);
  } catch (error) {
    rendered = JSON.stringify({ serializationError: String(error), value: String(value) });
  }
  return rendered.slice(0, OBSERVATION_LIMIT);
}

export function assertRaceInvariant(repetition: number, invariant: string, condition: boolean, observed: unknown): asserts condition {
  if (!condition) {
    throw new Error(`stale-lock race repetition ${repetition} violated invariant '${invariant}': ${observation(observed)}`);
  }
}

function startWorker(root: string, artifact: string, boundary: string, resultPath: string, readyPath: string, startPath: string, controls: WorkerControls, timeoutMs: number): WorkerHandle {
  const child = spawn(process.execPath, [publicationWorker], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...sourceSubprocessEnv(),
      AGENTERA_ENTITY_TEST_ROOT: root,
      AGENTERA_ENTITY_TEST_ARTIFACT: artifact,
      AGENTERA_ENTITY_TEST_BOUNDARY: boundary,
      AGENTERA_ENTITY_TEST_RESULT: resultPath,
      AGENTERA_ENTITY_TEST_READY: readyPath,
      AGENTERA_ENTITY_TEST_START: startPath,
      AGENTERA_ENTITY_TEST_OWNER_OPENED: controls.ownerOpenedPath,
      AGENTERA_ENTITY_TEST_CONTINUE: controls.continuePath,
      AGENTERA_ENTITY_TEST_WAITING: controls.waitingPath,
      AGENTERA_ENTITY_TEST_RECLAIM_READY: controls.reclaimReadyPath,
      AGENTERA_ENTITY_TEST_RECLAIM_CONTINUE: controls.reclaimContinuePath,
      AGENTERA_ENTITY_TEST_PREPARATION_READY: controls.preparationReadyPath,
      AGENTERA_ENTITY_TEST_PREPARATION_CONTINUE: controls.preparationContinuePath,
      AGENTERA_ENTITY_TEST_FAULT: controls.fault,
    },
    stdio: "pipe",
  });
  const handle = {} as WorkerHandle;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let spawnError: string | undefined;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk);
  });
  handle.child = child;
  handle.completion = new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const outcome = { artifact, code, signal, timedOut, stdout, stderr, spawnError };
      handle.outcome = outcome;
      resolve(outcome);
    };
    child.on("error", (error) => {
      spawnError = error.message;
      child.kill("SIGKILL");
      finish(null, null);
    });
    child.on("close", finish);
  });
  return handle;
}

async function terminateWorkers(workers: WorkerHandle[]): Promise<void> {
  for (const worker of workers) {
    if (worker.outcome === undefined) {
      try {
        worker.child.kill("SIGKILL");
      } catch {
        // The worker's own bounded timeout remains responsible for settlement.
      }
    }
  }
  await Promise.all(workers.map(({ completion }) => completion));
}

async function waitForWorkerFiles(paths: string[], workers: WorkerHandle[], timeoutMs: number): Promise<{ ready: boolean; paths: string[]; outcomes: Array<WorkerOutcome | undefined> }> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((candidate) => fs.existsSync(candidate))) {
    if (workers.some(({ outcome }) => outcome !== undefined) || Date.now() >= deadline) {
      return { ready: false, paths, outcomes: workers.map(({ outcome }) => outcome) };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { ready: true, paths, outcomes: [] };
}

export async function waitForFiles(paths: string[], timeoutMs = WORKER_TIMEOUT_MS): Promise<void> {
  const result = await waitForWorkerFiles(paths, [], timeoutMs);
  if (!result.ready) throw new Error(`timed out waiting for publication barrier: ${observation(result)}`);
}

export async function publicationProcess(root: string, artifact: string, boundary: string, resultPath: string, readyPath: string, startPath: string, controls: WorkerControls = {}): Promise<void> {
  const worker = startWorker(root, artifact, boundary, resultPath, readyPath, startPath, controls, WORKER_TIMEOUT_MS);
  const outcome = await worker.completion;
  if (outcome.code !== 0) throw new Error(`publication worker failed: ${observation(outcome)}`);
}

function readResult(repetition: number, file: string): PublicationResult {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(text) as PublicationResult;
    assertRaceInvariant(repetition, "valid worker result", typeof parsed.published === "boolean", {
      path: file,
      parsed,
    });
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("stale-lock race repetition ")) throw error;
    assertRaceInvariant(repetition, "valid worker result", false, {
      path: file,
      error,
      preview: text.slice(0, 256),
    });
  }
}

export async function concurrentPublication(root: string, suffix = "", options: RaceOptions = {}): Promise<PublicationRaceResult> {
  const repetition = options.repetition ?? 1;
  const timeoutMs = options.timeoutMs ?? WORKER_TIMEOUT_MS;
  const healthResult = path.join(root, `health${suffix}-result.json`);
  const decisionsResult = path.join(root, `decisions${suffix}-result.json`);
  const healthReady = path.join(root, `health${suffix}.ready`);
  const decisionsReady = path.join(root, `decisions${suffix}.ready`);
  const startPath = path.join(root, `publication${suffix}.start`);
  const reclaimContinuePath = path.join(root, `publication${suffix}.reclaim`);
  const reclaimReady = ["health", "decisions"].map((artifact) => path.join(root, `${artifact}${suffix}.reclaim-ready`));
  const preparationContinuePath = path.join(root, `publication${suffix}.prepare`);
  const preparationReady = ["health", "decisions"].map((artifact) => path.join(root, `${artifact}${suffix}.prepare-ready`));
  const controls = (index: number): WorkerControls => ({
    reclaimReadyPath: options.reclaimBarrier ? reclaimReady[index] : undefined,
    reclaimContinuePath: options.reclaimBarrier ? reclaimContinuePath : undefined,
    preparationReadyPath: options.reclaimBarrier ? preparationReady[index] : undefined,
    preparationContinuePath: options.reclaimBarrier ? preparationContinuePath : undefined,
    fault: index === 0 ? options.fault : undefined,
  });
  const workers: WorkerHandle[] = [];
  let failed = true;
  try {
    try {
      workers.push(startWorker(root, "health", "health_audit", healthResult, healthReady, startPath, controls(0), timeoutMs), startWorker(root, "decisions", "decision", decisionsResult, decisionsReady, startPath, controls(1), options.fault ? WORKER_TIMEOUT_MS : timeoutMs));
    } catch (error) {
      assertRaceInvariant(repetition, "worker spawn", false, { error });
    }
    const readiness = await waitForWorkerFiles([healthReady, decisionsReady], workers, Math.max(timeoutMs, 2_000));
    assertRaceInvariant(repetition, "worker readiness", readiness.ready, readiness);
    try {
      fs.writeFileSync(startPath, "start\n");
    } catch (error) {
      assertRaceInvariant(repetition, "worker start release", false, { path: startPath, error });
    }
    if (options.reclaimBarrier) {
      const preparation = await waitForWorkerFiles(preparationReady, workers, timeoutMs);
      assertRaceInvariant(repetition, "both workers crossed recovery scan", preparation.ready, preparation);
      try {
        fs.writeFileSync(preparationContinuePath, "prepare\n");
      } catch (error) {
        assertRaceInvariant(repetition, "writer preparation release", false, {
          path: preparationContinuePath,
          error,
        });
      }
      const overlap = await waitForWorkerFiles(reclaimReady, workers, timeoutMs);
      assertRaceInvariant(repetition, "both workers reached stale reclamation", overlap.ready, overlap);
      try {
        fs.writeFileSync(reclaimContinuePath, "reclaim\n");
      } catch (error) {
        assertRaceInvariant(repetition, "stale reclamation release", false, {
          path: reclaimContinuePath,
          error,
        });
      }
    }
    const outcomes = await Promise.all(workers.map(({ completion }) => completion));
    const timedOut = outcomes.some((outcome) => outcome.timedOut);
    assertRaceInvariant(
      repetition,
      timedOut ? "worker timeout" : "worker completion",
      outcomes.every(({ code }) => code === 0),
      outcomes,
    );
    const results = [healthResult, decisionsResult].map((file) => readResult(repetition, file));
    failed = false;
    return { results, reclaimOverlap: options.reclaimBarrier === true };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("stale-lock race repetition ")) throw error;
    assertRaceInvariant(repetition, "race harness", false, { error });
  } finally {
    if (failed) await terminateWorkers(workers);
  }
}
