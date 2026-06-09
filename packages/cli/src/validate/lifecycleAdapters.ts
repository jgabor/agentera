import path from "node:path";

import { resolvePath } from "../core/paths.js";
import {
  RegistryError,
  RuntimeAdapterRegistry,
  loadRegistry as loadRuntimeRegistry,
} from "../registries/runtimeAdapterRegistry.js";
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
  validateCodexProfileraMetadata,
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
  validateCodexProfileraMetadata,
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

export function lifecycleMain(opts: LifecycleMainOptions = {}): number {
  const root = resolvePath(opts.root ?? rootDefault());
  const out = opts.out ?? ((line: string) => process.stdout.write(line + "\n"));
  const errors: string[] = [];
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

  const copilot = loadJson(path.join(root, "plugin.json"));
  errors.push(...validateCopilot(copilot, root, reg));
  errors.push(...validateCopilotHooks(root, copilot, reg));
  const cursorPlugin = loadJson(path.join(root, ".cursor-plugin/plugin.json"));
  errors.push(...validateCursor(root, cursorPlugin, reg));
  errors.push(...validateCursorHooks(root, reg));
  const codex = loadJson(path.join(root, ".codex-plugin/plugin.json"));
  errors.push(...validateCodex(codex, reg));
  errors.push(...validateCodexProfileraMetadata(root, codex));
  errors.push(...validateOpencode(root, reg));
  const packageManifestReg = packageManifest(root);
  errors.push(...validateSuiteBundleSurface(root, null, packageManifestReg));
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
