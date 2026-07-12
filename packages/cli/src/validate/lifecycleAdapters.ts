import fs from "node:fs";
import path from "node:path";

import { resolvePath } from "../core/paths.js";
import {
  RegistryError,
  RUNTIME_ADAPTER_CONSUMERS,
  RuntimeAdapterRegistry,
  loadRegistry as loadRuntimeRegistry,
} from "../registries/runtimeAdapterRegistry.js";
import {
  loadLifecycleAuthority,
  validateLifecycleAuthorityRoot,
} from "../runtime/lifecycleAuthority.js";
import {
  loadRuntimeLifecycleAdapterContract,
  validateRuntimeLifecycleAdapterContractRoot,
} from "../runtime/lifecycleAdapterContract.js";
import { validateRetiredRuntimeCleanupContractRoot } from "../runtime/retiredRuntimeCleanup.js";
import { parseSemverCore } from "../release/releaseMetadata.js";
import {
  type LegacyPythonParityOptions,
  LEGACY_PYTHON_PARITY_FLAG,
  legacyPythonParityEnabled,
  runLegacyPythonParityChecks,
  validatePackagedPythonScripts,
  validateUvRuntime,
} from "./lifecycleAdapters/legacyPythonParity.js";
import {
  validateCodex,
  validateCodexProfileMetadata,
  validateCopilot,
  validateCopilotHooks,
  validateCursor,
  validateCursorHooks,
  validateHardGateDocs,
  validateOpencode,
  validateSuiteBundleSurface,
} from "./lifecycleAdapters/nodeFormChecks.js";
import { loadJson, packageManifest, registryContractError, rootDefault } from "./lifecycleAdapters/shared.js";

/**
 * Validate runtime lifecycle hook adapter metadata (node-form default path).
 * Legacy packaged-Python-script and uv-binary probes run only when the maintainer
 * flag (`--legacy-python-parity` or `AGENTERA_LEGACY_PYTHON_PARITY`) is set.
 */

export {
  validateCodex,
  validateCodexProfileMetadata,
  validateCopilot,
  validateCopilotHooks,
  validateCursor,
  validateCursorHooks,
  validateHardGateDocs,
  validateOpencode,
  validateSuiteBundleSurface,
} from "./lifecycleAdapters/nodeFormChecks.js";

export {
  LEGACY_PYTHON_PARITY_ENV,
  LEGACY_PYTHON_PARITY_FLAG,
  legacyPythonParityEnabled,
  validatePackagedPythonScripts,
  validateUvRuntime,
} from "./lifecycleAdapters/legacyPythonParity.js";

export interface LifecycleMainOptions extends LegacyPythonParityOptions {
  root?: string;
  out?: (line: string) => void;
}

function sameMembers(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function validateRuntimeIdParity(
  activeIds: string[],
  adapterIds: string[],
  packageRuntimeIds: string[],
): string[] {
  const errors: string[] = [];
  if (!sameMembers(adapterIds, activeIds)) {
    errors.push(`runtime adapter registry IDs must match lifecycle authority: ${activeIds.join(", ")}`);
  }
  if (!sameMembers(packageRuntimeIds, activeIds)) {
    errors.push(`runtime package manifests must cover lifecycle authority exactly: ${activeIds.join(", ")}`);
  }
  return errors;
}

/** Every active runtime must remain addressable through every declared consumer view. */
export function validateRuntimeConsumerWiring(
  activeIds: string[],
  registry: RuntimeAdapterRegistry,
): string[] {
  const errors: string[] = [];
  for (const runtimeId of activeIds) {
    for (const consumer of RUNTIME_ADAPTER_CONSUMERS) {
      try {
        const view = registry.consumerView(consumer, runtimeId);
        const identity = view.identity as Record<string, unknown> | undefined;
        if (identity?.runtime_id !== runtimeId) {
          errors.push(`${runtimeId}: ${consumer} consumer wiring resolved the wrong runtime identity`);
        }
      } catch {
        errors.push(`${runtimeId}: missing ${consumer} consumer wiring`);
      }
    }
  }
  return errors;
}

function bundleCovers(relativePath: string, directories: string[], files: Set<string>): boolean {
  if (files.has(relativePath)) return true;
  return directories.some((directory) => {
    const relative = path.relative(directory, relativePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function validateReleaseRuntimeParity(root: string, registry: RuntimeAdapterRegistry): string[] {
  const errors: string[] = [];
  const authority = loadLifecycleAuthority(path.join(root, "references/adapters/runtime-lifecycle-authority.yaml"));
  const activeIds = authority.runtimes.map((runtime) => runtime.id);
  for (const runtime of authority.runtimes) {
    const record = registry.records.find((candidate) =>
      (candidate.identity as Record<string, unknown>).runtime_id === runtime.id);
    const displayName = (record?.identity as Record<string, unknown> | undefined)?.display_name;
    if (displayName !== runtime.displayName) {
      errors.push(`${runtime.id}: runtime adapter display name must match lifecycle authority (${runtime.displayName})`);
    }
  }

  const packageRegistry = packageManifest(root);
  const packageRuntimeIds = Object.keys(packageRegistry.runtimeManifestPaths());
  errors.push(...validateRuntimeIdParity(activeIds, registry.adapterIds, packageRuntimeIds));
  errors.push(...validateRuntimeConsumerWiring(activeIds, registry));
  const suiteVersion = packageRegistry.suiteVersion();
  for (const [surface, version] of Object.entries(packageRegistry.versionSurfaceValues())) {
    const developmentPackage = surface === "cli-package";
    const parsed = typeof version === "string" ? parseSemverCore(version) : null;
    const matchesSuite = version === suiteVersion || (
      developmentPackage && parsed?.core === suiteVersion && parsed.preRelease !== null
    );
    if (!matchesSuite) {
      errors.push(`${surface}: version ${String(version)} must match suite version ${suiteVersion}`);
    }
  }

  const packageRecord = packageRegistry.get();
  const bundleSurfaces = packageRecord.bundle_surfaces as {
    directories: Array<{ path: string }>;
    files: Array<{ path: string }>;
  };
  const directories = bundleSurfaces.directories.map((entry) => entry.path);
  const files = new Set<string>(bundleSurfaces.files.map((entry) => entry.path));
  const lifecycle = loadRuntimeLifecycleAdapterContract(
    path.join(root, "references/adapters/runtime-lifecycle-adapters.yaml"),
    authority,
  );
  for (const resource of lifecycle.resources) {
    const prefix = "{source_root}/";
    if (!resource.source.startsWith(prefix)) continue;
    const source = resource.source.slice(prefix.length);
    if (!bundleCovers(source, directories, files)) {
      errors.push(`${resource.id}: lifecycle source ${source} is absent from npm bundle surfaces`);
    }
  }
  for (const manifestPath of Object.values(packageRegistry.runtimeManifestPaths())) {
    if (!bundleCovers(manifestPath, directories, files)) {
      errors.push(`runtime package manifest ${manifestPath} is absent from npm bundle surfaces`);
    }
  }
  if (fs.existsSync(path.join(root, ".claude-plugin", "marketplace.json"))) {
    errors.push("retired Claude marketplace manifest must be absent");
  }
  return errors;
}

export function lifecycleMain(opts: LifecycleMainOptions = {}): number {
  const root = resolvePath(opts.root ?? rootDefault());
  const out = opts.out ?? ((line: string) => process.stdout.write(line + "\n"));
  const errors: string[] = [
    ...validateLifecycleAuthorityRoot(root),
    ...validateRuntimeLifecycleAdapterContractRoot(root),
    ...validateRetiredRuntimeCleanupContractRoot(root),
  ];
  let registry: RuntimeAdapterRegistry | null = null;
  try {
    registry = loadRuntimeRegistry(path.join(root, "references/adapters/runtime-adapter-registry.yaml"));
  } catch (exc) {
    if (exc instanceof RegistryError || exc instanceof Error) {
      errors.push(registryContractError(exc as Error));
    } else {
      throw exc;
    }
  }

  if (errors.length > 0) {
    out("lifecycle adapter validation failed:");
    for (const error of errors) out(`- ${error}`);
    return 1;
  }
  const reg = registry as RuntimeAdapterRegistry;
  errors.push(...validateReleaseRuntimeParity(root, reg));

  const copilot = loadJson(path.join(root, "plugin.json"));
  errors.push(...validateCopilot(copilot, root, reg));
  errors.push(...validateCopilotHooks(root, copilot, reg));
  const cursorPlugin = loadJson(path.join(root, ".cursor-plugin/plugin.json"));
  errors.push(...validateCursor(root, cursorPlugin, reg));
  errors.push(...validateCursorHooks(root, reg));
  const codex = loadJson(path.join(root, ".codex-plugin/plugin.json"));
  errors.push(...validateCodex(codex, reg));
  errors.push(...validateCodexProfileMetadata(root, codex));
  errors.push(...validateOpencode(root, reg));
  const packageManifestReg = packageManifest(root);
  const authority = loadLifecycleAuthority(path.join(root, "references/adapters/runtime-lifecycle-authority.yaml"));
  errors.push(...validateSuiteBundleSurface(
    root,
    new Set(authority.runtimes.map((runtime) => runtime.id)),
    packageManifestReg,
  ));
  if (legacyPythonParityEnabled(opts)) {
    errors.push(...runLegacyPythonParityChecks(root));
  }
  errors.push(...validateHardGateDocs(root, reg));

  if (errors.length > 0) {
    out("lifecycle adapter validation failed:");
    for (const error of errors) out(`- ${error}`);
    return 1;
  }
  out("lifecycle adapter metadata ok");
  return 0;
}
