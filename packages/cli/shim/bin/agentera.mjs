#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dispatch, printInstallHelp } from "../lib/exec.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);
const meta = pkg.agentera ?? {};

function printVersion() {
  const suite = meta.suiteVersion ?? "unknown";
  const gitRef = meta.gitRef ?? "unknown";
  console.log(
    `agentera npm shim ${pkg.version} (suite ${suite}, git ${gitRef})`,
  );
}

const userArgs = process.argv.slice(2);
if (userArgs[0] === "--version" || userArgs[0] === "-V") {
  printVersion();
  process.exit(0);
}

if (userArgs[0] === "--help" || userArgs[0] === "-h") {
  printVersion();
  console.log("");
  console.log("Delegates to the Agentera Python CLI when available:");
  console.log("  1. $AGENTERA_HOME/app/scripts/agentera (via uv run)");
  console.log("  2. scripts/agentera in a parent repo (uv run)");
  console.log("  3. uvx --from git+https://github.com/jgabor/agentera@<tag> agentera");
  console.log("");
  console.log("https://github.com/jgabor/agentera");
  process.exit(0);
}

const code = dispatch(process.argv, {
  cwd: process.cwd(),
  env: process.env,
  gitRef: meta.gitRef,
  gitRepo: "https://github.com/jgabor/agentera",
  printInstallHelp,
});

process.exit(code);
