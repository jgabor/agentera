import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function git(repo, args, options = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: options.encoding ?? null,
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${options.label ?? "Git source identity"} could not read Git state: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function indexEntries(repo, label) {
  const records = git(repo, ["ls-files", "--stage", "-z"], { label })
    .toString("utf8").split("\0").filter(Boolean);
  const entries = new Map();
  for (const record of records) {
    const match = /^(100644|100755|120000) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error(`${label} encountered an unsupported Git index entry`);
    const [, mode, object, stage, relative] = match;
    if (stage !== "0" || entries.has(relative)) {
      throw new Error(`${label} cannot bind unresolved Git index stages for ${relative}`);
    }
    entries.set(relative, { relative, mode, object });
  }
  return entries;
}

function indexedBytes(repo, entries, label) {
  if (entries.length === 0) return [];
  const output = git(repo, ["cat-file", "--batch"], {
    label,
    input: Buffer.from(`${entries.map((entry) => entry.object).join("\n")}\n`),
  });
  const values = [];
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error(`${label} received incomplete Git object data`);
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (!match || match[1] !== entry.object) {
      throw new Error(`${label} received invalid Git object data for ${entry.relative}`);
    }
    const size = Number.parseInt(match[2], 10);
    const start = headerEnd + 1;
    const end = start + size;
    if (!Number.isSafeInteger(size) || output.length <= end || output[end] !== 0x0a) {
      throw new Error(`${label} received incomplete Git object bytes for ${entry.relative}`);
    }
    values.push(output.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== output.length) throw new Error(`${label} received unexpected trailing Git object data`);
  return values;
}

function workingMode(stat, indexedMode, fileModeSupported, symlinksSupported) {
  if (stat.isSymbolicLink()) return "120000";
  if (!stat.isFile()) return null;
  if (indexedMode === "120000" && !symlinksSupported) return "120000";
  if (!fileModeSupported) return indexedMode === "100755" ? "100755" : "100644";
  return (stat.mode & 0o100) === 0 ? "100644" : "100755";
}

function booleanConfig(repo, name, defaultValue, label) {
  const value = git(repo, ["config", "--bool", "--default", String(defaultValue), name], { label })
    .toString("utf8").trim();
  if (value !== "true" && value !== "false") {
    throw new Error(`${label} received an invalid ${name} value from Git`);
  }
  return value === "true";
}

/**
 * Hash a Git source tree as ordered path, canonical mode, and bytes records.
 * Index records use stage-zero modes and blob bytes. Working records use link
 * target bytes for symlinks and honor core.filemode for executable-bit noise.
 */
export function gitSourceTreeDigest(repo, options = {}) {
  const label = options.label ?? "Git source identity";
  const source = options.source ?? "working";
  if (source !== "working" && source !== "index") throw new Error(`${label} has an unsupported source`);
  if (source === "index" && options.includeUntracked) throw new Error(`${label} cannot include untracked index paths`);

  const indexed = indexEntries(repo, label);
  const entries = [...indexed.values()];
  if (source === "working" && options.includeUntracked) {
    const untracked = git(repo, ["ls-files", "--others", "--exclude-standard", "-z"], { label })
      .toString("utf8").split("\0").filter(Boolean);
    for (const relative of untracked) entries.push({ relative, mode: undefined, object: undefined });
  }
  entries.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);

  const indexedContent = source === "index" ? indexedBytes(repo, entries, label) : null;
  const fileModeSupported = source === "working"
    ? booleanConfig(repo, "core.filemode", true, label)
    : false;
  const symlinksSupported = source === "working"
    ? booleanConfig(repo, "core.symlinks", true, label)
    : false;
  const digest = createHash("sha256");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    let mode = entry.mode;
    let bytes = indexedContent?.[index];
    if (source === "working") {
      const file = path.join(repo, entry.relative);
      let stat;
      try {
        stat = fs.lstatSync(file);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      mode = workingMode(stat, entry.mode, fileModeSupported, symlinksSupported);
      if (!mode) throw new Error(`${label} contains a non-file Git path at ${file}`);
      bytes = mode === "120000" && stat.isSymbolicLink()
        ? Buffer.from(fs.readlinkSync(file))
        : fs.readFileSync(file);
    }
    const normalized = options.transformBytes?.(entry.relative, bytes, { mode, source }) ?? bytes;
    digest.update(entry.relative);
    digest.update("\0");
    digest.update(mode);
    digest.update("\0");
    digest.update(normalized);
    digest.update("\0");
  }
  return { files: entries.length, sha256: digest.digest("hex") };
}
