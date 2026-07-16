/**
 * Public re-export surface for lifecycle validation. The node-form checks, legacy
 * Python parity probes, and the orchestration entry (`lifecycleMain`) live in
 * dedicated modules under `./lifecycleAdapters/`. This barrel keeps the historical
 * import path (`../validate/lifecycleAdapters.js`) stable for consumers.
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

export {
  type LifecycleMainOptions,
  validateRuntimeIdParity,
  validateRuntimeConsumerWiring,
  lifecycleMain,
} from "./lifecycleAdapters/lifecycleMain.js";
