// The local eight-worker result is selected only by its named policy; other
// runners remain at the unmeasured fallback. See the linked benchmark record.
export const MEASURED_LOCAL_WORKER_POLICY = "local-16-logical-cpu-node22";
export const UNMEASURED_WORKER_POLICY = "unmeasured";

export function workerPolicyFor(environment: NodeJS.ProcessEnv = process.env): {
  name: typeof MEASURED_LOCAL_WORKER_POLICY | typeof UNMEASURED_WORKER_POLICY | "explicit-override";
  workers: number;
} {
  const override = Number.parseInt(environment.VITEST_MAX_WORKERS ?? "", 10);
  if (override) return { name: "explicit-override", workers: override };
  if (environment.AGENTERA_VITEST_RUNNER_POLICY === MEASURED_LOCAL_WORKER_POLICY) {
    return { name: MEASURED_LOCAL_WORKER_POLICY, workers: 8 };
  }
  return { name: UNMEASURED_WORKER_POLICY, workers: 4 };
}

export function maxWorkersFor(environment: NodeJS.ProcessEnv = process.env): number {
  return workerPolicyFor(environment).workers;
}

export const maxWorkers = maxWorkersFor();

export const sharedTestConfig = {
  environment: "node" as const,
  globals: false,
  maxWorkers,
  testTimeout: 30_000,
  experimentalFsModuleCache: true,
};
