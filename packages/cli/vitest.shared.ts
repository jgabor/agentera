import os from "node:os";

// Keep concurrent agent runs below the process and memory pressure of one
// worker per CPU. VITEST_MAX_WORKERS remains the explicit machine override.
export const maxWorkers =
  Number.parseInt(process.env.VITEST_MAX_WORKERS ?? "", 10) ||
  Math.max(2, Math.ceil(os.cpus().length / 4));

export const sharedTestConfig = {
  environment: "node" as const,
  globals: false,
  maxWorkers,
  testTimeout: 30_000,
  experimentalFsModuleCache: true,
};
