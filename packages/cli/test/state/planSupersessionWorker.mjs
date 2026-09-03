import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const buildRoot = process.env.AGENTERA_SOURCE_TEST_BUILD;
const root = process.env.AGENTERA_PLAN_RACE_ROOT;
const plan = process.env.AGENTERA_PLAN_RACE_PLAN;
const blocked = process.env.AGENTERA_PLAN_RACE_BLOCKED;
const replacement = process.env.AGENTERA_PLAN_RACE_REPLACEMENT;
const action = process.env.AGENTERA_PLAN_RACE_ACTION;
const ready = process.env.AGENTERA_PLAN_RACE_READY;
const start = process.env.AGENTERA_PLAN_RACE_START;
const result = process.env.AGENTERA_PLAN_RACE_RESULT;
if (!buildRoot || !root || !plan || !blocked || !replacement || !action || !ready || !start || !result) throw new Error("plan race worker requires complete input");

const { main } = await import(pathToFileURL(path.join(buildRoot, "cli/dispatch/index.js")));
fs.writeFileSync(ready, "ready\n");
while (!fs.existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
const args =
  action === "supersede"
    ? ["state", "plan", "supersede", "--plan", plan, "--id", blocked, "--by", replacement, "--reason", "Completed replacement covers the blocked task.", "--format", "json"]
    : action === "reopen"
      ? ["state", "plan", "set-status", "--plan", plan, "--id", replacement, "--status", "pending", "--format", "json"]
      : ["state", "plan", "archive", "--plan", plan, "--format", "json"];
let out = "";
let err = "";
const cwd = process.cwd();
process.chdir(root);
try {
  const rc = main(["node", "agentera", ...args], {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  fs.writeFileSync(
    result,
    JSON.stringify({
      ok: rc === 0,
      error: out.trim().startsWith("{") ? JSON.parse(out).error?.message : err,
    }),
  );
} finally {
  process.chdir(cwd);
}
