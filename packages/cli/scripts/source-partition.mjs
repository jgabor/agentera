// Partitions the source-owner inventory for distributed development CI. The
// verification policy owns the core files, shard count and balance weights; this
// module only derives file lists from them. Weights affect balance, never
// membership: core plus every shard is always the exact source inventory.

export const SOURCE_PARTITION_ENVIRONMENT = "AGENTERA_SOURCE_PARTITION";

export function sourcePartitionErrors(partitions, sourceFiles, requiredCoreFiles = []) {
  if (partitions === undefined) return [];
  const errors = [];
  const owned = new Set(sourceFiles);
  const core = partitions.core ?? [];
  for (const file of core) {
    if (!owned.has(file)) errors.push(`source partition core file is not a source-owned inventory file: ${file}`);
  }
  if (new Set(core).size !== core.length) errors.push("source partition core repeats a file");
  for (const file of requiredCoreFiles) {
    if (!core.includes(file)) errors.push(`source partition core must contain ${file}`);
  }
  for (const file of Object.keys(partitions.weights_ms ?? {})) {
    if (!owned.has(file)) errors.push(`source partition weight names a file that is not source-owned: ${file}`);
    else if (core.includes(file)) errors.push(`source partition weight names a core file: ${file}`);
  }
  const shardFiles = sourceFiles.length - core.length;
  if (Number.isSafeInteger(partitions.shards) && partitions.shards > shardFiles) {
    errors.push(`source partition shards (${partitions.shards}) exceed the ${shardFiles} non-core source files`);
  }
  return errors;
}

export function parseSourcePartition(value, partitions) {
  if (value === undefined || value === "") return undefined;
  if (partitions === undefined) throw new Error(`${SOURCE_PARTITION_ENVIRONMENT} requires verification-policy.yaml#source_partitions`);
  if (value === "core") return { kind: "core", label: "core" };
  const match = /^shard:([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`${SOURCE_PARTITION_ENVIRONMENT} must be 'core' or 'shard:INDEX/COUNT', not ${JSON.stringify(value)}`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count !== partitions.shards) throw new Error(`${SOURCE_PARTITION_ENVIRONMENT} shard count ${count} does not match the policy's ${partitions.shards} shards`);
  if (index > count) throw new Error(`${SOURCE_PARTITION_ENVIRONMENT} shard index ${index} exceeds ${count}`);
  return { kind: "shard", label: `shard-${index}`, index, count };
}

function shardAssignments(sourceFiles, partitions) {
  const core = new Set(partitions.core);
  const weight = (file) => partitions.weights_ms?.[file] ?? partitions.default_weight_ms;
  // Longest-processing-time first; path order breaks ties so every job derives
  // the same assignment from the same inventory and policy.
  const files = sourceFiles.filter((file) => !core.has(file)).sort((left, right) => weight(right) - weight(left) || (left < right ? -1 : left > right ? 1 : 0));
  const shards = Array.from({ length: partitions.shards }, () => ({ load: 0, files: [] }));
  for (const file of files) {
    let target = shards[0];
    for (const shard of shards) if (shard.load < target.load) target = shard;
    target.files.push(file);
    target.load += weight(file);
  }
  return shards.map((shard) => shard.files.sort());
}

export function sourcePartitionFiles(sourceFiles, partitions, partition) {
  if (partition.kind === "core") return [...partitions.core].sort();
  return shardAssignments(sourceFiles, partitions)[partition.index - 1];
}
