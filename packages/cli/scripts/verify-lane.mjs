#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const lane = process.argv[2];
const configs = {
  source: "vite.config.ts",
  package: "vite.package.config.ts",
};

if (!(lane in configs)) {
  console.error("verification boundary: expected lane source or package");
  process.exit(2);
}

const forwarded = process.argv.slice(3);
if (forwarded[0] === "--") forwarded.shift();
const result = spawnSync("vp", ["test", "run", "--config", configs[lane], ...forwarded], {
  stdio: "inherit",
});
if (result.error) {
  console.error(`${lane} verification boundary failed: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`${lane} verification boundary failed (exit ${result.status ?? "signal"}); the ${lane === "source" ? "package" : "source"} lane was not invoked`);
  process.exit(result.status ?? 1);
}
