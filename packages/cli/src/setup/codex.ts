/**
 * Idempotently inject AGENTERA_HOME into Codex's shell-tool environment.
 * Faithful TS port of scripts/setup_codex.py. Implementation is split across
 * `setup/codex/` by responsibility; this file preserves the original import path.
 */

export * from "./codex/constants.js";
export * from "./codex/installRoot.js";
export * from "./codex/configToml.js";
export * from "./codex/state.js";
export * from "./codex/agents.js";
export { codexMain, type CodexCliIo } from "./codex/cli.js";
