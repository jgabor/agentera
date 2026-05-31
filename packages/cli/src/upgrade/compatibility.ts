import fs from "node:fs";
import path from "node:path";

import { isFile, pathExists } from "../core/paths.js";
import { NPX_BUNDLE_SENTINEL, isNpxBundleRoot } from "../core/sourceRoot.js";
import { BUNDLE_MARKER } from "../state/installRoot.js";
import { doctorRoots, loadSuiteVersion } from "./appModel.js";
import { resolveUpdateChannel, type ResolvedUpdateChannel, type ResolveUpdateChannelArgs } from "./channels.js";
import {
  classifyUpgradeOutcome,
  shouldIncludeCrossMajorPlanItems,
  type UpgradeOutcome,
} from "./versionResolution.js";

export { shouldIncludeCrossMajorPlanItems } from "./versionResolution.js";

/**
 * v2/v3 install layout detection and cross-major upgrade guard rails.
 * Authority: references/cli/app-lifecycle-vocabulary.yaml (major_boundary_crossing)
 */

export const MAJOR_BOUNDARY_ITEM_TAG = "requires_explicit_major_opt_in";
export const STATUS_MANUAL_REVIEW_NEEDED = "manual_review_needed";
export const STATUS_NO_CHANGES_NEEDED = "no_changes_needed";
export const STATUS_READY_TO_APPLY = "ready_to_apply";
export const STATUS_APPLIED = "applied";
export const UPGRADE_PREVIEW_SCHEMA = "agentera.upgrade.v2";
export const STATUS_CONCEPT_MAJOR_BOUNDARY = "major_boundary_crossing";

export type InstallKind =
  | "v2_managed_app_home"
  | "v3_self_contained_npm"
  | "source_checkout"
  | "unknown_foreign";

export interface InstallSignals {
  bundleMarkerAtActiveRoot: boolean;
  agenteraScriptAtActiveRoot: boolean;
  skillAtActiveRoot: boolean;
  npxBundleSentinelAtSourceRoot: boolean;
  npxBundleSentinelAtActiveRoot: boolean;
  gitAtSourceRoot: boolean;
  skillAtSourceRoot: boolean;
  registryAtSourceRoot: boolean;
}

export interface InstallClassification {
  kind: InstallKind;
  appHome: string;
  activeBundleRoot: string;
  managedAppRoot: string;
  sourceRoot: string;
  signals: InstallSignals;
}

export interface CrossMajorPlanItem {
  phase: "artifacts" | "runtime" | "cleanup";
  verb: "migrate";
  name: string;
  statusConcept: typeof STATUS_CONCEPT_MAJOR_BOUNDARY;
  tag: typeof MAJOR_BOUNDARY_ITEM_TAG;
  lifecycleStatus: typeof STATUS_MANUAL_REVIEW_NEEDED;
}

export interface UpgradePreviewPhase {
  name: string;
  items: CrossMajorPlanItem[];
}

export interface UpgradePreviewV2 {
  schemaVersion: typeof UPGRADE_PREVIEW_SCHEMA;
  lifecycleStatus:
    | typeof STATUS_MANUAL_REVIEW_NEEDED
    | typeof STATUS_NO_CHANGES_NEEDED
    | typeof STATUS_READY_TO_APPLY;
  channel: ResolvedUpdateChannel;
  install: InstallClassification;
  upgradeOutcome: UpgradeOutcome;
  crossMajorBoundary: boolean;
  phases: UpgradePreviewPhase[];
}

export interface ClassifyInstallArgs {
  appHome: string;
  sourceRoot: string;
}

export interface PreviewCrossMajorGuardArgs extends ResolveUpdateChannelArgs {
  appHome: string;
  sourceRoot: string;
  catalog?: import("./versionResolution.js").VersionCatalog | null;
}

const CROSS_MAJOR_ITEMS: ReadonlyArray<Omit<CrossMajorPlanItem, "statusConcept" | "tag" | "lifecycleStatus">> = [
  { phase: "artifacts", verb: "migrate", name: "v2_to_v3_artifacts" },
  { phase: "runtime", verb: "migrate", name: "v2_to_v3_runtime_rewire" },
  { phase: "cleanup", verb: "migrate", name: "v2_to_v3_app_home_cleanup" },
];

function hasBundleRootEvidence(root: string): boolean {
  return (
    isFile(path.join(root, "scripts", "agentera")) &&
    isFile(path.join(root, "skills", "agentera", "SKILL.md"))
  );
}

function isSourceCheckoutRoot(sourceRoot: string): boolean {
  return (
    pathExists(path.join(sourceRoot, ".git")) &&
    isFile(path.join(sourceRoot, "skills", "agentera", "SKILL.md")) &&
    isFile(path.join(sourceRoot, "registry.json")) &&
    !isNpxBundleRoot(sourceRoot)
  );
}

function readSignals(appHome: string, sourceRoot: string, activeBundleRoot: string): InstallSignals {
  return {
    bundleMarkerAtActiveRoot: isFile(path.join(activeBundleRoot, BUNDLE_MARKER)),
    agenteraScriptAtActiveRoot: isFile(path.join(activeBundleRoot, "scripts", "agentera")),
    skillAtActiveRoot: isFile(path.join(activeBundleRoot, "skills", "agentera", "SKILL.md")),
    npxBundleSentinelAtSourceRoot: isFile(path.join(sourceRoot, NPX_BUNDLE_SENTINEL)),
    npxBundleSentinelAtActiveRoot: isFile(path.join(activeBundleRoot, NPX_BUNDLE_SENTINEL)),
    gitAtSourceRoot: pathExists(path.join(sourceRoot, ".git")),
    skillAtSourceRoot: isFile(path.join(sourceRoot, "skills", "agentera", "SKILL.md")),
    registryAtSourceRoot: isFile(path.join(sourceRoot, "registry.json")),
  };
}

function hasV2ManagedEvidence(signals: InstallSignals, activeBundleRoot: string): boolean {
  return (
    (signals.bundleMarkerAtActiveRoot || signals.agenteraScriptAtActiveRoot) &&
    hasBundleRootEvidence(activeBundleRoot) &&
    !signals.npxBundleSentinelAtActiveRoot
  );
}

export function cliDistributionMajor(sourceRoot: string): number {
  if (isSourceCheckoutRoot(sourceRoot)) {
    return 3;
  }
  if (isNpxBundleRoot(sourceRoot)) {
    return 3;
  }
  const version = loadSuiteVersion(sourceRoot);
  if (version) {
    const major = Number.parseInt(version.split(".")[0] ?? "", 10);
    if (Number.isFinite(major) && major > 0) {
      return major;
    }
  }
  return 2;
}

export function classifyInstall(args: ClassifyInstallArgs): InstallClassification {
  const appHome = args.appHome;
  const sourceRoot = args.sourceRoot;
  const roots = doctorRoots(appHome);
  const activeBundleRoot = roots.activeBundleRoot;
  const signals = readSignals(appHome, sourceRoot, activeBundleRoot);

  if (isNpxBundleRoot(sourceRoot) || isNpxBundleRoot(activeBundleRoot) || isNpxBundleRoot(appHome)) {
    return {
      kind: "v3_self_contained_npm",
      appHome,
      activeBundleRoot,
      managedAppRoot: roots.managedAppRoot,
      sourceRoot,
      signals,
    };
  }

  if (hasV2ManagedEvidence(signals, activeBundleRoot)) {
    return {
      kind: "v2_managed_app_home",
      appHome,
      activeBundleRoot,
      managedAppRoot: roots.managedAppRoot,
      sourceRoot,
      signals,
    };
  }

  if (isSourceCheckoutRoot(sourceRoot)) {
    return {
      kind: "source_checkout",
      appHome,
      activeBundleRoot,
      managedAppRoot: roots.managedAppRoot,
      sourceRoot,
      signals,
    };
  }

  return {
    kind: "unknown_foreign",
    appHome,
    activeBundleRoot,
    managedAppRoot: roots.managedAppRoot,
    sourceRoot,
    signals,
  };
}

export function crossMajorBoundaryApplies(install: InstallClassification, sourceRoot: string): boolean {
  return install.kind === "v2_managed_app_home" && cliDistributionMajor(sourceRoot) >= 3;
}

function taggedCrossMajorItems(): CrossMajorPlanItem[] {
  return CROSS_MAJOR_ITEMS.map((item) => ({
    ...item,
    statusConcept: STATUS_CONCEPT_MAJOR_BOUNDARY,
    tag: MAJOR_BOUNDARY_ITEM_TAG,
    lifecycleStatus: STATUS_MANUAL_REVIEW_NEEDED,
  }));
}

function groupItemsByPhase(items: CrossMajorPlanItem[]): UpgradePreviewPhase[] {
  const order = ["detect", "artifacts", "runtime", "cleanup"] as const;
  const byPhase = new Map<string, CrossMajorPlanItem[]>();
  for (const item of items) {
    const list = byPhase.get(item.phase) ?? [];
    list.push(item);
    byPhase.set(item.phase, list);
  }
  const phases: UpgradePreviewPhase[] = [{ name: "detect", items: [] }];
  for (const name of order) {
    if (name === "detect") {
      continue;
    }
    const phaseItems = byPhase.get(name) ?? [];
    if (phaseItems.length > 0) {
      phases.push({ name, items: phaseItems });
    }
  }
  return phases;
}

export function collectV3MigrationOperations(preview: UpgradePreviewV2): CrossMajorPlanItem[] {
  const out: CrossMajorPlanItem[] = [];
  for (const phase of preview.phases) {
    for (const item of phase.items) {
      if (item.verb === "migrate" && item.tag === MAJOR_BOUNDARY_ITEM_TAG) {
        out.push(item);
      }
    }
  }
  return out;
}

export function previewCrossMajorGuard(args: PreviewCrossMajorGuardArgs): UpgradePreviewV2 {
  const channel = resolveUpdateChannel(args);
  const install = classifyInstall({ appHome: args.appHome, sourceRoot: args.sourceRoot });
  const crossMajorBoundary = crossMajorBoundaryApplies(install, args.sourceRoot);
  const upgradeOutcome = classifyUpgradeOutcome({
    appHome: args.appHome,
    sourceRoot: args.sourceRoot,
    install,
    channel,
    catalog: args.catalog,
  });

  const items = shouldIncludeCrossMajorPlanItems(channel, upgradeOutcome)
    ? taggedCrossMajorItems()
    : [];

  let lifecycleStatus:
    | typeof STATUS_MANUAL_REVIEW_NEEDED
    | typeof STATUS_NO_CHANGES_NEEDED
    | typeof STATUS_READY_TO_APPLY;

  if (!crossMajorBoundary) {
    lifecycleStatus = STATUS_NO_CHANGES_NEEDED;
  } else if (!shouldIncludeCrossMajorPlanItems(channel, upgradeOutcome)) {
    lifecycleStatus = STATUS_MANUAL_REVIEW_NEEDED;
  } else {
    lifecycleStatus = STATUS_MANUAL_REVIEW_NEEDED;
  }

  return {
    schemaVersion: UPGRADE_PREVIEW_SCHEMA,
    lifecycleStatus,
    channel,
    install,
    upgradeOutcome,
    crossMajorBoundary,
    phases: groupItemsByPhase(items),
  };
}

export function foreignLayoutHasUnexpectedEntries(root: string): boolean {
  if (!pathExists(root)) {
    return false;
  }
  try {
    return fs.readdirSync(root).some((entry) => entry !== ".gitkeep");
  } catch {
    return false;
  }
}
