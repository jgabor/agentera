import { expanduser } from "../core/paths.js";
import { resolvePlatformAppHome } from "./appModel.js";
import { buildDoctorStatus, type BuildDoctorStatusOptions } from "./doctor.js";
import type { BundleStatus } from "../cli/contracts/bundleStatus.js";

export interface ResolveNpxPlatformStatusOptions {
  home: string;
  sourceRoot: string;
  project: string;
  env?: Record<string, string | undefined>;
  expectedVersion?: string | null;
  expectedCommands?: readonly string[];
}

export interface NpxPlatformStatusResult {
  platformRoot: string;
  platformStatus: BundleStatus;
}

/** Shared npx platform app-home resolution for prime and projectIntegration. */
export function resolveNpxPlatformStatus(
  opts: ResolveNpxPlatformStatusOptions,
): NpxPlatformStatusResult {
  const env = { ...process.env, ...(opts.env ?? {}), HOME: expanduser(opts.home) };
  const platformRoot = resolvePlatformAppHome(opts.home, env);
  const doctorOpts: BuildDoctorStatusOptions = {
    rootSource: "default",
    sourceRoot: opts.sourceRoot,
    home: opts.home,
    project: opts.project,
    expectedCommands: opts.expectedCommands ?? ["prime"],
    skipNpxBundleShortCircuit: true,
    env,
  };
  if (opts.expectedVersion !== undefined) {
    doctorOpts.expectedVersion = opts.expectedVersion;
  }
  const platformStatus = buildDoctorStatus(platformRoot, doctorOpts);
  return { platformRoot, platformStatus };
}
