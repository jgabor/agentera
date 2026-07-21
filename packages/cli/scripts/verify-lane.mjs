#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { validatePerformanceEvidence } from "./performance-evidence.mjs";

const OWNER_NAMES = ["source", "stress", "performance", "package"];
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultRoot = path.resolve(packageRoot, "../..");
const root = path.resolve(process.env.AGENTERA_VERIFICATION_ROOT ?? defaultRoot);
const inventoryPackageRoot = path.join(root, "packages/cli");
const contractPath = path.resolve(
  process.env.AGENTERA_VERIFICATION_CONTRACT
    ?? path.join(root, "references/analysis/verification-policy.yaml"),
);

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function runnerPath(file) {
  return path.relative(inventoryPackageRoot, path.join(root, file)).split(path.sep).join("/");
}

function filesBelow(directory, suffix) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) return [];
      return entry.isDirectory() ? filesBelow(candidate, suffix) : candidate.endsWith(suffix) ? [candidate] : [];
    });
}

function loadContract() {
  return YAML.parse(fs.readFileSync(contractPath, "utf8"));
}

function matches(rule, file) {
  return (rule.path !== undefined && rule.path === file)
    || (rule.prefix !== undefined && file.startsWith(rule.prefix));
}

function inventory(contract) {
  const errors = [];
  const ownerKeys = Object.keys(contract.owners ?? {});
  for (const owner of OWNER_NAMES) {
    if (!ownerKeys.includes(owner)) errors.push(`missing primary owner '${owner}'`);
  }
  for (const owner of ownerKeys) {
    if (!OWNER_NAMES.includes(owner)) errors.push(`invalid primary owner '${owner}'; expected ${OWNER_NAMES.join(", ")}`);
  }

  const inventoryRoot = path.join(root, contract.inventory.root);
  const files = filesBelow(inventoryRoot, contract.inventory.suffix).map(relative).sort();
  const assignments = new Map();
  for (const file of files) {
    const explicit = (contract.inventory.rules ?? []).filter((rule) => matches(rule, file));
    if (explicit.length > 1) {
      errors.push(`ownership overlap: ${file} matches ${explicit.map(({ owner }) => owner).join(", ")}`);
      continue;
    }
    const owner = explicit[0]?.owner ?? contract.inventory.default_owner;
    if (!owner) {
      errors.push(`ownership gap: ${file} has no primary owner`);
      continue;
    }
    if (!OWNER_NAMES.includes(owner)) {
      errors.push(`invalid primary owner '${owner}' for ${file}`);
      continue;
    }
    assignments.set(file, owner);
  }

  for (const mixed of contract.mixed_files ?? []) {
    if (!assignments.has(mixed.path)) errors.push(`mixed-file marker does not match inventory: ${mixed.path}`);
    else if (assignments.get(mixed.path) !== mixed.primary_owner) {
      errors.push(`mixed-file primary owner mismatch: ${mixed.path} is ${assignments.get(mixed.path)}, not ${mixed.primary_owner}`);
    }
    if (!OWNER_NAMES.includes(mixed.separation_target) || mixed.separation_target === mixed.primary_owner) {
      errors.push(`mixed-file separation target is invalid: ${mixed.path}`);
    }
  }

  const evidenceProducers = new Map();
  for (const rule of contract.inventory.rules ?? []) {
    if (!rule.evidence_producer) continue;
    if (rule.path === undefined || !files.includes(rule.path)) {
      errors.push(`evidence producer must name one inventory file: ${rule.path ?? "missing path"}`);
      continue;
    }
    if (assignments.get(rule.path) !== rule.owner) {
      errors.push(`evidence producer owner mismatch: ${rule.path} is ${assignments.get(rule.path)}, not ${rule.owner}`);
      continue;
    }
    if (evidenceProducers.has(rule.owner)) {
      errors.push(`multiple evidence producers for ${rule.owner}: ${evidenceProducers.get(rule.owner)}, ${rule.path}`);
      continue;
    }
    evidenceProducers.set(rule.owner, rule.path);
  }
  for (const [owner, definition] of Object.entries(contract.owners ?? {})) {
    if (definition.evidence !== undefined && !evidenceProducers.has(owner)) {
      errors.push(`${owner} evidence has no marked inventory producer`);
    }
  }

  for (const [policy, owners] of Object.entries(contract.policies ?? {})) {
    const duplicates = owners.filter((owner, index) => owners.indexOf(owner) !== index);
    if (duplicates.length > 0) errors.push(`policy '${policy}' repeats owner '${duplicates[0]}'`);
    for (const owner of owners) {
      if (!OWNER_NAMES.includes(owner)) errors.push(`policy '${policy}' names invalid owner '${owner}'`);
    }
  }

  for (const [owner, definition] of Object.entries(contract.owners ?? {})) {
    if (!definition.integration) continue;
    const integrationPath = definition.integration.path;
    if (!fs.existsSync(path.join(root, integrationPath))) errors.push(`${owner} integration is missing: ${integrationPath}`);
    if (files.includes(integrationPath)) errors.push(`${owner} integration must not overlap primary test inventory: ${integrationPath}`);
    if (!Array.isArray(definition.integration.command) || definition.integration.command.length < 2) errors.push(`${owner} integration command is invalid`);
  }

  return { files, assignments, evidenceProducers, errors };
}

function validated() {
  let contract;
  try {
    contract = loadContract();
  } catch (error) {
    console.error(`verification policy could not be read: ${error.message}`);
    process.exit(2);
  }
  const result = inventory(contract);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`verification policy: ${error}`);
    console.error(`correction: update ${relative(contractPath)} so every test file has exactly one primary owner`);
    process.exit(2);
  }
  return { contract, ...result };
}

function canonicalInventoryFile(filter, state) {
  const normalized = filter.replaceAll("\\", "/");
  if (/^file:/i.test(normalized)) throw new Error("file URLs are not supported");
  if (normalized.split("/").includes("..")) throw new Error("traversal filters are not supported");
  if (/[*?{}[\]]/.test(normalized)) throw new Error("glob filters are not supported");
  if (!path.isAbsolute(normalized) && !normalized.startsWith(".") && !normalized.includes("/")) {
    throw new Error("selectors are not supported; expected an exact canonical inventory file");
  }
  const base = normalized.startsWith("packages/") ? root : inventoryPackageRoot;
  const candidate = path.resolve(base, normalized);
  if (!fs.existsSync(candidate)) throw new Error("no canonical inventory file");
  if (!fs.statSync(candidate).isFile()) throw new Error("directories are not supported");
  const canonical = fs.realpathSync(candidate);
  const matches = state.files.filter((file) => fs.realpathSync(path.join(root, file)) === canonical);
  if (matches.length !== 1) throw new Error("not a canonical inventory file");
  return matches[0];
}

function normalizedSelection(owner, state, forwarded) {
  const definition = state.contract.owners[owner];
  const safe = definition.forwarding?.safe_options ?? {};
  const forbidden = definition.forwarding?.forbidden_options ?? {};
  const options = [];
  const files = [];
  let sawFile = false;
  for (const argument of forwarded) {
    if (argument === "--") {
      if (sawFile) throw new Error("ambiguous delimiter after a positional filter");
      continue;
    }
    if (!argument.startsWith("-")) {
      sawFile = true;
      let file;
      try {
        file = canonicalInventoryFile(argument, state);
      } catch (error) {
        const display = JSON.stringify(argument.length > 200 ? `${argument.slice(0, 197)}...` : argument);
        throw new Error(`filter ${display}: ${error.message}`);
      }
      if (state.assignments.get(file) !== owner) {
        throw new Error(`filter ${JSON.stringify(argument)}: owner ${state.assignments.get(file)}`);
      }
      if (!files.includes(file)) files.push(file);
      continue;
    }
    const option = argument.split("=", 1)[0];
    if (forbidden[option]) throw new Error(`forbidden option '${option}': ${forbidden[option]}`);
    if (safe[option] === undefined) throw new Error(`unknown option '${option}': unreviewed options may alter owner selection or evidence output`);
    if (safe[option] === "none" && argument.includes("=")) throw new Error(`safe flag '${option}' does not accept a value`);
    if (safe[option] !== "none") throw new Error(`invalid forwarding contract for '${option}'`);
    options.push(option);
  }
  const producer = state.evidenceProducers.get(owner);
  if (files.length > 0 && producer !== undefined && !files.includes(producer)) {
    throw new Error(`selection omits required evidence producer '${runnerPath(producer)}'`);
  }
  const selectedFiles = files.length > 0
    ? files
    : state.files.filter((file) => state.assignments.get(file) === owner);
  return {
    argv: [
      ...options,
      ...selectedFiles.map(runnerPath),
    ],
  };
}

function validateForwardedSelection(owner, state, forwarded) {
  try {
    return normalizedSelection(owner, state, forwarded);
  } catch (error) {
    console.error(`${owner} owner rejected ${error.message}`);
    console.error(`ownership risk: forwarded arguments must not change suite membership, configuration, or evidence output`);
    const producer = state.evidenceProducers.get(owner);
    if (producer !== undefined) {
      console.error(`required producer: ${runnerPath(producer)}`);
    }
    console.error(`correction: select only ${owner}-owned files by exact inventory path from 'node packages/cli/scripts/verify-lane.mjs inventory --json' or run the complete owner; ${state.contract.owners[owner].correction}`);
    return undefined;
  }
}

function runOwner(owner, state, forwarded = []) {
  const definition = state.contract.owners[owner];
  const owned = state.files.filter((file) => state.assignments.get(file) === owner);
  if (owned.length === 0) {
    console.log(`${owner} owner: 0 whole files; mixed evidence remains with its primary owner until separation`);
    return 0;
  }
  const selection = validateForwardedSelection(owner, state, forwarded);
  if (selection === undefined) return 2;
  if (owner === "performance" && process.env.AGENTERA_VERIFICATION_RESULT) {
    console.error(`${owner} owner rejected environment output override AGENTERA_VERIFICATION_RESULT`);
    console.error(`ownership risk: reporter redirection can suppress the required evidence line`);
    console.error(`correction: remove AGENTERA_VERIFICATION_RESULT; ${definition.correction}`);
    return 2;
  }
  const config = path.relative(packageRoot, path.join(root, definition.config)).split(path.sep).join("/");
  const resultChannel = process.env.AGENTERA_VERIFICATION_RESULT;
  const reporter = resultChannel
    ? ["--reporter=json", `--outputFile=${resultChannel}`]
    : [];
  const captureEvidence = definition.evidence !== undefined;
  const runnerEnv = { ...process.env, AGENTERA_VERIFICATION_OWNER: owner };
  delete runnerEnv.AGENTERA_VERIFICATION_RESULT;
  const result = spawnSync("vp", ["test", "run", "--config", config, ...selection.argv, ...reporter], {
    cwd: packageRoot,
    stdio: captureEvidence ? ["inherit", "pipe", "pipe"] : "inherit",
    encoding: captureEvidence ? "utf8" : undefined,
    maxBuffer: captureEvidence ? 1024 * 1024 : undefined,
    env: runnerEnv,
  });
  if (captureEvidence) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
  }
  if (result.error) console.error(`${owner} owner failed: ${result.error.message}`);
  else if (result.status !== 0) console.error(`${owner} owner failed (exit ${result.status ?? "signal"})`);
  const evidenceErrors = !result.error && result.status === 0 && captureEvidence
    ? validatePerformanceEvidence(result.stdout ?? "", definition, root)
    : [];
  for (const error of evidenceErrors.slice(0, 10)) console.error(`${owner} owner evidence invalid: ${error}`);
  if (result.error || result.status !== 0 || evidenceErrors.length > 0) {
    console.error(`correction: ${definition.correction}`);
    return result.error || result.status !== 0 ? result.status ?? 1 : 1;
  }
  return 0;
}

function runIntegration(owner, state) {
  const integration = state.contract.owners[owner].integration;
  const [executable, ...args] = integration.command;
  const result = spawnSync(executable, args, { cwd: packageRoot, stdio: "inherit", env: process.env });
  if (result.error || result.status !== 0) {
    console.error(`${owner} integration failed (${result.error?.message ?? `exit ${result.status ?? "signal"}`})`);
    console.error(`correction: ${state.contract.owners[owner].correction}`);
    return result.status ?? 1;
  }
  return 0;
}

function runPolicy(name, state, forwarded) {
  const owners = state.contract.policies[name];
  if (!owners) {
    console.error(`unknown verification policy '${name}'; expected ${Object.keys(state.contract.policies).join(", ")}`);
    return 2;
  }
  for (const owner of owners) {
    const definition = state.contract.owners[owner];
    const status = definition.integration
      ? runIntegration(owner, state)
      : runOwner(owner, state, owners.length === 1 ? forwarded : []);
    if (status !== 0) return status;
  }
  return 0;
}

function route(paths, contract) {
  const { exact = [], prefixes = [] } = contract.conservative_routing ?? {};
  return paths.some((file) => exact.includes(file) || prefixes.some((prefix) => file.startsWith(prefix)))
    ? "release"
    : "precommit";
}

const [command, name, ...rest] = process.argv.slice(2);
const state = validated();
if (command === "validate") process.exit(0);
if (command === "inventory") {
  const counts = Object.fromEntries(OWNER_NAMES.map((owner) => [owner, [...state.assignments.values()].filter((value) => value === owner).length]));
  const files = Object.fromEntries(OWNER_NAMES.map((owner) => [owner, state.files.filter((file) => state.assignments.get(file) === owner)]));
  const integrations = Object.fromEntries(Object.entries(state.contract.owners).flatMap(([owner, definition]) => definition.integration ? [[owner, definition.integration.path]] : []));
  const evidence_producers = Object.fromEntries(state.evidenceProducers);
  const output = { counts: { total: state.files.length, ...counts }, files, integrations, evidence_producers, mixed_files: state.contract.mixed_files ?? [] };
  console.log(process.argv.includes("--json") ? JSON.stringify(output, null, 2) : YAML.stringify(output).trim());
  process.exit(0);
}
if (command === "route") {
  const paths = [name, ...rest].filter((value) => value && value !== "--policy-only");
  console.log(route(paths, state.contract));
  process.exit(0);
}
if (command === "policy") {
  const forwarded = rest[0] === "--" ? rest.slice(1) : rest;
  process.exit(runPolicy(name, state, forwarded));
}
if (OWNER_NAMES.includes(command)) {
  const forwarded = [name, ...rest].filter((value) => value !== undefined);
  process.exit(runOwner(command, state, forwarded));
}
console.error(`verification command expected an owner (${OWNER_NAMES.join(", ")}), 'policy NAME', 'inventory', 'route', or 'validate'`);
process.exit(2);
