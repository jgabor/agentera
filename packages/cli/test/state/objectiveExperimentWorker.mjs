import fs from "node:fs";

import { main } from "../../dist/cli/dispatch/index.js";
import { dumpYamlMapping } from "../../dist/core/yaml.js";

const root = process.env.AGENTERA_BASELINE_ROOT;
const objective = process.env.AGENTERA_BASELINE_OBJECTIVE;
const ready = process.env.AGENTERA_BASELINE_READY;
const start = process.env.AGENTERA_BASELINE_START;
const result = process.env.AGENTERA_BASELINE_RESULT;
if (!root || !objective || !ready || !start || !result) throw new Error("baseline worker requires complete input");
fs.writeFileSync(ready, "ready\n");
while (!fs.existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
const input = { date: "2026-07-17 09:00", label: `baseline-${process.pid}`, hypothesis: "Cache helps", method: "Run locked harness", change: "Cache keys", metric: { primary_value: "80 ms", delta_vs_baseline: "-20 ms" }, regression: "pnpm test passed", status: "baseline", conclusion: "Measured result", provenance: { command: "locked-harness", revision: "abc123" } };
let out = ""; let err = ""; const cwd = process.cwd(); process.chdir(root);
try { const rc = main(["node", "agentera", "state", "experiments", "publish", "--objective", objective, "--input", "-", "--format", "json"], { out: (text) => { out += text; }, err: (text) => { err += text; }, stdin: () => dumpYamlMapping(input) }); const body = out.trim().startsWith("{") ? JSON.parse(out) : null; fs.writeFileSync(result, JSON.stringify({ ok: rc === 0, error: body?.error?.message ?? err })); }
finally { process.chdir(cwd); }
