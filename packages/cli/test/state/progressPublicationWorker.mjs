import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const buildRoot = process.env.AGENTERA_SOURCE_TEST_BUILD;
const project = process.env.AGENTERA_PROGRESS_RACE_ROOT;
const ready = process.env.AGENTERA_PROGRESS_RACE_READY;
const start = process.env.AGENTERA_PROGRESS_RACE_START;
const result = process.env.AGENTERA_PROGRESS_RACE_RESULT;
const what = process.env.AGENTERA_PROGRESS_RACE_WHAT;
if (!buildRoot || !project || !ready || !start || !result || !what)
  throw new Error("progress race input is incomplete");

fs.writeFileSync(ready, "ready\n");
while (!fs.existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);

const { main } = await import(pathToFileURL(path.join(buildRoot, "cli/dispatch/index.js")));
let stdout = "";
let stderr = "";
const code = main(
  [
    "node",
    "agentera",
    "state",
    "progress",
    "append",
    "--project",
    project,
    "--input",
    "-",
    "--format",
    "json",
  ],
  {
    out: (text) => {
      stdout += text;
    },
      err: (text) => {
      stderr += text;
    },
    stdin: () => JSON.stringify({
      timestamp: "2026-07-17 12:00",
      type: "fix",
      phase: "build",
      what,
      context: { intent: "exercise locked same-minute publication" },
    }),
  },
);
fs.writeFileSync(result, JSON.stringify({ code, stdout, stderr }));
