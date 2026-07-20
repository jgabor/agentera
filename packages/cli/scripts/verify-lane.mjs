#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const OWNER_NAMES = ["source", "stress", "performance", "package"];
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultRoot = path.resolve(packageRoot, "../..");
const root = path.resolve(process.env.AGENTERA_VERIFICATION_ROOT ?? defaultRoot);
const contractPath = path.resolve(
  process.env.AGENTERA_VERIFICATION_CONTRACT
    ?? path.join(root, "references/analysis/verification-policy.yaml"),
);

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function filesBelow(directory, suffix) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const candidate = path.join(directory, entry.name);
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

  for (const [policy, owners] of Object.entries(contract.policies ?? {})) {
    const duplicates = owners.filter((owner, index) => owners.indexOf(owner) !== index);
    if (duplicates.length > 0) errors.push(`policy '${policy}' repeats owner '${duplicates[0]}'`);
    for (const owner of owners) {
      if (!OWNER_NAMES.includes(owner)) errors.push(`policy '${policy}' names invalid owner '${owner}'`);
    }
  }

  return { files, assignments, errors };
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

function runOwner(owner, state, forwarded = []) {
  const definition = state.contract.owners[owner];
  const owned = state.files.filter((file) => state.assignments.get(file) === owner);
  if (owned.length === 0) {
    console.log(`${owner} owner: 0 whole files; mixed evidence remains with its primary owner until separation`);
    return 0;
  }
  const config = path.relative(packageRoot, path.join(root, definition.config)).split(path.sep).join("/");
  const selected = forwarded.length > 0
    ? forwarded
    : owned.map((file) => path.relative(packageRoot, path.join(root, file)).split(path.sep).join("/"));
  const result = spawnSync("vp", ["test", "run", "--config", config, ...selected], {
    cwd: packageRoot,
    stdio: "inherit",
    env: { ...process.env, AGENTERA_VERIFICATION_OWNER: owner },
  });
  if (result.error) console.error(`${owner} owner failed: ${result.error.message}`);
  else if (result.status !== 0) console.error(`${owner} owner failed (exit ${result.status ?? "signal"})`);
  if (result.error || result.status !== 0) {
    console.error(`correction: ${definition.correction}`);
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
    const status = runOwner(owner, state, owners.length === 1 ? forwarded : []);
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
  const output = { counts: { total: state.files.length, ...counts }, mixed_files: state.contract.mixed_files ?? [] };
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
  const forwarded = [name, ...rest].filter((value) => value !== undefined && value !== "--");
  process.exit(runOwner(command, state, forwarded));
}
console.error(`verification command expected an owner (${OWNER_NAMES.join(", ")}), 'policy NAME', 'inventory', 'route', or 'validate'`);
process.exit(2);
