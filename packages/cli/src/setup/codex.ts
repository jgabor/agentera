/**
 * Codex config parsing and hook-trust helpers. The setup path only injects
 * AGENTERA_HOME; native descriptors and dispatch settings are retired.
 */

export * from "./codex/constants.js";
export * from "./codex/installRoot.js";
export * from "./codex/configToml.js";
export * from "./codex/state.js";
export { codexMain, type CodexCliIo } from "./codex/cli.js";
