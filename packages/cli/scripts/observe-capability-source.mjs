#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2] ?? "");
if (!root || !fs.existsSync(path.join(root, "packages/cli/src/capabilities/index.ts"))) {
  throw new Error("observe-capability-source requires a source checkout root");
}

const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "agentera-source-capability-"));
try {
  const dist = path.join(temporary, "dist");
  fs.symlinkSync(path.join(root, "packages/cli/node_modules"), path.join(temporary, "node_modules"), "dir");
  const compiler = path.join(root, "packages/cli/node_modules/typescript/bin/tsc");
  const compiled = spawnSync(process.execPath, [compiler, "-p", path.join(root, "packages/cli/tsconfig.json"), "--outDir", dist, "--sourceMap", "false"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  if (compiled.status !== 0) throw new Error(`source capability compilation failed: ${(compiled.stderr || compiled.stdout).trim()}`);
  const tuples = await import(pathToFileURL(path.join(dist, "registries/activationTuples.js")).href);
  const preCutover = await import(pathToFileURL(path.join(dist, "cli/preCutoverCommand.js")).href);
  const statusStartup = await import(pathToFileURL(path.join(dist, "capabilities/status/startupInstructions.js")).href);
  const capabilityIds = tuples.ACTIVATION_CANONICAL_TUPLES
    .filter((tuple) => tuple.class === "capability")
    .map((tuple) => tuple.surface_id)
    .sort();
  const modules = {};
  for (const capability of capabilityIds) {
    const module = await import(pathToFileURL(path.join(dist, `capabilities/${capability}/instructions.js`)).href);
    if (typeof module.default !== "string") throw new Error(`source capability '${capability}' has no default instruction body`);
    const body = capability === "status" ? statusStartup.statusStartupInstructions(module.default) : module.default;
    modules[capability] = preCutover.preCutoverInstructionBody(body);
  }
  const runtime = await import(pathToFileURL(path.join(dist, "capabilities/index.js")).href);
  const routes = await import(pathToFileURL(path.join(dist, "cli/commands/capability.js")).href);
  process.stdout.write(`${JSON.stringify({
    modules,
    runtimeRegistry: runtime.CAPABILITY_INSTRUCTIONS,
    routes: ["status", ...routes.CAPABILITY_ROUTING_NAMES],
  })}\n`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
