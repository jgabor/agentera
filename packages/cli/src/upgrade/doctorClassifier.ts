import path from "node:path";

import type { Classification } from "../state/installRoot.js";
import type { DoctorSignal } from "../cli/contracts/bundleStatus.js";
import type { DoctorRoots } from "./appModel.js";
import {
  APP_MANUAL_REVIEW_NEEDED,
  APP_MIGRATION_NEEDED,
  APP_OUTDATED,
  APP_REPAIR_NEEDED,
} from "./doctor.js";

/** Install-root kinds produced by classifyResolvedRoot. */
export type InstallRootKind =
  | "missing_default"
  | "missing_explicit_or_environment"
  | "file_valued_root"
  | "invalid_bundle"
  | "unmanaged_directory"
  | "managed_fresh"
  | "managed_stale";

export interface ClassifierContext {
  installRoot: string;
  rootSource: string;
  roots: DoctorRoots;
  classification: Classification;
  expected: string;
  markerVersion: string | null;
  recoverableStaleDefault: boolean;
  legacyBundleRoot: boolean;
  userDataOnly: boolean;
  project: string;
  expectedCommands: readonly string[];
}

export interface ClassifierResult {
  rootStatus: string;
  signals: DoctorSignal[];
  blocked: boolean;
}

function blockedRootRecoveryMessage(_rootSource: string): string {
  return "choose a different Agentera directory, or use --force only if you checked this directory and want Agentera to replace files there";
}

function recoverableStaleDefaultSignal(appHome: string, roots: DoctorRoots): DoctorSignal {
  return {
    status: APP_REPAIR_NEEDED,
    kind: "recoverable_stale_default",
    message:
      "Agentera found an old app directory and can repair it without asking you to edit shell settings",
    deprecatedDefaultAppHome: appHome,
    managedAppRoot: roots.managedAppRoot,
  };
}

function userDataOnlySignal(appHome: string, roots: DoctorRoots): DoctorSignal {
  return {
    status: APP_REPAIR_NEEDED,
    kind: "user_data_only_app_home",
    message:
      "This Agentera directory only has your Agentera data, so Agentera can safely add fresh app files under app/",
    appHome,
    managedAppRoot: roots.managedAppRoot,
  };
}

function classifyMissingDefault(_ctx: ClassifierContext): ClassifierResult {
  return {
    rootStatus: "missing",
    blocked: false,
    signals: [
      {
        status: APP_REPAIR_NEEDED,
        kind: "missing_bundle",
        message: "Agentera is not installed in the normal directory yet",
      },
    ],
  };
}

function classifyMissingExplicitOrEnvironment(ctx: ClassifierContext): ClassifierResult {
  if (ctx.recoverableStaleDefault) {
    return {
      rootStatus: "missing",
      blocked: false,
      signals: [recoverableStaleDefaultSignal(ctx.installRoot, ctx.roots)],
    };
  }
  return {
    rootStatus: "missing",
    blocked: true,
    signals: [
      {
        status: APP_MANUAL_REVIEW_NEEDED,
        kind: "invalid_install_root",
        message:
          "Agentera was told to use a directory that does not exist. " +
          "Choose an existing Agentera directory, or install into the normal Agentera directory.",
      },
    ],
  };
}

function classifyFileValuedRoot(ctx: ClassifierContext): ClassifierResult {
  return {
    rootStatus: "invalid",
    blocked: true,
    signals: [
      {
        status: APP_MANUAL_REVIEW_NEEDED,
        kind: "invalid_install_root",
        message: `Agentera was told to use a file instead of a directory; ${blockedRootRecoveryMessage(ctx.rootSource)}`,
      },
    ],
  };
}

function classifyInvalidBundle(ctx: ClassifierContext): ClassifierResult {
  if (ctx.recoverableStaleDefault) {
    return {
      rootStatus: "stale_default",
      blocked: false,
      signals: [recoverableStaleDefaultSignal(ctx.installRoot, ctx.roots)],
    };
  }
  return {
    rootStatus: "invalid",
    blocked: true,
    signals: [
      {
        status: APP_MANUAL_REVIEW_NEEDED,
        kind: "invalid_bundle",
        message: `This directory looks like a broken Agentera install; ${blockedRootRecoveryMessage(ctx.rootSource)}`,
      },
    ],
  };
}

function classifyUnmanagedDirectory(ctx: ClassifierContext): ClassifierResult {
  if (ctx.recoverableStaleDefault) {
    return {
      rootStatus: "stale_default",
      blocked: false,
      signals: [recoverableStaleDefaultSignal(ctx.installRoot, ctx.roots)],
    };
  }
  if (ctx.userDataOnly) {
    return {
      rootStatus: "user_data_only",
      blocked: false,
      signals: [userDataOnlySignal(ctx.installRoot, ctx.roots)],
    };
  }
  return {
    rootStatus: "unmanaged",
    blocked: true,
    signals: [
      {
        status: APP_MANUAL_REVIEW_NEEDED,
        kind: "unmanaged_install_root",
        message: `This directory already has files Agentera does not recognize, so Agentera will not change it automatically; ${blockedRootRecoveryMessage(ctx.rootSource)}`,
      },
    ],
  };
}

function appendManagedStaleSignals(ctx: ClassifierContext, signals: DoctorSignal[]): void {
  const reason = ctx.classification.diagnostic.evidence.reason;
  if (ctx.classification.kind !== "managed_stale") {
    return;
  }
  if (reason === "missing_marker") {
    if (ctx.recoverableStaleDefault) {
      signals.push(recoverableStaleDefaultSignal(ctx.installRoot, ctx.roots));
    }
    signals.push({
      status: APP_REPAIR_NEEDED,
      kind: "missing_marker",
      message: "Agentera app files need repair",
    });
  } else if (reason === "version_mismatch") {
    if (ctx.recoverableStaleDefault) {
      signals.push(recoverableStaleDefaultSignal(ctx.installRoot, ctx.roots));
    }
    signals.push({
      status: APP_OUTDATED,
      kind: "version_mismatch",
      expected: ctx.expected,
      actual: ctx.markerVersion,
      message: "Agentera app files are valid but need an update to the expected version",
    });
  }
}

function classifyManaged(ctx: ClassifierContext): ClassifierResult {
  const signals: DoctorSignal[] = [];
  if (ctx.legacyBundleRoot) {
    signals.push({
      status: APP_MIGRATION_NEEDED,
      kind: APP_MIGRATION_NEEDED,
      message: "Agentera app files are in the old place and can be moved into app/",
      legacyAppRoot: ctx.installRoot,
      managedAppRoot: ctx.roots.managedAppRoot,
    });
  }
  appendManagedStaleSignals(ctx, signals);
  return {
    rootStatus: "managed",
    blocked: false,
    signals,
  };
}

const ROOT_CLASSIFIERS: Record<InstallRootKind, (ctx: ClassifierContext) => ClassifierResult> = {
  missing_default: classifyMissingDefault,
  missing_explicit_or_environment: classifyMissingExplicitOrEnvironment,
  file_valued_root: classifyFileValuedRoot,
  invalid_bundle: classifyInvalidBundle,
  unmanaged_directory: classifyUnmanagedDirectory,
  managed_fresh: classifyManaged,
  managed_stale: classifyManaged,
};

export function classifyInstallRootStatus(ctx: ClassifierContext): ClassifierResult {
  const kind = ctx.classification.kind as InstallRootKind;
  const classifier = ROOT_CLASSIFIERS[kind] ?? classifyManaged;
  return classifier(ctx);
}
