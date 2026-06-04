import { splitLinesKeepEnds, unifiedDiff } from "../../core/difflib.js";
import {
  CODEX_HOOK_COMMAND,
  MANAGED_KEY,
  SECTION_NAME,
} from "./constants.js";
import {
  classifyToml,
  emitSetInlineTable,
  ensureCodexAgentLimits,
  ensureCodexHookTrust,
  ensureCodexPluginHookTrust,
  hasInlineSetLine,
  hasSetSubtableHeader,
  insertSetLine,
  needsShellEnvNormalize,
  normalizeShellEnvironmentPolicy,
  renderFreshConfig,
  rewriteSetLine,
  TomlState,
} from "./configToml.js";

export interface Outcome {
  action: string;
  newText: string;
  message: string;
  diff: string;
}

export interface PlanChangeOptions {
  force: boolean;
  hooksPath?: string | null;
  hookCommand?: string;
  pluginHooks?: boolean;
}

function unifiedDiffText(before: string, after: string): string {
  return unifiedDiff(
    splitLinesKeepEnds(before),
    splitLinesKeepEnds(after),
    "config.toml (current)",
    "config.toml (proposed)",
    "",
    "",
    3,
  ).join("");
}

function conflictDiffText(currentTable: Record<string, string>, mergedTable: Record<string, string>): string {
  const currentInline = emitSetInlineTable(currentTable);
  const mergedInline = emitSetInlineTable(mergedTable);
  return `current:  set = ${currentInline}\nproposed: set = ${mergedInline}\n`;
}

function withCodexHookTrust(
  outcome: Outcome,
  beforeText: string | null,
  hooksPath: string | null,
  hookCommand: string = CODEX_HOOK_COMMAND,
  pluginHooks = false,
): Outcome {
  if (outcome.action === "conflict") return outcome;
  const before = beforeText || "";

  let newText: string;
  try {
    newText = ensureCodexAgentLimits(outcome.newText);
  } catch (exc) {
    return {
      action: "conflict",
      newText: "",
      message: `cannot safely update Codex agent dispatch settings: ${(exc as Error).message}`,
      diff: "",
    };
  }

  if (newText !== outcome.newText) {
    const action = outcome.action !== "noop" ? outcome.action : "insert";
    const message =
      outcome.action === "noop"
        ? "would configure Codex agent dispatch limits"
        : `${outcome.message}; would configure Codex agent dispatch limits`;
    outcome = { action, newText, message, diff: unifiedDiffText(before, newText) };
  }

  if (hooksPath === null && !pluginHooks) return outcome;

  try {
    if (pluginHooks) {
      newText = ensureCodexPluginHookTrust(outcome.newText, CODEX_HOOK_COMMAND, hooksPath);
    } else if (hooksPath !== null) {
      newText = ensureCodexHookTrust(outcome.newText, hooksPath, hookCommand);
    } else {
      newText = outcome.newText;
    }
  } catch (exc) {
    return {
      action: "conflict",
      newText: "",
      message: `cannot safely update Codex hook trust state: ${(exc as Error).message}`,
      diff: "",
    };
  }

  if (newText === outcome.newText) return outcome;

  const action = outcome.action !== "noop" ? outcome.action : "insert";
  let message: string;
  if (outcome.action === "noop") {
    message = pluginHooks
      ? "would trust Codex plugin apply_patch hooks in config.toml"
      : "would trust Codex apply_patch hooks in config.toml";
  } else {
    const hookLabel = pluginHooks ? "Codex plugin apply_patch hooks" : "Codex apply_patch hooks";
    message = `${outcome.message}; would trust ${hookLabel}`;
  }
  return { action, newText, message, diff: unifiedDiffText(before, newText) };
}

function wrapOutcome(
  outcome: Outcome,
  currentText: string | null,
  hooksPath: string | null,
  hookCommand: string,
  pluginHooks: boolean,
): Outcome {
  return withCodexHookTrust(outcome, currentText, hooksPath, hookCommand, pluginHooks);
}

/** Branch: file absent or empty -> write fresh config. */
export function planFreshEmpty(
  currentText: string | null,
  installRoot: string,
  hooksPath: string | null,
  hookCommand: string,
  pluginHooks: boolean,
): Outcome {
  const desiredPath = installRoot;
  const newText = renderFreshConfig(installRoot);
  return wrapOutcome(
    {
      action: "fresh",
      newText,
      message: `would write fresh config with ${SECTION_NAME}.set.${MANAGED_KEY} = ${desiredPath}`,
      diff: unifiedDiffText("", newText),
    },
    currentText,
    hooksPath,
    hookCommand,
    pluginHooks,
  );
}

/** Branch: normalize shell_environment_policy layout when needed. */
export function planNormalize(
  currentText: string,
  installRoot: string,
  state: TomlState,
  hooksPath: string | null,
  hookCommand: string,
  pluginHooks: boolean,
): Outcome | null {
  const desiredPath = installRoot;
  if (!needsShellEnvNormalize(state, currentText)) return null;
  const canonical =
    state.sectionLevelHome === null &&
    hasInlineSetLine(currentText) &&
    !hasSetSubtableHeader(currentText) &&
    state.setTable[MANAGED_KEY] === desiredPath;
  if (canonical) return null;
  try {
    const newText = normalizeShellEnvironmentPolicy(currentText, installRoot);
    if (newText === currentText) return null;
    return wrapOutcome(
      {
        action: "normalize",
        newText,
        message: `would normalize [${SECTION_NAME}] to inline set = { ${MANAGED_KEY} = ${desiredPath} }`,
        diff: unifiedDiffText(currentText, newText),
      },
      currentText,
      hooksPath,
      hookCommand,
      pluginHooks,
    );
  } catch (exc) {
    return {
      action: "conflict",
      newText: "",
      message: `cannot normalize [${SECTION_NAME}] layout: ${(exc as Error).message}. Edit ~/.codex/config.toml manually.`,
      diff: "",
    };
  }
}

/** Branch: section absent -> append fresh section at EOF. */
export function planAppendSection(
  currentText: string,
  installRoot: string,
  hooksPath: string | null,
  hookCommand: string,
  pluginHooks: boolean,
): Outcome {
  const desiredPath = installRoot;
  let prefix = currentText;
  if (!prefix.endsWith("\n")) prefix += "\n";
  if (!prefix.endsWith("\n\n")) prefix += "\n";
  const newText = prefix + renderFreshConfig(installRoot);
  return wrapOutcome(
    {
      action: "fresh",
      newText,
      message: `would append [${SECTION_NAME}] section with ${MANAGED_KEY} = ${desiredPath}`,
      diff: unifiedDiffText(currentText, newText),
    },
    currentText,
    hooksPath,
    hookCommand,
    pluginHooks,
  );
}

/** Branch: section present, no set key -> insert set line. */
export function planInsertSet(
  currentText: string,
  installRoot: string,
  hooksPath: string | null,
  hookCommand: string,
  pluginHooks: boolean,
): Outcome {
  const desiredPath = installRoot;
  const newText = insertSetLine(currentText, installRoot);
  return wrapOutcome(
    {
      action: "insert",
      newText,
      message: `would insert set = { ${MANAGED_KEY} = ${desiredPath} } into [${SECTION_NAME}]`,
      diff: unifiedDiffText(currentText, newText),
    },
    currentText,
    hooksPath,
    hookCommand,
    pluginHooks,
  );
}

/** Branch: AGENTERA_HOME already correct -> noop. */
export function planNoop(
  currentText: string,
  installRoot: string,
  hooksPath: string | null,
  hookCommand: string,
  pluginHooks: boolean,
): Outcome {
  const desiredPath = installRoot;
  return wrapOutcome(
    {
      action: "noop",
      newText: currentText,
      message: `${MANAGED_KEY} already set to ${desiredPath}; nothing to do`,
      diff: "",
    },
    currentText,
    hooksPath,
    hookCommand,
    pluginHooks,
  );
}

/** Branch: update managed key when it is the only set entry. */
export function planUpdateManagedKeyOnly(
  currentText: string,
  installRoot: string,
  state: TomlState,
  merged: Record<string, string>,
  hooksPath: string | null,
  hookCommand: string,
  pluginHooks: boolean,
): Outcome {
  const desiredPath = installRoot;
  let newText: string;
  try {
    newText = rewriteSetLine(currentText, merged);
  } catch (exc) {
    return {
      action: "conflict",
      newText: "",
      message: `${MANAGED_KEY} present but cannot be safely updated: ${(exc as Error).message}. Edit ~/.codex/config.toml manually.`,
      diff: "",
    };
  }
  return wrapOutcome(
    {
      action: "insert",
      newText,
      message: `would update ${MANAGED_KEY} from ${state.setTable[MANAGED_KEY]} to ${desiredPath}`,
      diff: unifiedDiffText(currentText, newText),
    },
    currentText,
    hooksPath,
    hookCommand,
    pluginHooks,
  );
}

/** Branch: add managed key when no siblings and key absent from set table. */
export function planAddManagedKey(
  currentText: string,
  installRoot: string,
  merged: Record<string, string>,
  hooksPath: string | null,
  hookCommand: string,
  pluginHooks: boolean,
): Outcome {
  const desiredPath = installRoot;
  let newText: string;
  try {
    newText = hasInlineSetLine(currentText)
      ? rewriteSetLine(currentText, merged)
      : normalizeShellEnvironmentPolicy(currentText, installRoot);
  } catch (exc) {
    return {
      action: "conflict",
      newText: "",
      message: `cannot add ${MANAGED_KEY} to [${SECTION_NAME}]: ${(exc as Error).message}. Edit ~/.codex/config.toml manually.`,
      diff: "",
    };
  }
  return wrapOutcome(
    {
      action: "insert",
      newText,
      message: `would set ${MANAGED_KEY} = ${desiredPath} in [${SECTION_NAME}].set`,
      diff: unifiedDiffText(currentText, newText),
    },
    currentText,
    hooksPath,
    hookCommand,
    pluginHooks,
  );
}

/** Branch: sibling keys without --force -> conflict. */
export function planSiblingConflict(
  siblings: Record<string, string>,
  state: TomlState,
  merged: Record<string, string>,
  installRoot: string,
): Outcome {
  return {
    action: "conflict",
    newText: "",
    message: `[${SECTION_NAME}].set has sibling keys (${Object.keys(siblings).sort().join(", ")}). Re-run with --force to merge ${MANAGED_KEY} = ${installRoot} alongside them.`,
    diff: conflictDiffText(state.setTable, merged),
  };
}

/** Branch: --force merge preserving siblings. */
export function planForceMerge(
  currentText: string,
  installRoot: string,
  state: TomlState,
  merged: Record<string, string>,
  siblings: Record<string, string>,
  hooksPath: string | null,
  hookCommand: string,
  pluginHooks: boolean,
): Outcome {
  const desiredPath = installRoot;
  let newText: string;
  try {
    newText = rewriteSetLine(currentText, merged);
  } catch (exc) {
    return {
      action: "conflict",
      newText: "",
      message: `--force requested but cannot safely merge: ${(exc as Error).message}. Edit ~/.codex/config.toml manually.`,
      diff: "",
    };
  }
  return wrapOutcome(
    {
      action: "force-merge",
      newText,
      message: `would merge ${MANAGED_KEY} = ${desiredPath} into existing set (siblings preserved: ${Object.keys(siblings).sort().join(", ")})`,
      diff: unifiedDiffText(currentText, newText),
    },
    currentText,
    hooksPath,
    hookCommand,
    pluginHooks,
  );
}

export function planChange(
  currentText: string | null,
  installRoot: string,
  opts: PlanChangeOptions,
): Outcome {
  const force = opts.force;
  const hooksPath = opts.hooksPath ?? null;
  const hookCommand = opts.hookCommand ?? CODEX_HOOK_COMMAND;
  const pluginHooks = opts.pluginHooks ?? false;
  const desiredPath = installRoot;

  if (currentText === null || !currentText.trim()) {
    return planFreshEmpty(currentText, installRoot, hooksPath, hookCommand, pluginHooks);
  }

  const state = classifyToml(currentText);

  const normalized = planNormalize(currentText, installRoot, state, hooksPath, hookCommand, pluginHooks);
  if (normalized !== null) return normalized;

  if (!state.sectionPresent) {
    return planAppendSection(currentText, installRoot, hooksPath, hookCommand, pluginHooks);
  }

  if (!state.setPresent) {
    return planInsertSet(currentText, installRoot, hooksPath, hookCommand, pluginHooks);
  }

  const currentValue = state.setTable[MANAGED_KEY];
  if (currentValue === desiredPath) {
    return planNoop(currentText, installRoot, hooksPath, hookCommand, pluginHooks);
  }

  const siblings: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.setTable)) {
    if (k !== MANAGED_KEY) siblings[k] = v;
  }
  const merged: Record<string, string> = { ...state.setTable, [MANAGED_KEY]: desiredPath };

  if (MANAGED_KEY in state.setTable && Object.keys(siblings).length === 0) {
    return planUpdateManagedKeyOnly(currentText, installRoot, state, merged, hooksPath, hookCommand, pluginHooks);
  }

  if (Object.keys(siblings).length === 0 && !(MANAGED_KEY in state.setTable)) {
    return planAddManagedKey(currentText, installRoot, merged, hooksPath, hookCommand, pluginHooks);
  }

  if (!force) {
    return planSiblingConflict(siblings, state, merged, installRoot);
  }

  return planForceMerge(currentText, installRoot, state, merged, siblings, hooksPath, hookCommand, pluginHooks);
}
