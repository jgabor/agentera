import { defineConfig } from "vite-plus";
import os from "node:os";

// Cap worker parallelism so multiple concurrent agents don't OOM the box.
// A single unbounded run (maxWorkers = cpu count) holds ~4 GiB peak here because
// forks pool nests worker → vitest-N → node → node, so N `maxWorkers` becomes
// ~2N live processes. Capping at cpu/4 keeps peak RSS near 2.4 GiB per run, which
// lets 3+ agents run in parallel against a typical 10 GiB free budget.
//
// Override per shell or per machine when you know the load: VITEST_MAX_WORKERS=<n>.
// Lower (e.g. 4) for agent swarms; higher (e.g. cpu) for a single solo run.
//
// Measurements (16-core / 30 GiB, 132 files / 1145 tests):
//   maxWorkers=4  → 35.9s,  2.4 GiB peak, 12 concurrent procs
//   maxWorkers=8  → 27.5s,  2.7 GiB peak, 19 concurrent procs
//   maxWorkers=16 → 28.0s,  4.0 GiB peak, 32 concurrent procs (OOM risk under load)
const maxWorkers =
  Number.parseInt(process.env.VITEST_MAX_WORKERS ?? "", 10) ||
  Math.max(2, Math.ceil(os.cpus().length / 4));

export default defineConfig({
  // Vite+ reads this for lint/fmt/check; `vp test` reads the test block below.
  // The CLI uses scripts/precommit-vitest.sh for pre-commit (no `staged` block
  // here — that's a web/mobile concern). Lint findings captured at task-3
  // cutover live in `.lint-baseline.txt`; non-regression is the gate, not
  // zero-findings (pre-existing cleanup is a deferred [chore:3.0.0]).
  lint: {
    ignorePatterns: ["dist/**", "bundle/**", "node_modules/**", "**/*.generated.*"],
  },
  fmt: {
    ignorePatterns: ["dist/**", "bundle/**", "node_modules/**", "**/*.generated.*"],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    // forks stays the default — some tests use process.chdir, so threads is not safe.
    maxWorkers,
    // vitest 4 enforces the 5000ms default testTimeout on blocking spawnSync/DB
    // tests where v2 did not. The extractCorpusParity Python-probe tests run
    // ~9-16s legitimately; 30s restores v2 behavior with 2x headroom under
    // multi-agent concurrency while still catching genuinely hung tests.
    testTimeout: 30_000,
    // Persist transformed-module cache to disk so reruns (and concurrent agents)
    // reuse work instead of holding duplicate graphs in memory.
    experimentalFsModuleCache: true,
  },
});
