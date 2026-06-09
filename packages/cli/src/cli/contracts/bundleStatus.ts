/** Doctor signal emitted in bundle status payloads. */
export interface DoctorSignal {
  status: string;
  kind: string;
  message?: string;
  expected?: string;
  actual?: string | null;
  returnCode?: number | null;
  missingCommands?: string[];
  stdoutTail?: string[];
  stderrTail?: string[];
  deprecatedDefaultAppHome?: string;
  managedAppRoot?: string;
  legacyBundleRoot?: string;
  appHome?: string;
}

/** Npx bundle platform app-home overlay on bundle status. */
export interface NpxPlatformAppHome {
  path: string;
  status: string;
  rootStatus: string;
  dryRunCommand: string | null;
  applyCommand: string | null;
}

/** Npx CLI bundle overlay on bundle status. */
export interface NpxCliBundle {
  path: string;
  status: string;
  rootStatus: string;
}

/** Internal doctor/buildDoctorStatus payload (includes install-root fields). */
export interface BundleStatus {
  schemaVersion: "agentera.bundleStatus.v1";
  status: string;
  expectedVersion: string;
  expectedVersionSource?: string;
  appHome: string;
  appHomeSource: string;
  managedAppRoot: string;
  userDataRoot: string;
  activeBundleRoot: string;
  authoritativeRoot: string;
  skillRoot: string;
  runtimeRoot: string;
  sourceRoot: string;
  installRoot: string;
  installRootSource: string;
  home: string;
  project: string;
  rootStatus: string;
  markerVersion: string | null;
  signals: DoctorSignal[];
  dryRunCommand: string | null;
  applyCommand: string | null;
  updateChannel?: string;
  crossMajorBoundary?: boolean;
  retryCommand: string;
  approval: string;
  platformAppHome?: NpxPlatformAppHome;
  cliBundle?: NpxCliBundle;
}

/** Public bundle status (install-root fields stripped for prime/doctor JSON). */
export type PublicBundleStatus = Omit<BundleStatus, "installRoot" | "installRootSource">;
