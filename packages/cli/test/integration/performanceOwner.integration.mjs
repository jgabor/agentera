import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { validatePerformanceEvidence } from "../../scripts/performance-evidence.mjs";

const packageRoot = path.resolve(import.meta.dirname, "../..");
const root = path.resolve(packageRoot, "../..");
const policy = YAML.parse(fs.readFileSync(path.join(root, "references/analysis/verification-policy.yaml"), "utf8"));
const ownerEnv = { ...process.env };
delete ownerEnv.AGENTERA_VERIFICATION_RESULT;
const result = spawnSync("pnpm", ["run", "test:performance"], {
  cwd: packageRoot,
  encoding: "utf8",
  maxBuffer: 1024 * 1024,
  env: ownerEnv,
});

process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error || result.status !== 0) {
  console.error(`performance integration failed to run the supported owner command (${result.error?.message ?? `exit ${result.status ?? "signal"}`})`);
  process.exit(result.status ?? 1);
}
const errors = validatePerformanceEvidence(result.stdout, policy.owners.performance, root);
for (const error of errors.slice(0, 10)) console.error(`performance integration evidence invalid: ${error}`);
if (errors.length > 0) process.exit(1);
