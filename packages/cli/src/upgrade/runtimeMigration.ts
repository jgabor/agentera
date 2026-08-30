import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { isFile, pathExists, resolvePath } from "../core/paths.js";
import { hasManagedMarker, opencodeConfigDir } from "../setup/opencode.js";
import { OPENCODE_SKILL_NAMES } from "../setup/opencodeConstants.js";
import { doctorRoots } from "./appModel.js";
import {
  bindMigrationResource,
  removeBoundMigrationResource,
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

export function textUsesPythonManagedEntrypoint(text: string): boolean {
  if (/AGENTERA_HOME\s*=/.test(text)) {
    return true;
  }
  return PYTHON_MANAGED_PATTERNS.some((pattern) => pattern.test(text));
}

const RETIRED_NPX_HOOK = /\bnpx\s+-y\s+agentera(?:@(?:next|latest))?\s+hook\s+/;
const V2_AGENTERA_HOOK = /(?:\buv(?:x|\s+run)\b[^"'\n]*(?:\$\{(?:AGENTERA_HOME|PLUGIN_ROOT)\}|hooks\/)\/[^"'\n]*\.py|\$\{AGENTERA_HOME\}\/(?:app\/scripts|(?:app\/)?hooks)\/[^"'\n]*\.py)/;

function retiredHookCommands(value: unknown, commands: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) retiredHookCommands(entry, commands);
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "command" && typeof entry === "string") commands.push(entry);
      else retiredHookCommands(entry, commands);
    }
  }
  return commands;
}

function isRetiredAgenteraHookCommand(command: string): boolean {
  return V2_AGENTERA_HOOK.test(command) || RETIRED_NPX_HOOK.test(command);
}

/**
 * Native hook files have no durable per-entry ownership record. Remove only a
 * file whose every command is a retired Agentera invocation; mixed files are
 * preserved for the owner to review rather than surgically rewritten.
 */
export function wholeResourceProvesV2HookOwnership(text: string): boolean {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return false;
  }
  const commands = retiredHookCommands(document);
  return commands.length > 0 && commands.every(isRetiredAgenteraHookCommand);
}

function textContainsRetiredAgenteraHook(text: string): boolean {
  return textUsesPythonManagedEntrypoint(text) || RETIRED_NPX_HOOK.test(text);
}

function pushRetireHookItem(
  items: MigrationPhaseItem[],
  runtime: string,
  filePath: string,
  allowedRoot: string,
): void {
  const text = fs.readFileSync(filePath, "utf8");
  if (!textContainsRetiredAgenteraHook(text)) {
    return;
  }
  const item: MigrationPhaseItem = {
    status: wholeResourceProvesV2HookOwnership(text) ? "pending" : "blocked",
    action: "retire-hooks",
    runtime,
    source: filePath,
    message:
      wholeResourceProvesV2HookOwnership(text)
        ? "will remove whole-resource-proven retired Agentera hook"
        : "retired Agentera hook preserved: complete resource ownership is unproven; review and remove it manually",
  };
  if (item.status === "blocked") {
    items.push(item);
    return;
  }
  const evidenceError = bindMigrationResource(item, "source", filePath, [allowedRoot], "file");
  if (evidenceError) {
    item.status = "blocked";
    item.message = `retired Agentera hook preserved: ${evidenceError}; review the unsafe path manually`;
  }
  items.push(item);
}

export function planDeclaredCopilotHookItem(filePath: string, project: string, resourceId: string): MigrationPhaseItem {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    return { resourceId, status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "noop" : "blocked",
      action: "retire-hooks", runtime: "copilot", source: filePath,
      message: (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `retired Copilot hook already absent at ${filePath}`
        : `retired Copilot hook preserved: path could not be inspected` };
  }
  if (!stat.isFile()) return { resourceId, status: "blocked", action: "retire-hooks", runtime: "copilot", source: filePath,
    message: `retired Copilot hook preserved: declared path is not a regular file` };
  const items: MigrationPhaseItem[] = [];
  try {
    pushRetireHookItem(items, "copilot", filePath, project);
  } catch {
    return { resourceId, status: "blocked", action: "retire-hooks", runtime: "copilot", source: filePath,
      message: `retired Copilot hook preserved: declared file could not be read` };
  }
  const item = items[0];
  if (!item) return { resourceId, status: "blocked", action: "retire-hooks", runtime: "copilot", source: filePath,
    message: `retired Copilot hook preserved: complete resource ownership is unproven; review it manually` };
  item.resourceId = resourceId;
  return item;
}

function planCodexItems(
  items: MigrationPhaseItem[],
  home: string,
  project: string,
): void {
  for (const root of [project, home]) {
    const hooksPath = path.join(root, ".codex", "hooks", "codex-hooks.json");
    if (isFile(hooksPath)) {
      pushRetireHookItem(items, "codex", hooksPath, root);
    }
  }
}

function planCursorItems(
  items: MigrationPhaseItem[],
  home: string,
  project: string,
): void {
  for (const [root, hooksPath] of [
    [project, path.join(project, ".cursor", "hooks.json")],
    [home, path.join(home, ".cursor", "hooks.json")],
  ] as const) {
    if (isFile(hooksPath)) {
      pushRetireHookItem(items, "cursor", hooksPath, root);
    }
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
  const configDir = opencodeConfigDir(home, env);
  const commandsDir = path.join(configDir, "commands");
  if (!pathExists(commandsDir) || !fs.statSync(commandsDir).isDirectory()) return;
  for (const entry of ["agentera.md", "hej.md"]) {
    const filePath = path.join(commandsDir, entry);
    if (!isFile(filePath) || !hasManagedMarker(fs.readFileSync(filePath, "utf8"))) continue;
    const item: MigrationPhaseItem = { status: "pending", action: "remove-stale-command", runtime: "opencode", source: filePath,
      message: `will remove stale managed command ${entry}` };
    const evidenceError = bindMigrationResource(item, "source", filePath, [home], "file");
    if (evidenceError) { item.status = "blocked"; item.message = `stale command preserved: ${evidenceError}; review the unsafe path manually`; }
    items.push(item);
  }
}

export function planStaleSkillCleanupItems(
  ctx: MigrationContext,
  items: MigrationPhaseItem[],
): void {
  const env = ctx.env ?? process.env;
  const home = resolvePath(ctx.home);
  const configDir = opencodeConfigDir(home, env);
  const skillsDir = path.join(configDir, "skills");
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

export function planRuntimeMigrationItems(
  ctx: MigrationContext,
): MigrationPhaseItem[] {
  if (!ctx.env) {
    throw new Error(
      "MigrationContext.env is required for runtime migration planning; pass sandboxMigrationEnv(home, sourceRoot) in tests or an explicit env in callers.",
    );
  }
  const home = resolvePath(ctx.home);
  const project = resolvePath(ctx.project);
  const env = ctx.env;
  const items: MigrationPhaseItem[] = [];

  planCodexItems(items, home, project);
  planCursorItems(items, home, project);
  planStaleCommandCleanupItems(ctx, items);
  planStaleSkillCleanupItems(ctx, items);
  items.push({ status: "noop", action: "configure", runtime: "copilot",
    message: "Copilot uses per-invocation AGENTERA_HOME; Agentera does not write shell startup files" });
  return items;
}

export type RuntimeMigrationAction =
  | "retire-hooks"
  | "remove-stale-command"
  | "remove-stale-skill";

export type RuntimeMigrationItem = Omit<MigrationPhaseItem, "action"> & {
  action: RuntimeMigrationAction;
};

const RUNTIME_MIGRATION_ACTIONS: ReadonlySet<string> = new Set<RuntimeMigrationAction>([
  "retire-hooks",
  "remove-stale-command",
  "remove-stale-skill",
]);

function isRuntimeMigrationAction(action: string): action is RuntimeMigrationAction {
  return RUNTIME_MIGRATION_ACTIONS.has(action);
}

export function applyRuntimeMigrationItem(item: RuntimeMigrationItem): void {
  if (item.status !== "pending") {
    return;
  }
  try {
    switch (item.action) {
      case "retire-hooks": {
        if (!item.source) {
          item.status = "failed";
          item.message = "retire-hooks missing source";
          return;
        }
        verifyBoundMigrationResource(item, "source");
        removeBoundMigrationResource(item, "source");
        item.status = "applied";
        item.message = "retired whole-resource-proven Agentera hook";
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
  _ctx: MigrationContext,
): void {
  for (const item of items) {
    if (item.status !== "pending") {
      continue;
    }
    if (isRuntimeMigrationAction(item.action)) {
      applyRuntimeMigrationItem(item as RuntimeMigrationItem);
    } else {
      item.status = "failed";
      item.message = `unsupported runtime migration action: ${item.action}`;
    }
  }
}
