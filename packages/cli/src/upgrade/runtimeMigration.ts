import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { isFile, pathExists, resolvePath } from "../core/paths.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
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
import { doctorRoots } from "./appModel.js";
import {
  bindMigrationResource,
  removeBoundMigrationResource,
  updateBoundMigrationFile,
  verifyBoundMigrationResource,
} from "./migrationPublication.js";
import type { MigrationContext, MigrationPhaseItem, MigrationStatus } from "./migrateArtifactsV2ToV3.js";

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
  next = next.replace(
    /uv run\s+\\?"?\$\{AGENTERA_HOME\}\/(?:app\/scripts|(?:app\/)?hooks)\/cursor_session_start\.py\\?"?/g,
    `"${commands.cursorSessionStart}"`,
  );
  next = next.replace(
    /uv run\s+\\?"?\$\{AGENTERA_HOME\}\/(?:app\/)?hooks\/cursor_pre_tool_use\.py\\?"?/g,
    `"${commands.cursorPreTool}"`,
  );
  next = next.replace(
    /uv run\s+\\?"?\$\{AGENTERA_HOME\}\/(?:app\/)?hooks\/cursor_session_stop\.py\\?"?/g,
    `"${commands.cursorSessionStop}"`,
  );
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

function textHasAuthoritativeV2AgenteraEvidence(text: string): boolean {
  const variableReference = /\$\{AGENTERA_HOME\}\/(?:app\/scripts\/(?:agentera|cursor_session_start\.py)|(?:app\/)?hooks\/(?:validate_artifact|cursor_session_start|cursor_pre_tool_use|cursor_session_stop|session_start|session_stop)\.py)/;
  if (variableReference.test(text)) return true;
  if (/AGENTERA_HOME\s*=/.test(text)) return true;
  if (/\[plugins\."agentera@agentera"\]/.test(text) && /AGENTERA_HOME\s*=/.test(text)) return true;
  return false;
}

function pushRewireItem(
  items: MigrationPhaseItem[],
  runtime: string,
  filePath: string,
  commands: NpxHookCommands,
  allowedRoot: string,
): void {
  const text = fs.readFileSync(filePath, "utf8");
  const needsBare = needsChannelNpxRewire(text, commands.cliEntrypoint);
  const authoritative = hasManagedMarker(text)
    || textHasAuthoritativeV2AgenteraEvidence(text)
    || needsBare;
  if (!authoritative) {
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
  const item: MigrationPhaseItem = {
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
  };
  const evidenceError = bindMigrationResource(item, "target", filePath, [allowedRoot], "file");
  if (evidenceError) {
    item.status = "blocked";
    item.message = `runtime config preserved: ${evidenceError}; review the unsafe path manually`;
  }
  items.push(item);
}

function planCodexItems(
  items: MigrationPhaseItem[],
  home: string,
  project: string,
  commands: NpxHookCommands,
): void {
  for (const root of [project, home]) {
    const hooksPath = path.join(root, ".codex", "hooks", "codex-hooks.json");
    const configPath = path.join(root, ".codex", "config.toml");
    if (isFile(configPath)) {
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
          const rewiredConfig = rewireRuntimeText(configText, "codex", commands);
          const item: MigrationPhaseItem = {
            status: "pending",
            action: "retire-hooks",
            runtime: "codex",
            source: hooksPath,
            target: configPath,
            newText: retireCodexCopiedHookTrust(rewiredConfig, hooksPath),
            message: "will remove Agentera-owned copied Codex hooks because plugin hooks are enabled",
          };
          const sourceError = bindMigrationResource(item, "source", hooksPath, [root], "file");
          const targetError = bindMigrationResource(item, "target", configPath, [root], "file");
          if (sourceError || targetError) {
            item.status = "blocked";
            item.message = `copied Codex hooks preserved: ${sourceError ?? targetError}; review the unsafe path manually`;
          }
          items.push(item);
          continue;
        } else if (hooksText.includes("validate_artifact") || hooksText.includes("hook validate-artifact")) {
          items.push({
            status: "blocked",
            action: "retire-hooks",
            runtime: "codex",
            source: hooksPath,
            target: configPath,
            message:
              "plugin hooks are enabled, but copied hook target needs manual review before retirement",
          });
          continue;
        }
      }
      pushRewireItem(items, "codex", configPath, commands, root);
    }
    if (isFile(hooksPath)) {
      pushRewireItem(items, "codex", hooksPath, commands, root);
    }
  }
}

function planCursorItems(
  items: MigrationPhaseItem[],
  home: string,
  project: string,
  commands: NpxHookCommands,
): void {
  for (const [root, hooksPath] of [
    [project, path.join(project, ".cursor", "hooks.json")],
    [home, path.join(home, ".cursor", "hooks.json")],
  ] as const) {
    if (isFile(hooksPath)) {
      pushRewireItem(items, "cursor", hooksPath, commands, root);
    }
  }
}

function planOpencodeItems(
  items: MigrationPhaseItem[],
  home: string,
  env: Record<string, string | undefined>,
  commands: NpxHookCommands,
): void {
  const configDir = opencodeConfigDir(home, env);
  const existingResources = [
    path.join(configDir, "plugins", "agentera.js"),
    ...OPENCODE_COMMAND_NAMES.map((name) => path.join(configDir, "commands", `${name}.md`)),
    path.join(configDir, "agents", "agentera.md"),
  ];
  for (const resource of existingResources) {
    if (isFile(resource)) pushRewireItem(items, "opencode", resource, commands, configDir);
  }
}

function symlinkOwnership(linkPath: string, managedSkillsRoot: string): MigrationPhaseItem["ownership"] | null {
  let stat: fs.Stats;
  let target: string;
  try {
    stat = fs.lstatSync(linkPath);
    if (!stat.isSymbolicLink()) return null;
    target = fs.readlinkSync(linkPath);
  } catch {
    return null;
  }
  const resolvedTarget = path.resolve(path.dirname(linkPath), target);
  const relative = path.relative(managedSkillsRoot, resolvedTarget);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return {
    kind: "managed-app-symlink",
    identity: `${stat.dev}:${stat.ino}`,
    fingerprint: `sha256:${createHash("sha256").update(target).digest("hex")}`,
    root: managedSkillsRoot,
  };
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
    const item: MigrationPhaseItem = {
      status: "pending",
      action: "remove-stale-command",
      runtime: "opencode",
      source: filePath,
      message: `will remove stale managed command ${path.basename(filePath)}`,
    };
    const evidenceError = bindMigrationResource(item, "source", filePath, [home], "file");
    if (evidenceError) {
      item.status = "blocked";
      item.message = `stale command preserved: ${evidenceError}; review the unsafe path manually`;
    }
    items.push(item);
  }
}

export function planStaleSkillCleanupItems(
  ctx: MigrationContext,
  items: MigrationPhaseItem[],
): void {
  const env = ctx.env ?? process.env;
  const home = resolvePath(ctx.home);
  const skillsDir = path.join(opencodeConfigDir(home, env), "skills");
  let skillsDirectory: fs.Stats;
  try {
    skillsDirectory = fs.lstatSync(skillsDir);
  } catch {
    return;
  }
  if (!skillsDirectory.isDirectory()) {
    items.push({
      status: "blocked",
      action: "remove-stale-skill",
      runtime: "opencode",
      source: skillsDir,
      message: `preserved ${skillsDir}: the legacy skills path is not a real directory; replace the unsafe path or review it manually`,
    });
    return;
  }
  const requiredNames = new Set<string>(OPENCODE_SKILL_NAMES);
  const managedSkillsRoot = path.join(doctorRoots(resolvePath(ctx.appHome)).activeBundleRoot, "skills");
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    const linkPath = path.join(skillsDir, entry.name);
    if (!entry.isSymbolicLink()) {
      if (requiredNames.has(entry.name)) {
        items.push({
          status: "blocked",
          action: "remove-stale-skill",
          runtime: "opencode",
          source: linkPath,
          message: `preserved ${linkPath}: name and directory shape do not prove Agentera ownership; review and remove it manually if appropriate`,
        });
      }
      continue;
    }
    let linkTarget: string;
    try {
      linkTarget = fs.readlinkSync(linkPath);
    } catch {
      items.push({
        status: "blocked",
        action: "remove-stale-skill",
        runtime: "opencode",
        source: linkPath,
        message: `preserved ${linkPath}: the symlink target could not be inspected; review the unsafe resource manually`,
      });
      continue;
    }
    const ownership = symlinkOwnership(linkPath, managedSkillsRoot);
    if (!ownership) {
      if (requiredNames.has(entry.name) || linkTarget.toLowerCase().includes("agentera")) {
        items.push({
          status: "blocked",
          action: "remove-stale-skill",
          runtime: "opencode",
          source: linkPath,
          message: `preserved ${linkPath}: skill name or target text does not prove Agentera ownership; confirm ownership and remove it manually if appropriate`,
        });
      }
      continue;
    }
    const item: MigrationPhaseItem = {
      status: "pending",
      action: "remove-stale-skill",
      runtime: "opencode",
      source: linkPath,
      ownership,
      message: `will remove v2 app-owned OpenCode skill symlink ${entry.name}`,
    };
    const evidenceError = bindMigrationResource(item, "source", linkPath, [home], "symlink");
    if (evidenceError) {
      item.status = "blocked";
      item.message = `legacy skill preserved: ${evidenceError}; review the unsafe path manually`;
    }
    items.push(item);
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
    pushRewireItem(items, "copilot", hookFile, commands, project);
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

  planCodexItems(items, home, project, commands);
  planCursorItems(items, home, project, commands);
  planOpencodeItems(items, home, env, commands);
  planStaleCommandCleanupItems(ctx, items);
  planStaleSkillCleanupItems(ctx, items);
  planCopilotItems(items, project, commands);
  return items;
}

export type RuntimeMigrationAction =
  | "rewire-runtime"
  | "retire-hooks"
  | "remove-stale-command"
  | "remove-stale-skill";

export type RuntimeMigrationItem = Omit<MigrationPhaseItem, "action"> & {
  action: RuntimeMigrationAction;
};

const RUNTIME_MIGRATION_ACTIONS: ReadonlySet<string> = new Set<RuntimeMigrationAction>([
  "rewire-runtime",
  "retire-hooks",
  "remove-stale-command",
  "remove-stale-skill",
]);

function isRuntimeMigrationAction(action: string): action is RuntimeMigrationAction {
  return RUNTIME_MIGRATION_ACTIONS.has(action);
}

export function applyRuntimeMigrationItem(item: RuntimeMigrationItem, _commands: NpxHookCommands): void {
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
        updateBoundMigrationFile(item, "target", item.newText);
        item.status = "applied";
        item.message = "runtime config rewired to npm self-contained entrypoint";
        break;
      }
      case "retire-hooks": {
        if (!item.source) {
          item.status = "failed";
          item.message = "retire-hooks missing source";
          return;
        }
        if (!item.target) {
          item.status = "failed";
          item.message = "retire-hooks missing target";
          return;
        }
        verifyBoundMigrationResource(item, "source");
        verifyBoundMigrationResource(item, "target");
        if (item.newText === undefined) {
          item.status = "failed";
          item.message = "retire-hooks missing newText";
          return;
        }
        updateBoundMigrationFile(item, "target", item.newText);
        removeBoundMigrationResource(item, "source");
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
        if (!pathExists(item.source)) {
          item.status = "noop";
          item.message = `stale command already absent at ${item.source}`;
        } else {
          removeBoundMigrationResource(item, "source");
          item.status = "applied";
          item.message = `removed stale managed command ${path.basename(item.source)}`;
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
            const target = fs.readlinkSync(item.source);
            const identity = `${stat.dev}:${stat.ino}`;
            const fingerprint = `sha256:${createHash("sha256").update(target).digest("hex")}`;
            const resolvedTarget = path.resolve(path.dirname(item.source), target);
            const relative = item.ownership?.root
              ? path.relative(item.ownership.root, resolvedTarget)
              : "..";
            if (
              item.ownership?.kind !== "managed-app-symlink"
              || item.ownership.identity !== identity
              || item.ownership.fingerprint !== fingerprint
              || relative === ""
              || relative.startsWith("..")
              || path.isAbsolute(relative)
            ) {
              item.status = "blocked";
              item.message = `preserved ${item.source}: authoritative symlink ownership changed or is missing; rerun migration and review the resource`;
              break;
            }
            removeBoundMigrationResource(item, "source");
            item.status = "applied";
            item.message = `removed stale skill symlink ${path.basename(item.source)}`;
          } else {
            item.status = "blocked";
            item.message = `preserved ${item.source}: only a fingerprinted v2 app-owned symlink is eligible; review it manually`;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            item.status = "noop";
            item.message = "stale skill already absent";
          } else {
            item.status = "failed";
            item.message = `remove-stale-skill failed: ${(error as Error).message}`;
          }
        }
        break;
      }
      default:
        item.status = "failed";
        item.message = `unsupported runtime migration action: ${(item as MigrationPhaseItem).action}`;
        break;
    }
  } catch (exc) {
    item.status = "blocked";
    item.message = `${item.action} preserved the resource: ${(exc as Error).message}; rerun migration and review it manually`;
  }
}

export function applyRuntimeMigrationItems(
  items: MigrationPhaseItem[],
  ctx: MigrationContext,
): void {
  const commands = resolveNpxHookCommands(ctx);
  for (const item of items) {
    if (item.status !== "pending") {
      continue;
    }
    if (isRuntimeMigrationAction(item.action)) {
      applyRuntimeMigrationItem(item as RuntimeMigrationItem, commands);
    } else {
      item.status = "failed";
      item.message = `unsupported runtime migration action: ${item.action}`;
    }
  }
}
