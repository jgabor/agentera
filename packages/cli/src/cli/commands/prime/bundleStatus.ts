import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildDoctorStatus } from "../../../upgrade/doctor.js";
import { doctorRoots, loadSuiteVersion, resolveDoctorInstallRoot, resolveSourceRootStrict } from "../../../upgrade/appModel.js";
import { isNpxBundleRoot } from "../../../core/sourceRoot.js";
import { resolveInvokedUpdateChannel, type ResolvedUpdateChannel } from "../../../upgrade/channels.js";
import { classifyResolvedRoot } from "../../../state/installRoot.js";
import { resolveLatestOnChannel } from "../../../upgrade/versionResolution.js";
import { resolveNpxPlatformStatus } from "../../../upgrade/npxPlatformStatus.js";
import type { BundleStatus } from "../../contracts/bundleStatus.js";
import type { Env, PrimeOpts } from "./types.js";

function frontmatterVersion(p: string): string | null {
  let lines: string[];
  try {
    if (!fs.statSync(p).isFile()) return null;
    lines = fs.readFileSync(p, "utf8").split(/\r\n|\r|\n/);
  } catch {
    return null;
  }
  if (lines.length === 0 || lines[0].trim() !== "---") return null;
  for (const line of lines.slice(1)) {
    const stripped = line.trim();
    if (stripped === "---") return null;
    if (stripped.startsWith("version:")) {
      const version = stripped.split(":", 2)[1].trim().replace(/^["']|["']$/g, "");
      return version || null;
    }
  }
  return null;
}

function versionKey(version: string | null): number[] {
  if (!version) return [];
  const parts: number[] = [];
  for (const item of version.split(/[.+_-]/)) {
    if (/^\d+$/.test(item)) parts.push(parseInt(item, 10));
    else break;
  }
  return parts;
}

function versionKeyGe(a: number[], b: number[]): boolean {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  return true;
}

function visibleSkillVersion(
  home: string,
  env: Env,
  installRoot: string,
  sourceRoot: string,
): [string | null, string | null] {
  const candidates: string[] = [];
  if (env.AGENTERA_VISIBLE_SKILL_ROOT) candidates.push(env.AGENTERA_VISIBLE_SKILL_ROOT);
  candidates.push(path.join(installRoot, "skills", "agentera"));
  candidates.push(path.join(sourceRoot, "skills", "agentera"));
  candidates.push(path.join(home, ".config", "opencode", "skills", "agentera"));
  const versions: Array<[number[], string, string]> = [];
  for (const root of candidates) {
    const version = frontmatterVersion(path.join(root, "SKILL.md"));
    if (version) versions.push([versionKey(version), version, root]);
  }
  if (versions.length === 0) return [null, null];
  versions.sort((a, b) => (versionKeyGe(a[0], b[0]) ? -1 : 1));
  return [versions[0][1], versions[0][2]];
}

function statusExpectedVersion(
  opts: PrimeOpts,
  sourceRoot: string,
  home: string,
  env: Env,
  installRoot: string,
  channel: ResolvedUpdateChannel,
): [string | null, string] {
  if (opts.expectedVersion) return [opts.expectedVersion, "--expected-version"];
  if (env.AGENTERA_EXPECTED_VERSION) return [env.AGENTERA_EXPECTED_VERSION, "AGENTERA_EXPECTED_VERSION"];
  if (channel.channel === "stable") {
    const roots = doctorRoots(installRoot);
    const classification = classifyResolvedRoot(roots.activeBundleRoot, { source: "explicit" });
    if (classification.current_version) {
      return [classification.current_version, "installed app registry"];
    }
    return [resolveLatestOnChannel(channel, sourceRoot), "stable channel catalog"];
  }
  const sourceVersion = loadSuiteVersion(sourceRoot);
  const [visibleVersion, visibleSource] = visibleSkillVersion(home, env, installRoot, sourceRoot);
  if (visibleVersion && versionKeyGe(versionKey(visibleVersion), versionKey(sourceVersion))) {
    return [visibleVersion, visibleSource || "visible skill"];
  }
  return [sourceVersion, "source registry"];
}

export function statusBundleStatus(opts: PrimeOpts): BundleStatus {
  const env = opts.env ?? process.env;
  const home = opts.home ? opts.home : os.homedir();
  const sourceRoot = resolveSourceRootStrict(env);
  const channel = resolveInvokedUpdateChannel({ env, home, sourceRoot });
  const [installRoot, rootSource] = resolveDoctorInstallRoot(opts.installRoot ?? null, {
    home,
    env,
    sourceRoot,
  });
  const [expected, expectedSource] = statusExpectedVersion(opts, sourceRoot, home, env, installRoot, channel);
  const status = buildDoctorStatus(installRoot, {
    rootSource,
    sourceRoot,
    home,
    project: process.cwd(),
    expectedVersion: expected,
    expectedCommands: ["prime"],
    channel: channel.channel,
    env,
  });
  status.expectedVersionSource = expectedSource;
  if (isNpxBundleRoot(sourceRoot)) {
    const { platformRoot, platformStatus } = resolveNpxPlatformStatus({
      home,
      sourceRoot,
      project: process.cwd(),
      expectedVersion: expected,
      expectedCommands: ["prime"],
      env,
    });
    status.platformAppHome = {
      path: platformRoot,
      status: platformStatus.status,
      rootStatus: platformStatus.rootStatus,
      dryRunCommand: platformStatus.dryRunCommand,
      applyCommand: platformStatus.applyCommand,
    };
    status.cliApp = {
      path: sourceRoot,
      status: status.status,
      rootStatus: status.rootStatus,
    };
  }
  return status;
}
