import fs, { type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isFile, pathExists, resolvePath } from "../core/paths.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadRegistry } from "../registries/runtimeAdapterRegistry.js";
import {
  codexCopiedHooksAreAgenteraOnly,
  codexPluginHooksEnabled,
  retireCodexCopiedHookTrust,
} from "../setup/codex.js";
import {
  hasManagedMarker,
  opencodeConfigDir,
} from "../setup/opencode.js";
import { OPENCODE_SKILL_NAMES } from "../setup/opencodeConstants.js";
import { resolveInvokedUpdateChannel } from "./channels.js";
import { writeFileAtomic } from "./atomicWriter.js";
import {
  applyInstalledHooksRetirementItems,
  planInstalledHooksRetirementItems,
  textReferencesV2InstalledHooks,
} from "./installedHooksRetirement.js";
import type { MigrationContext, MigrationPhaseItem, MigrationStatus } from "./migrateArtifactsV2ToV3.js";
import { projectUsesV3CapabilityInstructionModules } from "./v3CapabilitySurface.js";

const PYTHON_MANAGED_PATTERNS = [
  /hooks\/validate_artifact\.py/,
  /hooks\/cursor_session_start\.py/,
  /hooks\/cursor_pre_tool_use\.py/,
  /hooks\/cursor_session_stop\.py/,
  /hooks\/session_start\.py/,
  /hooks\/session_stop\.py/,
  /\buv run\b/,
  /\buvx\b/,
  /scripts\/agentera/,
  /\/app\/scripts\/agentera/,
  /cursor_session_start\.py/,
  /cursor_pre_tool_use\.py/,
  /cursor_session_stop\.py/,
] as const;

export function projectHasProjectLevelRuntimeHooks(project: string): boolean {
  const root = resolvePath(project);
  const candidates = [
    path.join(root, ".cursor", "hooks.json"),
    path.join(root, ".codex", "config.toml"),
    path.join(root, ".codex", "hooks", "codex-hooks.json"),
    path.join(root, ".github", "hooks"),
  ];
  return candidates.some((candidate) => isFile(candidate) || pathExists(candidate));
}

const OPENCODE_COMMAND_NAMES = ["agentera"] as const;
const CURSOR_AGENT_MARKER = "<!-- agentera: managed -->";

export interface NpxHookCommands {
  cliEntrypoint: string;
  validate: string;
  cursorSessionStart: string;
  cursorSessionStop: string;
  cursorPreTool: string;
}

export function resolveNpxHookCommands(
  ctx: Pick<MigrationContext, "channel" | "env" | "home" | "sourceRoot">,
): NpxHookCommands {
  const env = ctx.env ?? process.env;
  const home = ctx.home ?? env.HOME ?? os.homedir();
  const sourceRoot = ctx.sourceRoot ?? resolveSourceRoot(env);
  const channel = resolveInvokedUpdateChannel({
    channel: ctx.channel ?? null,
    env,
    home,
    sourceRoot,
  });
  const cliEntrypoint = channel.updateCommand.trim();
  return {
    cliEntrypoint,
    validate: `${cliEntrypoint} hook validate-artifact`,
    cursorSessionStart: `${cliEntrypoint} hook cursor-session-start`,
    cursorSessionStop: `${cliEntrypoint} hook session-stop`,
    cursorPreTool: `${cliEntrypoint} hook cursor-pre-tool-use`,
  };
}

export function textUsesPythonManagedEntrypoint(text: string): boolean {
  if (/AGENTERA_HOME\s*=/.test(text)) {
    return true;
  }
  return PYTHON_MANAGED_PATTERNS.some((pattern) => pattern.test(text));
}

const V3_NPX_ENTRYPOINT = /\bnpx\s+-y\s+agentera\b/;

export function textUsesV3NpmEntrypoint(text: string): boolean {
  return V3_NPX_ENTRYPOINT.test(text);
}

export function rewireRuntimeText(text: string, runtime: string, commands: NpxHookCommands): string {
  let next = text;
  next = next.replace(
    /uv run\s+\\?"?\$\{AGENTERA_HOME\}\/hooks\/validate_artifact\.py\\?"?/g,
    commands.validate,
  );
  next = next.replace(
    /uv run\s+\\?"?\$\{AGENTERA_HOME\}\/app\/hooks\/validate_artifact\.py\\?"?/g,
    commands.validate,
  );
  next = next.replace(
    /uv run\s+\\?"?\$\{PLUGIN_ROOT\}\/hooks\/validate_artifact\.py\\?"?/g,
    commands.validate,
  );
  next = next.replace(/uv run\s+hooks\/validate_artifact\.py/g, commands.validate);
  if (next.includes("validate_artifact.py")) {
    next = next.replace(
      /["']?[^"'\n]*hooks\/validate_artifact\.py[^"'\n]*["']?/g,
      `"${commands.validate}"`,
    );
  }
  next = next.replace(
    /["']?[^"'\n]*cursor_session_start\.py[^"'\n]*["']?/g,
    `"${commands.cursorSessionStart}"`,
  );
  next = next.replace(
    /["']?[^"'\n]*cursor_pre_tool_use\.py[^"'\n]*["']?/g,
    `"${commands.cursorPreTool}"`,
  );
  next = next.replace(
    /["']?[^"'\n]*cursor_session_stop\.py[^"'\n]*["']?/g,
    `"${commands.cursorSessionStop}"`,
  );
  next = next.replace(/["']?[^"'\n]*\/app\/scripts\/agentera[^"'\n]*["']?/g, `"${commands.cliEntrypoint}"`);
  next = next.replace(/["']?[^"'\n]*scripts\/agentera[^"'\n]*["']?/g, `"${commands.cliEntrypoint}"`);
  next = next.replace(/npx -y agentera hook /g, `${commands.cliEntrypoint} hook `);
  next = next.replace(/npx -y agentera@latest hook /g, `${commands.cliEntrypoint} hook `);
  if (runtime === "codex") {
    next = next.replace(/AGENTERA_HOME\s*=\s*"[^"]*"/g, "");
    next = next.replace(/AGENTERA_HOME\s*=\s*'[^']*'/g, "");
    next = next.replace(/set\s*=\s*\{\s*,/g, "set = {");
    next = next.replace(/,\s*,/g, ",");
    next = next.replace(/,\s*\}/g, " }");
    next = next.replace(/set\s*=\s*\{\s*\}/g, "set = { }");
  }
  return next;
}

function needsChannelNpxRewire(text: string, cliEntrypoint: string): boolean {
  if (/npx -y agentera hook /.test(text) && !text.includes(cliEntrypoint)) {
    return true;
  }
  if (/npx -y agentera@latest hook /.test(text) && !text.includes(cliEntrypoint)) {
    return true;
  }
  return false;
}

function pushRewireItem(
  items: MigrationPhaseItem[],
  runtime: string,
  filePath: string,
  commands: NpxHookCommands,
): void {
  const text = fs.readFileSync(filePath, "utf8");
  const needsBare = needsChannelNpxRewire(text, commands.cliEntrypoint);
  if (!textUsesPythonManagedEntrypoint(text) && !textReferencesV2InstalledHooks(text) && !needsBare) {
    if (textUsesV3NpmEntrypoint(text)) {
      items.push({
        status: "noop",
        action: "rewire-runtime",
        runtime,
        source: filePath,
        message: "runtime config already references npm self-contained entrypoint",
      });
    }
    // If the file has no Agentera content at all (no v2 Python, no v3 npm),
    // it is not Agentera-managed. Do not push a blocked item — just return.
    return;
  }
  const newText = rewireRuntimeText(text, runtime, commands);
  const status: MigrationStatus = newText === text ? "blocked" : "pending";
  items.push({
    status,
    action: "rewire-runtime",
    runtime,
    source: filePath,
    target: filePath,
    newText,
    message:
      status === "pending"
        ? "will rewire runtime config from Python managed app-home to npm self-contained entrypoint"
        : "runtime config uses Python managed paths but could not be rewritten safely",
  });
}

function hasCursorManagedAgentMarker(text: string): boolean {
  return text.includes(CURSOR_AGENT_MARKER);
}

function copyIfChanged(source: string, target: string): boolean {
  if (!isFile(source)) {
    return false;
  }
  if (isFile(target)) {
    const before = fs.readFileSync(source);
    const after = fs.readFileSync(target);
    if (before.equals(after)) {
      return false;
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const sourceBytes = fs.readFileSync(source);
  writeFileAtomic(target, sourceBytes);
  return true;
}

function planCodexItems(
  items: MigrationPhaseItem[],
  home: string,
  project: string,
  commands: NpxHookCommands,
  force?: boolean,
): void {
  for (const root of [project, home]) {
    const hooksPath = path.join(root, ".codex", "hooks", "codex-hooks.json");
    const configPath = path.join(root, ".codex", "config.toml");
    if (isFile(hooksPath)) {
      pushRewireItem(items, "codex", hooksPath, commands);
    }
    if (isFile(configPath)) {
      pushRewireItem(items, "codex", configPath, commands);
      const configText = fs.readFileSync(configPath, "utf8");
      const pluginHooks = codexPluginHooksEnabled(configText);
      if (pluginHooks && isFile(hooksPath)) {
        let hooksText: string;
        try {
          hooksText = fs.readFileSync(hooksPath, "utf8");
        } catch {
          hooksText = "";
        }
        if (codexCopiedHooksAreAgenteraOnly(hooksText)) {
          items.push({
            status: "pending",
            action: "retire-hooks",
            runtime: "codex",
            source: hooksPath,
            target: configPath,
            message: "will remove Agentera-owned copied Codex hooks because plugin hooks are enabled",
          });
        } else if (hooksText.includes("validate_artifact") || hooksText.includes("hook validate-artifact")) {
          items.push({
            status: force ? "pending" : "blocked",
            action: "retire-hooks",
            runtime: "codex",
            source: hooksPath,
            target: configPath,
            message:
              "plugin hooks are enabled, but copied hook target needs manual review before retirement",
          });
        }
      }
    }
  }
}

function planCursorItems(
  items: MigrationPhaseItem[],
  home: string,
  project: string,
  sourceRoot: string,
  commands: NpxHookCommands,
): void {
  for (const hooksPath of [
    path.join(project, ".cursor", "hooks.json"),
    path.join(home, ".cursor", "hooks.json"),
  ]) {
    if (isFile(hooksPath)) {
      pushRewireItem(items, "cursor", hooksPath, commands);
    }
  }
  const agentsSource = path.join(sourceRoot, ".cursor", "agents");
  const pluginSource = path.join(sourceRoot, ".cursor-plugin", "plugin.json");
  for (const root of [project]) {
    const agentsDir = path.join(root, ".cursor", "agents");
    if (isFile(pluginSource) && root === project) {
      const pluginTarget = path.join(root, ".cursor-plugin", "plugin.json");
      if (!isFile(pluginTarget)) {
        items.push({
          status: "pending",
          action: "copy-plugin",
          runtime: "cursor",
          source: pluginSource,
          target: pluginTarget,
          message: "will copy managed Cursor plugin manifest",
        });
      } else if (!fs.readFileSync(pluginSource).equals(fs.readFileSync(pluginTarget))) {
        items.push({
          status: "pending",
          action: "copy-plugin",
          runtime: "cursor",
          source: pluginSource,
          target: pluginTarget,
          message: "will refresh managed Cursor plugin manifest",
        });
      }
    }
    const skipInTreeCursorAgents =
      root === project && projectUsesV3CapabilityInstructionModules(project);
    if (skipInTreeCursorAgents) {
      items.push({
        status: "noop",
        action: "copy-agent",
        runtime: "cursor",
        target: agentsDir,
        message:
          "v3 capability instruction modules present; in-tree .cursor/agents/ uses prime --context and is not overwritten",
      });
    } else if (pathExists(agentsSource)) {
      const CURSOR_MANAGED_AGENT = "agentera.md";
      const src = path.join(agentsSource, CURSOR_MANAGED_AGENT);
      if (isFile(src)) {
        const dst = path.join(agentsDir, CURSOR_MANAGED_AGENT);
        if (!isFile(dst)) {
          items.push({
            status: "pending",
            action: "copy-agent",
            runtime: "cursor",
            source: src,
            target: dst,
            message: "will copy managed Cursor Agentera agent",
          });
        } else {
          const dstText = fs.readFileSync(dst, "utf8");
          const srcText = fs.readFileSync(src, "utf8");
          if (hasCursorManagedAgentMarker(dstText) && dstText !== srcText) {
            items.push({
              status: "pending",
              action: "copy-agent",
              runtime: "cursor",
              source: src,
              target: dst,
              message: "will refresh stale managed Cursor Agentera agent",
            });
          }
        }
      }
    }
  }
}

function planOpencodeItems(
  items: MigrationPhaseItem[],
  home: string,
  sourceRoot: string,
  env: Record<string, string | undefined>,
  commands: NpxHookCommands,
): void {
  const configDir = opencodeConfigDir(home, env);
  const pluginSource = path.join(sourceRoot, ".opencode", "plugins", "agentera.js");
  const pluginTarget = path.join(configDir, "plugins", "agentera.js");
  if (isFile(pluginSource)) {
    const targetContent = isFile(pluginTarget) ? fs.readFileSync(pluginTarget, "utf8") : "";
    const sourceContent = fs.readFileSync(pluginSource, "utf8");
    const needsCopy =
      !isFile(pluginTarget) ||
      (targetContent !== sourceContent &&
        (textUsesPythonManagedEntrypoint(targetContent) ||
          needsChannelNpxRewire(targetContent, commands.cliEntrypoint)));
    items.push({
      status: needsCopy ? "pending" : "noop",
      action: "copy-plugin",
      runtime: "opencode",
      source: pluginSource,
      target: pluginTarget,
      message: needsCopy
        ? "will copy current Agentera OpenCode plugin to native plugin path"
        : "OpenCode plugin already current at native plugin path",
    });
  }
  const commandsSourceDir = path.join(sourceRoot, ".opencode", "commands");
  const commandsTargetDir = path.join(configDir, "commands");
  for (const name of OPENCODE_COMMAND_NAMES) {
    const src = path.join(commandsSourceDir, `${name}.md`);
    const dst = path.join(commandsTargetDir, `${name}.md`);
    if (isFile(src)) {
      const needsCopy = !isFile(dst) || (hasManagedMarker(fs.readFileSync(dst, "utf8")) && !fs.readFileSync(src).equals(fs.readFileSync(dst)));
      items.push({
        status: needsCopy ? "pending" : "noop",
        action: "copy-command",
        runtime: "opencode",
        source: src,
        target: dst,
        message: needsCopy ? "will sync managed OpenCode command" : "OpenCode managed command already current",
      });
    }
  }
  const agentsSourceDir = path.join(sourceRoot, ".opencode", "agents");
  const agentsTargetDir = path.join(configDir, "agents");
  const OPENCODE_MANAGED_AGENT = "agentera.md";
  if (pathExists(agentsSourceDir)) {
    const src = path.join(agentsSourceDir, OPENCODE_MANAGED_AGENT);
    if (isFile(src)) {
      const dst = path.join(agentsTargetDir, OPENCODE_MANAGED_AGENT);
      const needsCopy = !isFile(dst) || !fs.readFileSync(src).equals(fs.readFileSync(dst));
      items.push({
        status: needsCopy ? "pending" : "noop",
        action: "copy-agent",
        runtime: "opencode",
        source: src,
        target: dst,
        message: needsCopy ? "will copy managed OpenCode Agentera agent" : "OpenCode Agentera agent already current",
      });
    }
  }
  const skillsSourceRoot = path.join(sourceRoot, "skills");
  // D78: ~/.agents/skills is the canonical agent-compatible root (opencode loads
  // from both ~/.config/opencode/skills and ~/.agents/skills and requires skill
  // names unique across locations — opencode.ai/docs/skills). Maintain the link
  // here; the legacy ~/.config/opencode/skills entry is retired below.
  const skillsTargetDir = path.join(home, ".agents", "skills");
  for (const name of OPENCODE_SKILL_NAMES) {
    const src = path.join(skillsSourceRoot, name);
    const dst = path.join(skillsTargetDir, name);
    if (!isFile(path.join(src, "SKILL.md"))) {
      continue;
    }
    if (!pathExists(dst)) {
      items.push({
        status: "pending",
        action: "link-skill",
        runtime: "opencode",
        source: src,
        target: dst,
        message: "will create OpenCode skill link",
      });
      continue;
    }
    try {
      const linkTarget = fs.readlinkSync(dst);
      if (!linkTarget.includes("agentera") && path.basename(linkTarget) !== name) {
        items.push({
          status: "blocked",
          action: "link-skill",
          runtime: "opencode",
          source: src,
          target: dst,
          message: "OpenCode skill path is user-owned; manual review required",
        });
      } else if (path.resolve(path.dirname(dst), linkTarget) !== path.resolve(src)) {
        items.push({
          status: "pending",
          action: "link-skill",
          runtime: "opencode",
          source: src,
          target: dst,
          message: "will update stale Agentera-managed OpenCode skill link",
        });
      }
    } catch {
      items.push({
        status: "pending",
        action: "link-skill",
        runtime: "opencode",
        source: src,
        target: dst,
        message: "will replace non-symlink OpenCode skill path with managed link",
      });
    }
  }
  // D78: retire the legacy opencode-specific skill symlinks now that
  // ~/.agents/skills is canonical. The opencode doc requires skill names
  // unique across its discovery locations; a skill present in both
  // ~/.config/opencode/skills and ~/.agents/skills is the duplicate-name error
  // that let a stale copy load.
  const legacySkillsDir = path.join(configDir, "skills");
  if (pathExists(legacySkillsDir) && fs.statSync(legacySkillsDir).isDirectory()) {
    for (const name of OPENCODE_SKILL_NAMES) {
      const legacy = path.join(legacySkillsDir, name);
      let linkTarget: string | null = null;
      try {
        linkTarget = fs.readlinkSync(legacy);
      } catch {
        linkTarget = null;
      }
      if (linkTarget !== null) {
        if (linkTarget.toLowerCase().includes("agentera") || path.basename(linkTarget) === name) {
          items.push({
            status: "pending",
            action: "remove-stale-skill",
            runtime: "opencode",
            source: legacy,
            message: `will retire duplicate OpenCode skill symlink ${name} (agent-compatible root ~/.agents/skills is canonical; D78)`,
          });
        } else {
          items.push({
            status: "blocked",
            action: "remove-stale-skill",
            runtime: "opencode",
            source: legacy,
            message: `legacy OpenCode skill symlink ${name} targets a non-agentera path; manual review required`,
          });
        }
      } else if (pathExists(legacy)) {
        try {
          const dirEntries = fs.readdirSync(legacy);
          if (dirEntries.length === 0) {
            items.push({
              status: "pending",
              action: "remove-stale-skill",
              runtime: "opencode",
              source: legacy,
              message: `will retire empty legacy OpenCode skill directory ${name} (agent-compatible root ~/.agents/skills is canonical; D78)`,
            });
          } else {
            items.push({
              status: "blocked",
              action: "remove-stale-skill",
              runtime: "opencode",
              source: legacy,
              message: `legacy OpenCode skill path ${name} is a non-empty real directory (entries: ${dirEntries.length}); manual review required (D78 retires agentera-managed symlinks and empty dirs only)`,
            });
          }
        } catch {
          items.push({
            status: "blocked",
            action: "remove-stale-skill",
            runtime: "opencode",
            source: legacy,
            message: `legacy OpenCode skill path ${name} could not be inspected; manual review required`,
          });
        }
      }
    }
  }
}

export function planStaleCommandCleanupItems(
  ctx: MigrationContext,
  items: MigrationPhaseItem[],
): void {
  const env = ctx.env ?? process.env;
  const home = resolvePath(ctx.home);
  const commandsDir = path.join(opencodeConfigDir(home, env), "commands");
  if (!pathExists(commandsDir) || !fs.statSync(commandsDir).isDirectory()) {
    return;
  }
  const currentNames = new Set<string>(OPENCODE_COMMAND_NAMES);
  for (const entry of fs.readdirSync(commandsDir)) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const filePath = path.join(commandsDir, entry);
    if (!isFile(filePath)) {
      continue;
    }
    const body = fs.readFileSync(filePath, "utf8");
    if (!hasManagedMarker(body)) {
      continue;
    }
    const name = entry.slice(0, -3);
    if (currentNames.has(name)) {
      continue;
    }
    items.push({
      status: "pending",
      action: "remove-stale-command",
      runtime: "opencode",
      source: filePath,
      message: `will remove stale managed command ${path.basename(filePath)}`,
    });
  }
}

export function planStaleSkillCleanupItems(
  ctx: MigrationContext,
  items: MigrationPhaseItem[],
): void {
  const env = ctx.env ?? process.env;
  const home = resolvePath(ctx.home);
  const skillsDir = path.join(opencodeConfigDir(home, env), "skills");
  if (!pathExists(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
    return;
  }
  const requiredNames = new Set<string>(OPENCODE_SKILL_NAMES);
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) {
      continue;
    }
    const linkPath = path.join(skillsDir, entry.name);
    let linkTarget: string;
    try {
      linkTarget = fs.readlinkSync(linkPath);
    } catch {
      continue;
    }
    if (!linkTarget.toLowerCase().includes("agentera")) {
      continue;
    }
    if (requiredNames.has(entry.name)) {
      continue;
    }
    items.push({
      status: "pending",
      action: "remove-stale-skill",
      runtime: "opencode",
      source: linkPath,
      message: `will remove stale Agentera skill symlink ${entry.name}`,
    });
  }
}

function walkJsonHookFiles(dir: string): string[] {
  if (!pathExists(dir)) {
    return [];
  }
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current)) {
      const full = path.join(current, entry);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".json")) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function planCopilotItems(
  items: MigrationPhaseItem[],
  project: string,
  commands: NpxHookCommands,
): void {
  const hooksDir = path.join(project, ".github", "hooks");
  for (const hookFile of walkJsonHookFiles(hooksDir)) {
    pushRewireItem(items, "copilot", hookFile, commands);
  }
  if (!items.some((item) => item.runtime === "copilot")) {
    items.push({
      status: "noop",
      action: "configure",
      runtime: "copilot",
      message: "Copilot uses per-invocation AGENTERA_HOME; Agentera does not write shell startup files",
    });
  }
}

export function planRuntimeMigrationItems(ctx: MigrationContext): MigrationPhaseItem[] {
  if (!ctx.env) {
    throw new Error(
      "MigrationContext.env is required for runtime migration planning; pass sandboxMigrationEnv(home, sourceRoot) in tests or an explicit env in callers.",
    );
  }
  const home = resolvePath(ctx.home);
  const project = resolvePath(ctx.project);
  const env = ctx.env;
  const sourceRoot = resolvePath(ctx.sourceRoot ?? resolveSourceRoot(env));
  const commands = resolveNpxHookCommands({ ...ctx, home, env, sourceRoot });
  const items: MigrationPhaseItem[] = [];

  planCodexItems(items, home, project, commands, ctx.force);
  planCursorItems(items, home, project, sourceRoot, commands);
  planOpencodeItems(items, home, sourceRoot, env, commands);
  planStaleCommandCleanupItems(ctx, items);
  planStaleSkillCleanupItems(ctx, items);
  planCopilotItems(items, project, commands);
  const hookRetirement = planInstalledHooksRetirementItems(ctx).filter((item) => item.status === "pending");
  if (hookRetirement.length > 0 && items.some((item) => item.action === "rewire-runtime" && item.status === "pending")) {
    items.push(...hookRetirement);
  }
  void loadRegistry();
  return items;
}

export function applyRuntimeMigrationItem(item: MigrationPhaseItem, _commands: NpxHookCommands): void {
  if (item.status !== "pending") {
    return;
  }
  try {
    switch (item.action) {
      case "rewire-runtime": {
        if (!item.target || item.newText === undefined) {
          item.status = "failed";
          item.message = "rewire-runtime missing target or newText";
          return;
        }
        writeFileAtomic(item.target, item.newText, "utf8");
        item.status = "applied";
        item.message = "runtime config rewired to npm self-contained entrypoint";
        break;
      }
      case "copy-plugin":
      case "copy-agent":
      case "copy-command": {
        if (!item.source || !item.target) {
          item.status = "failed";
          item.message = `${item.action} missing source or target`;
          return;
        }
        copyIfChanged(item.source, item.target);
        item.status = "applied";
        item.message = `applied ${item.action}`;
        break;
      }
      case "link-skill": {
        if (!item.source || !item.target) {
          item.status = "failed";
          item.message = "link-skill missing source or target";
          return;
        }
        if (!pathExists(item.source)) {
          item.status = "failed";
          item.message = `link-skill source disappeared between plan and apply: ${item.source}`;
          return;
        }
        fs.mkdirSync(path.dirname(item.target), { recursive: true });
        // lstat (not stat): stat follows symlinks and ENOENTs on dangling links; rmSync then fails.
        let targetStat: Stats | null = null;
        try {
          targetStat = fs.lstatSync(item.target);
        } catch {
          /* target absent */
        }
        if (targetStat) {
          if (targetStat.isSymbolicLink()) {
            fs.unlinkSync(item.target);
          } else {
            fs.rmSync(item.target, { recursive: true, force: true });
          }
        }
        fs.symlinkSync(item.source, item.target);
        item.status = "applied";
        item.message = "OpenCode skill link created";
        break;
      }
      case "retire-hooks": {
        if (!item.source) {
          item.status = "failed";
          item.message = "retire-hooks missing source";
          return;
        }
        if (isFile(item.source)) {
          fs.rmSync(item.source, { force: true });
        }
        if (item.target && isFile(item.target)) {
          const configText = fs.readFileSync(item.target, "utf8");
          const next = retireCodexCopiedHookTrust(configText, item.source);
          writeFileAtomic(item.target, next, "utf8");
        }
        item.status = "applied";
        item.message = "retired Agentera-owned copied Codex hooks";
        break;
      }
      case "remove-stale-command": {
        if (!item.source) {
          item.status = "failed";
          item.message = "remove-stale-command missing source";
          return;
        }
        if (isFile(item.source)) {
          fs.rmSync(item.source, { force: true });
          item.status = "applied";
          item.message = `removed stale managed command ${path.basename(item.source)}`;
        } else {
          item.status = "noop";
          item.message = `stale command already absent at ${item.source}`;
        }
        break;
      }
      case "remove-stale-skill": {
        if (!item.source) {
          item.status = "failed";
          item.message = "remove-stale-skill missing source";
          return;
        }
        try {
          const stat = fs.lstatSync(item.source);
          if (stat.isSymbolicLink()) {
            fs.unlinkSync(item.source);
            item.status = "applied";
            item.message = `removed stale skill symlink ${path.basename(item.source)}`;
          } else if (stat.isDirectory()) {
            const entries = fs.readdirSync(item.source);
            if (entries.length === 0) {
              fs.rmdirSync(item.source);
              item.status = "applied";
              item.message = `removed empty skill directory ${path.basename(item.source)}`;
            } else {
              item.status = "blocked";
              item.message = `skill directory ${path.basename(item.source)} is non-empty (entries: ${entries.length}); manual review required`;
            }
          } else {
            item.status = "noop";
            item.message = "skill path is not a symlink or directory; skipped";
          }
        } catch {
          item.status = "noop";
          item.message = "stale skill already absent";
        }
        break;
      }
      default:
        break;
    }
  } catch (exc) {
    item.status = "failed";
    item.message = `${item.action} failed: ${(exc as Error).message}`;
  }
}

export function applyRuntimeMigrationItems(
  items: MigrationPhaseItem[],
  ctx: MigrationContext,
): void {
  const commands = resolveNpxHookCommands(ctx);
  for (const item of items) {
    applyRuntimeMigrationItem(item, commands);
  }
  applyInstalledHooksRetirementItems(items, ctx);
}
