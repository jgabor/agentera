import type { InstallKind } from "../../upgrade/compatibility.js";

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
  legacyAppRoot?: string;
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

/** Npx CLI app overlay on bundle status. */
export interface NpxCliApp {
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
  activeAppRoot: string;
  authoritativeRoot: string;
  skillRoot: string;
  runtimeRoot: string;
  sourceRoot: string;
  installRoot: string;
  installRootSource: string;
  home: string;
  project: string;
  rootStatus: string;
  installKind: InstallKind;
  markerVersion: string | null;
  signals: DoctorSignal[];
  dryRunCommand: string | null;
  applyCommand: string | null;
  updateChannel?: string;
  /** App major differs from CLI major (independent of successor announcement). */
  crossMajorBoundaryDetected?: boolean;
  /** Cross-major boundary detected and the successor line is announced. */
  crossMajorBoundary?: boolean;
  retryCommand: string | null;
  approval: string;
  platformAppHome?: NpxPlatformAppHome;
  cliApp?: NpxCliApp;
}

/** Public npx platform app-home overlay (rootStatus stripped). */
export type PublicNpxPlatformAppHome = Omit<NpxPlatformAppHome, "rootStatus">;

/** Public npx CLI app overlay (rootStatus stripped). */
export type PublicNpxCliApp = Omit<NpxCliApp, "rootStatus">;

/** Public bundle status (install-root, install-kind, and rootStatus fields stripped for prime/doctor JSON). */
export type PublicBundleStatus = Omit<BundleStatus, "installRoot" | "installRootSource" | "installKind" | "rootStatus" | "platformAppHome" | "cliApp"> & {
  platformAppHome?: PublicNpxPlatformAppHome;
  cliApp?: PublicNpxCliApp;
};
