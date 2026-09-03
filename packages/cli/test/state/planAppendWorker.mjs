import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const buildRoot = process.env.AGENTERA_SOURCE_TEST_BUILD;
const root = process.env.AGENTERA_PLAN_APPEND_ROOT;
const plan = process.env.AGENTERA_PLAN_APPEND_PLAN;
const input = process.env.AGENTERA_PLAN_APPEND_INPUT;
const ready = process.env.AGENTERA_PLAN_APPEND_READY;
const start = process.env.AGENTERA_PLAN_APPEND_START;
const result = process.env.AGENTERA_PLAN_APPEND_RESULT;
if (!buildRoot || !root || !plan || !input || !ready || !start || !result) throw new Error("plan append worker requires complete input");

const { main } = await import(pathToFileURL(path.join(buildRoot, "cli/dispatch/index.js")));
fs.writeFileSync(ready, "ready\n");
while (!fs.existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
let out = "";
let err = "";
const cwd = process.cwd();
process.chdir(root);
try {
  const rc = main(["node", "agentera", "state", "plan", "append", "--plan", plan, "--input", input, "--format", "json"], {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  fs.writeFileSync(result, JSON.stringify({ rc, output: out.trim(), error: err }));
} finally {
  process.chdir(cwd);
}
