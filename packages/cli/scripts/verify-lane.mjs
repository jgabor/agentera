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

function optionArity() {
  const help = spawnSync("vp", ["test", "run", "--help"], {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (help.error || help.status !== 0) {
    const detail = help.error?.message ?? `exit ${help.status ?? "signal"}`;
    throw new Error(`could not inspect Vitest options (${detail})`);
  }
  const arity = new Map();
  for (const line of help.stdout.split("\n")) {
    const declaration = line.match(/^\s+((?:-[\w-]+,\s+)?--[\w.-]+|-[\w-]+)(?:\s+(<[^>]+>|\[[^\]]+\]))?\s{2,}/);
    if (!declaration) continue;
    const value = declaration[2]?.startsWith("<")
      ? "required"
      : declaration[2]?.startsWith("[")
        ? "optional"
        : "none";
    for (const option of declaration[1].match(/--?[\w.-]+/g) ?? []) arity.set(option, value);
  }
  return arity;
}

function forwardedFilters(forwarded) {
  if (!forwarded.some((argument) => argument.startsWith("-"))) return forwarded;
  const arity = optionArity();
  const filters = [];
  let positionalOnly = false;
  for (let index = 0; index < forwarded.length; index += 1) {
    const argument = forwarded[index];
    if (positionalOnly) {
      filters.push(argument);
      continue;
    }
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (!argument.startsWith("-")) {
      filters.push(argument);
      continue;
    }
    const option = argument.split("=", 1)[0];
    const consumes = arity.get(option);
    if (!consumes) throw new Error(`unknown Vitest option '${option}'`);
    if (!argument.includes("=") && consumes !== "none" && forwarded[index + 1] !== undefined && !forwarded[index + 1].startsWith("-")) {
      index += 1;
    } else if (!argument.includes("=") && consumes === "required") {
      throw new Error(`Vitest option '${option}' requires a value`);
    }
  }
  return filters;
}

function matchingInventoryFiles(filter, state) {
  const normalized = filter.split(path.sep).join("/");
  const absolute = path.isAbsolute(filter) ? path.normalize(filter).split(path.sep).join("/") : undefined;
  return state.files.filter((file) => {
    const packageRelative = path.relative(packageRoot, path.join(root, file)).split(path.sep).join("/");
    const absoluteFile = path.join(root, file).split(path.sep).join("/");
    return absolute ? absoluteFile.includes(absolute) : file.includes(normalized) || packageRelative.includes(normalized);
  });
}

function validateForwardedSelection(owner, state, forwarded) {
  let filters;
  try {
    filters = forwardedFilters(forwarded);
  } catch (error) {
    console.error(`${owner} owner rejected forwarded arguments: ${error.message}`);
    console.error(`correction: ${state.contract.owners[owner].correction}`);
    return undefined;
  }
  for (const filter of filters) {
    const matches = matchingInventoryFiles(filter, state);
    const owners = [...new Set(matches.map((file) => state.assignments.get(file)))];
    if (matches.length === 0 || owners.length !== 1 || owners[0] !== owner) {
      const display = JSON.stringify(filter.length > 200 ? `${filter.slice(0, 197)}...` : filter);
      const detail = matches.length === 0 ? "no owned inventory file" : `owner ${owners.join(", ")}`;
      console.error(`${owner} owner rejected filter ${display}: ${detail}`);
      console.error(`correction: select only ${owner}-owned files from 'node packages/cli/scripts/verify-lane.mjs inventory --json'; ${state.contract.owners[owner].correction}`);
      return undefined;
    }
  }
  return filters;
}

function getPath(value, pointer) {
  return pointer.split(".").reduce((current, key) => current?.[key], value);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validatePerformanceEvidence(stdout, definition) {
  const evidenceDefinition = definition.evidence;
  if (evidenceDefinition.stdout_format !== "newline_delimited_json_record_amid_runner_output") {
    return [`unsupported stdout format '${evidenceDefinition.stdout_format}'`];
  }
  const records = stdout.split("\n").flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed?.schemaVersion === evidenceDefinition.schema_version ? [parsed] : [];
    } catch {
      return [];
    }
  });
  if (records.length !== 1) return [`expected exactly one ${evidenceDefinition.schema_version} stdout line; observed ${records.length}`];
  const evidence = records[0];
  const bytes = Buffer.byteLength(`${JSON.stringify(evidence)}\n`, "utf8");
  const [authorityFile, authorityPointer] = evidenceDefinition.authority.split("#", 2);
  const authority = YAML.parse(fs.readFileSync(path.join(root, authorityFile), "utf8"));
  const measurement = getPath(authority, authorityPointer);
  const targetNames = Object.keys(measurement.targets);
  const scales = Object.fromEntries(Object.entries(measurement.fixtures).flatMap(([name, fixture]) => {
    const count = String(fixture).match(/^\d+/)?.[0];
    return count === undefined ? [] : [[name, Number(count)]];
  }));
  const errors = [];
  if (bytes > evidenceDefinition.max_utf8_bytes) errors.push(`evidence is ${bytes} UTF-8 bytes; limit ${evidenceDefinition.max_utf8_bytes}`);
  if (evidence.status !== "pass") errors.push("status is not pass");
  if (!evidence.runner || typeof evidence.runner.platform !== "string" || typeof evidence.runner.release !== "string" || typeof evidence.runner.architecture !== "string" || typeof evidence.runner.node !== "string" || !Number.isInteger(evidence.runner.logicalCpus) || evidence.runner.logicalCpus < 1 || evidence.runner.coldProcessPerSample !== true) errors.push("runner conditions are incomplete");
  if (evidence.measurement?.authority !== evidenceDefinition.authority) errors.push("measurement authority does not match policy");
  if (!sameValue(evidence.measurement?.scales, scales) || !sameValue(evidence.measurement?.declaredFixtures, measurement.fixtures)) errors.push("declared scales or fixtures changed");
  if (!["elapsed", "heap", "bytes"].every((field) => evidence.measurement?.[field] === measurement.sampling[field])) errors.push("sampling conditions changed");
  if (evidence.measurement?.repetitions !== measurement.sampling.repetitions || evidence.measurement?.heapSampling?.intervalMs !== 1 || evidence.measurement?.heapSampling?.cadenceChanged !== false) errors.push("repetitions or 1 ms heap cadence changed");
  if (!sameValue(evidence.limits, measurement.targets)) errors.push("declared limits changed");
  if (!Array.isArray(evidence.samples) || evidence.samples.length !== targetNames.length * measurement.sampling.repetitions) {
    errors.push(`expected ${targetNames.length * measurement.sampling.repetitions} samples`);
  } else {
    const sampleTargets = evidence.samples.map((sample) => sample.operation === "exact_get" ? "exact_get" : `${sample.operation}_${sample.scale}`);
    const expectedRepetitions = Array.from({ length: measurement.sampling.repetitions }, (_, index) => index + 1);
    const complete = targetNames.every((target) => sameValue(
      evidence.samples.filter((_, index) => sampleTargets[index] === target).map((sample) => sample.repetition).sort(),
      expectedRepetitions,
    ))
      && evidence.samples.every((sample) => sample.status === "pass" && Number.isInteger(sample.repetition) && sample.repetition >= 1 && sample.repetition <= measurement.sampling.repetitions);
    if (!complete) errors.push("samples do not cover every target and repetition");
  }
  const maximaMatch = sameValue(Object.keys(evidence.maxima ?? {}), targetNames) && targetNames.every((target) => {
    const samples = evidence.samples?.filter((sample) => target === "exact_get" ? sample.operation === target : `${sample.operation}_${sample.scale}` === target) ?? [];
    return sameValue(evidence.maxima[target], {
      repetitions: samples.length,
      maxElapsedMs: Math.max(...samples.map((sample) => Number(sample.elapsedMs))),
      maxHeapDeltaBytes: Math.max(...samples.map((sample) => Number(sample.heapDeltaBytes))),
      maxOutputBytes: Math.max(...samples.map((sample) => Number(sample.outputBytes))),
      minInspectorSamples: Math.min(...samples.map((sample) => Number(sample.inspectorSamples))),
    });
  });
  if (!maximaMatch) errors.push("maxima do not match the declared samples");
  return errors;
}

function runOwner(owner, state, forwarded = []) {
  const definition = state.contract.owners[owner];
  const owned = state.files.filter((file) => state.assignments.get(file) === owner);
  if (owned.length === 0) {
    console.log(`${owner} owner: 0 whole files; mixed evidence remains with its primary owner until separation`);
    return 0;
  }
  const filters = validateForwardedSelection(owner, state, forwarded);
  if (filters === undefined) return 2;
  const config = path.relative(packageRoot, path.join(root, definition.config)).split(path.sep).join("/");
  const ownedSelection = owned.map((file) => path.relative(packageRoot, path.join(root, file)).split(path.sep).join("/"));
  const selected = forwarded.length > 0
    ? [...forwarded, ...(filters.length === 0 ? ownedSelection : [])]
    : ownedSelection;
  const reporter = process.env.AGENTERA_VERIFICATION_RESULT
    ? ["--reporter=json", `--outputFile=${process.env.AGENTERA_VERIFICATION_RESULT}`]
    : [];
  const captureEvidence = definition.evidence !== undefined;
  const result = spawnSync("vp", ["test", "run", "--config", config, ...selected, ...reporter], {
    cwd: packageRoot,
    stdio: captureEvidence ? ["inherit", "pipe", "pipe"] : "inherit",
    encoding: captureEvidence ? "utf8" : undefined,
    maxBuffer: captureEvidence ? 1024 * 1024 : undefined,
    env: { ...process.env, AGENTERA_VERIFICATION_OWNER: owner },
  });
  if (captureEvidence) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
  }
  if (result.error) console.error(`${owner} owner failed: ${result.error.message}`);
  else if (result.status !== 0) console.error(`${owner} owner failed (exit ${result.status ?? "signal"})`);
  const evidenceErrors = !result.error && result.status === 0 && captureEvidence
    ? validatePerformanceEvidence(result.stdout ?? "", definition)
    : [];
  for (const error of evidenceErrors.slice(0, 10)) console.error(`${owner} owner evidence invalid: ${error}`);
  if (result.error || result.status !== 0 || evidenceErrors.length > 0) {
    console.error(`correction: ${definition.correction}`);
    return result.error || result.status !== 0 ? result.status ?? 1 : 1;
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
  const files = Object.fromEntries(OWNER_NAMES.map((owner) => [owner, state.files.filter((file) => state.assignments.get(file) === owner)]));
  const output = { counts: { total: state.files.length, ...counts }, files, mixed_files: state.contract.mixed_files ?? [] };
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
  if (forwarded[0] === "--") forwarded.shift();
  process.exit(runOwner(command, state, forwarded));
}
console.error(`verification command expected an owner (${OWNER_NAMES.join(", ")}), 'policy NAME', 'inventory', 'route', or 'validate'`);
process.exit(2);
