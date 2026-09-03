#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtimeRoot = path.resolve(process.argv[2] ?? "");
const cwd = path.resolve(process.argv[3] ?? "");
const observationMode = process.argv[4] ?? "full";
if (!["full", "package-smoke"].includes(observationMode)) throw new Error(`unknown runtime observation mode '${observationMode}'`);
if (!fs.existsSync(path.join(runtimeRoot, "dist/bin/agentera.js"))) throw new Error("runtime artifact has no CLI");

const tuples = await import(pathToFileURL(path.join(runtimeRoot, "dist/registries/activationTuples.js")).href);
const preCutover = await import(pathToFileURL(path.join(runtimeRoot, "dist/cli/preCutoverCommand.js")).href);
const statusStartup = await import(pathToFileURL(path.join(runtimeRoot, "dist/capabilities/status/startupInstructions.js")).href);
const runtime = await import(pathToFileURL(path.join(runtimeRoot, "dist/capabilities/index.js")).href);
const routeModule = await import(pathToFileURL(path.join(runtimeRoot, "dist/cli/commands/capability.js")).href);
const development = await import(pathToFileURL(path.join(runtimeRoot, "dist/core/developmentInvocation.js")).href);
const authority = await import(pathToFileURL(path.join(runtimeRoot, "dist/validate/bootstrapAuthority.js")).href);
const upgrade = await import(pathToFileURL(path.join(runtimeRoot, "dist/upgrade/upgradeCommands.js")).href);
const capabilityIds = tuples.ACTIVATION_CANONICAL_TUPLES.filter((tuple) => tuple.class === "capability")
  .map((tuple) => tuple.surface_id)
  .sort();

const modules = {};
for (const capability of capabilityIds) {
  const module = await import(pathToFileURL(path.join(runtimeRoot, `dist/capabilities/${capability}/instructions.js`)).href);
  const instructionBody = typeof module.servedInstructions === "function" ? module.servedInstructions() : module.default;
  if (typeof instructionBody !== "string") throw new Error(`runtime capability '${capability}' has no default instruction body`);
  const body = capability === "status" ? statusStartup.statusStartupInstructions(instructionBody) : instructionBody;
  modules[capability] = preCutover.preCutoverInstructionBody(body);
}

const served = {};
let statusPayload = null;
const servedCapabilityIds = observationMode === "package-smoke" ? ["status"] : capabilityIds;
for (const capability of servedCapabilityIds) {
  const result = spawnSync(process.execPath, [path.join(runtimeRoot, "dist/bin/agentera.js"), "prime", "--context", capability], {
    cwd,
    env: { ...process.env, AGENTERA_BOOTSTRAP_SOURCE_ROOT: path.join(runtimeRoot, "bundle") },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`runtime CLI could not serve capability '${capability}': ${(result.stderr || result.stdout).trim()}`);
  const payload = JSON.parse(result.stdout);
  if (payload?.capability_context?.capability !== capability || typeof payload?.capability_context?.instructions !== "string") throw new Error(`runtime CLI returned wrong capability '${capability}'`);
  served[capability] = payload.capability_context.instructions;
  if (capability === "status") statusPayload = payload;
}

function commandValues(value, current = "$", output = []) {
  if (typeof value === "string") {
    if (value.startsWith("npx -y agentera@next ")) output.push({ path: current, value });
  } else if (Array.isArray(value)) value.forEach((entry, index) => commandValues(entry, `${current}[${index}]`, output));
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) if (key !== "instructions") commandValues(child, `${current}.${key}`, output);
  return output;
}

function bootstrapCandidate(id) {
  const project = "/tmp/agentera-bootstrap-evidence/project";
  if (id.startsWith("prime-") || id === "prime") return preCutover.preCutoverCommand("prime --context status");
  if (id === "recommended-startup") return preCutover.preCutoverCommand("prime --context build");
  if (id.startsWith("doctor-") || id === "doctor") return upgrade.commandText(["npx", "-y", "agentera@next", "doctor", "--home", "/tmp/agentera-bootstrap-evidence/home", "--project", project, "--install-root", "/tmp/agentera-bootstrap-evidence/app"]);
  if (id === "recovery-0") return upgrade.fullEntityUpgradePreviewCommand(project);
  throw new Error(`unknown accepted bootstrap specification '${id}'`);
}

const matrix = authority.bootstrapMatrixAuthority();
const rows = [];
for (const entry of matrix.accepted) {
  const candidate = bootstrapCandidate(entry.id);
  const bound = development.bindDevelopmentInvocation({ owner: `activation.${entry.id}`, source: candidate }, candidate);
  rows.push({ id: entry.id, states: entry.states, classification: "accepted", argv: bound.argv });
}
for (const entry of matrix.rejections) {
  const source = preCutover.preCutoverCommand("prime --context status");
  try {
    development.bindDevelopmentInvocation({ owner: `activation.${entry.id}`, source }, entry.candidate);
    rows.push({
      id: entry.id,
      states: entry.states,
      classification: "unexpected_accept",
      diagnostic: null,
    });
  } catch (error) {
    rows.push({
      id: entry.id,
      states: entry.states,
      classification: error?.classification ?? "invalid_authority",
      diagnostic: String(error?.message ?? error).replaceAll(entry.candidate ?? "", "<candidate>"),
    });
  }
}

process.stdout.write(
  `${JSON.stringify({
    capabilities: {
      modules,
      runtimeRegistry: runtime.CAPABILITY_INSTRUCTIONS,
      served,
      routes: ["status", ...routeModule.CAPABILITY_ROUTING_NAMES],
      startupProducers: commandValues(statusPayload).sort((left, right) => `${left.path}\0${left.value}`.localeCompare(`${right.path}\0${right.value}`)),
    },
    bootstrap: { matrix, rows },
  })}\n`,
);
