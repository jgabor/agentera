import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildDoctorStatus } from "../../../upgrade/doctor.js";
import { loadSuiteVersion, resolveDoctorInstallRoot, resolveSourceRootStrict } from "../../../upgrade/appModel.js";
import { isNpxBundleRoot } from "../../../core/sourceRoot.js";
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

function visibleSkillVersion(home: string, env: Env): [string | null, string | null] {
  const candidates: string[] = [];
  if (env.AGENTERA_VISIBLE_SKILL_ROOT) candidates.push(env.AGENTERA_VISIBLE_SKILL_ROOT);
  candidates.push(path.join(home, ".agents", "skills", "agentera"));
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

function hejExpectedVersion(opts: PrimeOpts, sourceRoot: string, home: string, env: Env): [string | null, string] {
  if (opts.expectedVersion) return [opts.expectedVersion, "--expected-version"];
  if (env.AGENTERA_EXPECTED_VERSION) return [env.AGENTERA_EXPECTED_VERSION, "AGENTERA_EXPECTED_VERSION"];
  const sourceVersion = loadSuiteVersion(sourceRoot);
  const [visibleVersion, visibleSource] = visibleSkillVersion(home, env);
  if (visibleVersion && versionKeyGe(versionKey(visibleVersion), versionKey(sourceVersion))) {
    return [visibleVersion, visibleSource || "visible skill"];
  }
  return [sourceVersion, "source registry"];
}

export function hejBundleStatus(opts: PrimeOpts): BundleStatus {
  const env = opts.env ?? process.env;
  const home = opts.home ? opts.home : os.homedir();
  const sourceRoot = resolveSourceRootStrict(env);
  const [installRoot, rootSource] = resolveDoctorInstallRoot(opts.installRoot ?? null, {
    home,
    env,
    sourceRoot,
  });
  const [expected, expectedSource] = hejExpectedVersion(opts, sourceRoot, home, env);
  const status = buildDoctorStatus(installRoot, {
    rootSource,
    sourceRoot,
    home,
    project: process.cwd(),
    expectedVersion: expected,
    expectedCommands: ["prime"],
    probeCli: false,
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
