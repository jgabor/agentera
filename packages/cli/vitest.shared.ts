// Eight workers is the fastest repeatably passing source setting measured on
// the named runner; see references/analysis/worker-policy-2026-07-21.yaml.
// VITEST_MAX_WORKERS remains the explicit machine override.
export function maxWorkersFor(environment: NodeJS.ProcessEnv = process.env): number {
  return Number.parseInt(environment.VITEST_MAX_WORKERS ?? "", 10) || 8;
}

export const maxWorkers = maxWorkersFor();

export const sharedTestConfig = {
  environment: "node" as const,
  globals: false,
  maxWorkers,
  testTimeout: 30_000,
  experimentalFsModuleCache: true,
};
