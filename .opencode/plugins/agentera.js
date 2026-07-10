// Agentera plugin for OpenCode
// Bootstraps slash commands at plugin init, injects AGENTERA_HOME via shell.env,
// writes runtime-local session bookmarks via the generic event hook, and validates
// artifact writes via tool.execute.before plus tool.execute.after.
// Install: copy to ~/.config/opencode/plugins/agentera.js or .opencode/plugins/agentera.js

import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const AGENTERA_VERSION = "3.0.0";
const NPX_BUNDLE_SENTINEL = ".agentera-npx-bundle.json";
const NPX_CLI_ENTRYPOINT = "npx -y agentera@next";
const NPX_HOOK_VALIDATE = `${NPX_CLI_ENTRYPOINT} hook validate-artifact`;
const NPX_HOOK_SESSION_STOP = `${NPX_CLI_ENTRYPOINT} hook session-stop`;
const REQUIRED_AGENT_NAMES = ["agentera"];
const AGENTERA_AGENT_MARKER = "<!-- agentera: managed -->";

const COMMAND_TEMPLATES = {
  "agentera": `---
description: "Compound agent orchestration suite: 12 capabilities in one bundled skill"
agentera_managed: true
---
Load and execute the agentera bundled skill for this project.
`,
};

function resolveOpencodeCommandsDir() {
  return process.env.OPENCODE_CONFIG_DIR
    ? path.join(process.env.OPENCODE_CONFIG_DIR, "commands")
    : path.join(process.env.HOME, ".config", "opencode", "commands");
}

function resolveOpencodeAgentsDir() {
  return process.env.OPENCODE_CONFIG_DIR
    ? path.join(process.env.OPENCODE_CONFIG_DIR, "agents")
    : path.join(process.env.HOME, ".config", "opencode", "agents");
}

function hasManagedMarker(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  const lines = content.split("\n");
  if (lines[0] !== "---") return false;
  const closingIdx = lines.indexOf("---", 1);
  if (closingIdx === -1) return false;
  const frontmatter = lines.slice(1, closingIdx).join("\n");
  return /^agentera_managed:\s*true\s*$/m.test(frontmatter);
}

function hasManagedAgentMarker(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  const lines = content.split("\n");
  if (lines[0] !== "---") return false;
  const closingIdx = lines.indexOf("---", 1);
  if (closingIdx === -1) return false;
  return lines.slice(closingIdx + 1).some((line) => line.trim() === AGENTERA_AGENT_MARKER);
}

const commandBootstrap = { lastReport: null };

function validAgentDescriptor(sourceDir, name) {
  const descriptor = path.join(sourceDir, `${name}.md`);
  return fs.existsSync(descriptor) && hasManagedAgentMarker(descriptor);
}

function resolveInstalledOpenCodeAgentsDir() {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const candidates = [
    path.join(pluginRoot, ".opencode", "agents"),
    path.join(process.env.HOME, ".config", "opencode", "agents"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (REQUIRED_AGENT_NAMES.every((name) => validAgentDescriptor(candidate, name))) {
      return candidate;
    }
  }

  return null;
}

const agentBootstrap = { lastReport: null };

function bootstrapAgents() {
  const report = {
    restored: [],
    refreshed: [],
    skippedUserOwned: [],
    unchanged: [],
    missingSource: [],
    markerVersion: null,
  };
  try {
    const sourceDir = resolveInstalledOpenCodeAgentsDir();
    if (!sourceDir) {
      report.missingSource = [...REQUIRED_AGENT_NAMES];
      agentBootstrap.lastReport = report;
      return report;
    }

    const targetDir = resolveOpencodeAgentsDir();
    fs.mkdirSync(targetDir, { recursive: true });

    const markerFile = path.join(targetDir, ".agentera-version");
    let existingVersion = null;
    try {
      existingVersion = fs.readFileSync(markerFile, "utf8").trim();
    } catch {
      // marker absent — proceed
    }
    report.markerVersion = existingVersion;

    for (const name of REQUIRED_AGENT_NAMES) {
      const sourceFile = path.join(sourceDir, `${name}.md`);
      const targetFile = path.join(targetDir, `${name}.md`);
      if (!validAgentDescriptor(sourceDir, name)) {
        report.missingSource.push(name);
        continue;
      }

      const content = fs.readFileSync(sourceFile, "utf8");
      if (!fs.existsSync(targetFile)) {
        fs.writeFileSync(targetFile, content);
        report.restored.push(name);
        continue;
      }

      const existingContent = fs.readFileSync(targetFile, "utf8");
      if (existingContent === content) {
        report.unchanged.push(name);
        continue;
      }

      if (!hasManagedAgentMarker(targetFile) && !hasManagedMarker(targetFile)) {
        report.skippedUserOwned.push(name);
        continue;
      }

      fs.writeFileSync(targetFile, content);
      report.refreshed.push(name);
    }

    if (existingVersion !== AGENTERA_VERSION || report.restored.length || report.refreshed.length) {
      fs.writeFileSync(markerFile, AGENTERA_VERSION);
    }
  } catch (err) {
    console.error("[agentera] bootstrapAgents error:", err);
  }
  agentBootstrap.lastReport = report;
  return report;
}

function bootstrapCommands() {
  const report = {
    restored: [],
    refreshed: [],
    skippedUserOwned: [],
    unchanged: [],
    markerVersion: null,
  };
  try {
    const targetDir = resolveOpencodeCommandsDir();
    fs.mkdirSync(targetDir, { recursive: true });

    const markerFile = path.join(targetDir, ".agentera-version");
    let existingVersion = null;
    try {
      existingVersion = fs.readFileSync(markerFile, "utf8").trim();
    } catch {
      // marker absent — proceed
    }
    report.markerVersion = existingVersion;

    for (const [name, content] of Object.entries(COMMAND_TEMPLATES)) {
      const targetFile = path.join(targetDir, `${name}.md`);
      if (!fs.existsSync(targetFile)) {
        fs.writeFileSync(targetFile, content);
        report.restored.push(name);
        continue;
      }

      const existingContent = fs.readFileSync(targetFile, "utf8");
      if (existingContent === content) {
        report.unchanged.push(name);
        continue;
      }

      if (!hasManagedMarker(targetFile)) {
        report.skippedUserOwned.push(name);
        continue;
      }

      fs.writeFileSync(targetFile, content);
      report.refreshed.push(name);
    }

    if (existingVersion !== AGENTERA_VERSION || report.restored.length || report.refreshed.length) {
      fs.writeFileSync(markerFile, AGENTERA_VERSION);
    }
  } catch (err) {
    console.error("[agentera] bootstrapCommands error:", err);
  }
  commandBootstrap.lastReport = report;
  return report;
}

function isArtifactPath(filePath, root) {
  const target = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  const rel = path.relative(root, target);
  if (!rel) return false;
  const artifacts = [
    "TODO.md", "CHANGELOG.md", "DESIGN.md",
    path.join(".agentera", "vision.yaml"),
    path.join(".agentera", "progress.yaml"),
    path.join(".agentera", "decisions.yaml"),
    path.join(".agentera", "plan.yaml"),
    path.join(".agentera", "health.yaml"),
    path.join(".agentera", "docs.yaml"),
  ];
  return artifacts.includes(rel)
    || (
      rel.startsWith(path.join(".agentera", "optimize") + path.sep)
      && ["objective.yaml", "experiments.yaml"].includes(path.basename(rel))
    );
}

function findAgenteraRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, ".agentera"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

function resolveUserDataHome() {
  if (process.env.AGENTERA_HOME && fs.existsSync(process.env.AGENTERA_HOME)) {
    return process.env.AGENTERA_HOME;
  }
  return resolveDefaultAgenteraAppHome();
}

function resolveDefaultAgenteraAppHome() {
  if (process.platform === "darwin") {
    return path.join(process.env.HOME, "Library", "Application Support", "agentera");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(process.env.USERPROFILE || process.env.HOME, "AppData", "Roaming"),
      "agentera"
    );
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME, ".local", "share"), "agentera");
}

function hasV3NpxBundleEvidence(candidate) {
  return (
    fs.existsSync(path.join(candidate, NPX_BUNDLE_SENTINEL))
    && fs.existsSync(path.join(candidate, "skills", "agentera", "SKILL.md"))
    && fs.existsSync(path.join(candidate, "registry.json"))
  );
}

function isRunnableAgenteraAppRoot(candidate) {
  if (!candidate || !fs.existsSync(candidate)) {
    return false;
  }
  if (fs.existsSync(path.join(candidate, "scripts", "validate_capability.py"))) {
    return true;
  }
  if (fs.existsSync(path.join(candidate, "scripts", "agentera"))) {
    return true;
  }
  return hasV3NpxBundleEvidence(candidate);
}

function isValidAgenteraAppHome(candidate) {
  return typeof candidate === "string" && fs.existsSync(candidate);
}

function resolveAgenteraAppHome() {
  if (!resolveAgenteraHome()) {
    return null;
  }
  return resolveUserDataHome();
}

function resolveAgenteraHome() {
  // Keep this adapter-local resolver aligned with the shared app-home
  // contract fixture in `.agentera/install_root_interface_model.yaml` and the
  // Python implementation in `scripts/install_root.py`: AGENTERA_HOME names an
  // app home, with managed app code under app/. Checkout roots remain accepted
  // only for local development and smoke tests.
  const candidates = [
    process.env.AGENTERA_HOME && path.join(process.env.AGENTERA_HOME, "app"),
    process.env.AGENTERA_HOME && fs.existsSync(path.join(process.env.AGENTERA_HOME, ".git")) && process.env.AGENTERA_HOME,
    path.join(resolveDefaultAgenteraAppHome(), "app"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (isRunnableAgenteraAppRoot(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveLocalCli(projectRoot) {
  if (!projectRoot) return null;
  const localDist = path.join(projectRoot, "packages", "cli", "dist", "bin", "agentera.js");
  if (fs.existsSync(localDist)) return localDist;
  return null;
}

function buildHookArgs(projectRoot, subcommand) {
  const localCli = resolveLocalCli(projectRoot);
  if (localCli) {
    return { cmd: "node", args: [localCli, "hook", subcommand] };
  }
  const args = NPX_CLI_ENTRYPOINT.split(/\s+/).slice(1);
  args.push("hook", subcommand);
  return { cmd: "npx", args };
}

function runNpxHook(subcommand, payload, projectRoot) {
  const { cmd, args } = buildHookArgs(projectRoot || process.cwd(), subcommand);
  execFileSync(cmd, args, {
    input: payload,
    timeout: 30000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENTERA_HOME: resolveUserDataHome() },
  });
}

function validateArtifact(filePath, projectRoot) {
  try {
    if (!filePath) return;
    const payload = JSON.stringify({
      cwd: projectRoot,
      hook_event_name: "tool.execute.after",
      tool_name: "Edit",
      tool_input: { file_path: filePath },
    });
    runNpxHook("validate-artifact", payload, projectRoot);
  } catch {}
}

function resolveToolFilePath(args, root) {
  const rawPath = args?.filePath || args?.path || args?.file_path;
  if (!rawPath || typeof rawPath !== "string") return null;
  return path.isAbsolute(rawPath) ? rawPath : path.join(root, rawPath);
}

function firstStringArg(args, names) {
  for (const name of names) {
    if (typeof args[name] === "string") return args[name];
  }
  return undefined;
}

function reconstructCandidate(tool, args, root) {
  if (!args || typeof args !== "object") return null;
  const filePath = resolveToolFilePath(args, root);
  if (!filePath) return null;

  if (tool === "write") {
    const content = firstStringArg(args, ["content", "text", "newContent", "new_content"]);
    return typeof content === "string" ? { filePath, content } : null;
  }

  if (tool !== "edit") return null;
  const oldText = firstStringArg(args, ["oldString", "old_string", "oldText", "old_text"]);
  const newText = firstStringArg(args, ["newString", "new_string", "newText", "new_text"]);
  if (typeof oldText !== "string" || typeof newText !== "string") return null;

  let current;
  try {
    current = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  if (args.replaceAll === true || args.replace_all === true) {
    return current.includes(oldText)
      ? { filePath, content: current.replaceAll(oldText, newText) }
      : null;
  }

  const first = current.indexOf(oldText);
  if (first === -1 || current.indexOf(oldText, first + oldText.length) !== -1) {
    return null;
  }
  return {
    filePath,
    content: current.slice(0, first) + newText + current.slice(first + oldText.length),
  };
}

function validateArtifactCandidate(filePath, content, projectRoot) {
  try {
    const payload = JSON.stringify({
      runtime: "opencode",
      cwd: projectRoot,
      hook_event_name: "tool.execute.before",
      tool_name: "Edit",
      tool_input: { file_path: filePath, content },
    });
    const localCli = resolveLocalCli(projectRoot);
    let result;
    if (localCli) {
      result = spawnSync("node", [localCli, "hook", "validate-artifact"], {
        input: payload,
        encoding: "utf8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, AGENTERA_HOME: resolveUserDataHome() },
      });
    } else {
      const args = NPX_CLI_ENTRYPOINT.split(/\s+/).slice(1);
      args.push("hook", "validate-artifact");
      result = spawnSync("npx", args, {
        input: payload,
        encoding: "utf8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, AGENTERA_HOME: resolveUserDataHome() },
      });
    }
    if (result.status === 2) {
      const reason = String(result.stderr || "Artifact validation failed").trim();
      return {
        permissionDecision: "deny",
        permissionDecisionReason: reason || "Artifact validation failed",
      };
    }
    return { permissionDecision: "allow" };
  } catch (err) {
    return { permissionDecision: "allow" };
  }
}

function hardGateArtifactCandidate(input, output, projectRoot) {
  const candidate = reconstructCandidate(input?.tool, output?.args, projectRoot);
  if (!candidate) return;
  const decision = validateArtifactCandidate(candidate.filePath, candidate.content, projectRoot);
  if (decision.permissionDecision !== "deny") return;
  throw new Error(decision.permissionDecisionReason || "Artifact validation failed");
}

function writeSessionBookmark(projectRoot) {
  try {
    const payload = JSON.stringify({
      cwd: projectRoot,
      hook_event_name: "session.idle",
    });
    runNpxHook("session-stop", payload);
  } catch {}
}

function formatCompactionStateContext(state) {
  if (!state || typeof state !== "object") return null;
  const lines = ["Agentera project state summary from `agentera prime --format json`:"];
  if (state.mode) lines.push(`- mode: ${state.mode}`);
  if (state.profile?.status) lines.push(`- profile: ${state.profile.status}`);
  if (state.health?.grade) lines.push(`- health: ${state.health.grade}${state.health.trajectory ? `; ${state.health.trajectory}` : ""}`);
  if (state.issues && typeof state.issues === "object") {
    const issueText = ["critical", "degraded", "normal", "annoying"]
      .filter((key) => Number.isFinite(state.issues[key]) && state.issues[key] > 0)
      .map((key) => `${key}=${state.issues[key]}`)
      .join(", ");
    if (issueText) lines.push(`- issues: ${issueText}`);
  }
  if (state.plan?.exists) {
    lines.push(`- plan: ${state.plan.status || "unknown"}${state.plan.title ? `; ${state.plan.title}` : ""}`);
    if (state.plan.first_pending?.name) lines.push(`- next plan task: ${state.plan.first_pending.name}`);
  }
  if (state.progress?.latest) {
    const latest = state.progress.latest;
    lines.push(`- latest progress: ${latest.number || "unknown"}${latest.what ? `; ${latest.what}` : ""}`);
    if (latest.next) lines.push(`- progress next: ${latest.next}`);
  }
  if (state.next_action?.object) lines.push(`- next action: ${state.next_action.object}`);
  const attention = Array.isArray(state.attention) ? state.attention.slice(0, 3) : [];
  for (const item of attention) lines.push(`- attention: ${item}`);
  return lines.slice(0, 12).join("\n").slice(0, 6000);
}

function buildCompactionContext(projectRoot) {
  try {
    const args = NPX_CLI_ENTRYPOINT.split(/\s+/).slice(1);
    args.push("prime", "--format", "json");
    const stdout = execFileSync("npx", args, {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENTERA_HOME: resolveUserDataHome() },
    }).trim();
    return formatCompactionStateContext(JSON.parse(stdout));
  } catch {
    return null;
  }
}

// One-time deprecation guard for the PROFILERA_PROFILE_DIR → AGENTERA_PROFILE_DIR
// rename. Resettable via Agentera.__test.profileraDeprecation so tests can verify
// the "fires only once per process" contract in isolation.
const profileraDeprecation = { warned: false };

function setProfileDir() {
  // 1. AGENTERA_PROFILE_DIR already set (canonical): respect it.
  if (process.env.AGENTERA_PROFILE_DIR) return;
  // 2. Legacy PROFILERA_PROFILE_DIR set by a v2 install: adopt its value as the
  //    canonical AGENTERA_PROFILE_DIR and warn once per process.
  if (process.env.PROFILERA_PROFILE_DIR) {
    process.env.AGENTERA_PROFILE_DIR = process.env.PROFILERA_PROFILE_DIR;
    if (!profileraDeprecation.warned) {
      profileraDeprecation.warned = true;
      process.stderr.write(
        "[agentera] PROFILERA_PROFILE_DIR is deprecated; run `agentera upgrade` to migrate to AGENTERA_PROFILE_DIR\n",
      );
    }
    return;
  }
  // 3. Neither set: seed AGENTERA_PROFILE_DIR from the platform data-home default.
  if (process.platform === "darwin") {
    process.env.AGENTERA_PROFILE_DIR = path.join(
      process.env.HOME, "Library", "Application Support", "agentera"
    );
  } else if (process.platform === "win32") {
    process.env.AGENTERA_PROFILE_DIR = path.join(
      process.env.APPDATA || path.join(process.env.USERPROFILE, "AppData", "Roaming"),
      "agentera"
    );
  } else {
    process.env.AGENTERA_PROFILE_DIR = path.join(
      process.env.XDG_DATA_HOME || path.join(process.env.HOME, ".local", "share"),
      "agentera"
    );
  }
}

// Lifecycle counter: increments every time OpenCode invokes the Agentera
// plugin function. Exported (and reset by) the smoke runner so the test
// harness can confirm the plan's "once per plugin load" assumption empirically.
const lifecycle = { initCount: 0, lastInitAt: null };

export const Agentera = async (input = {}, _options) => {
  lifecycle.initCount += 1;
  lifecycle.lastInitAt = new Date().toISOString();
  if (process.env.AGENTERA_DEBUG_LIFECYCLE) {
    console.error(`[agentera] plugin init fired at ${lifecycle.lastInitAt} (count=${lifecycle.initCount})`);
  }

  setProfileDir();
  bootstrapCommands();
  bootstrapAgents();

  // Resolve app home once at init. shell.env must propagate the validated app
  // home, not stale parent-process residue inherited by the runtime.
  const initialAgenteraAppHome = resolveAgenteraAppHome();
  const projectRoot = findAgenteraRoot(input.worktree || input.directory || process.cwd());

  return {
    event: async (payload) => {
      const event = payload?.event;
      if (!event) return;
      if (event.type === "session.created") return;
      if (event.type !== "session.idle") return;
      writeSessionBookmark(projectRoot);
    },

    "shell.env": async (_input, output) => {
      const env = output && output.env;
      if (!env || typeof env !== "object") return;
      if (!initialAgenteraAppHome) return;
      if (isValidAgenteraAppHome(env.AGENTERA_HOME)) return;
      env.AGENTERA_HOME = initialAgenteraAppHome;
    },

    "tool.execute.before": async (input, output) => {
      hardGateArtifactCandidate(input, output, projectRoot);
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool === "write" || input.tool === "edit") {
        const root = projectRoot;
        const filePath = resolveToolFilePath(input?.args || output?.args, root);
        if (filePath && isArtifactPath(filePath, root)) {
          validateArtifact(filePath, root);
        }
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      if (!output || !Array.isArray(output.context)) return;
      const context = buildCompactionContext(projectRoot);
      if (context) output.context.push(context);
    },
  };
};

Agentera.__test = {
  AGENTERA_VERSION,
  AGENTERA_AGENT_MARKER,
  COMMAND_TEMPLATES,
  REQUIRED_AGENT_NAMES,
  bootstrapCommands,
  bootstrapAgents,
  agentBootstrap,
  commandBootstrap,
  hasManagedAgentMarker,
  hasManagedMarker,
  buildCompactionContext,
  formatCompactionStateContext,
  lifecycle,
  resolveAgenteraHome,
  resolveAgenteraAppHome,
  resolveDefaultAgenteraAppHome,
  isRunnableAgenteraAppRoot,
  hasV3NpxBundleEvidence,
  isValidAgenteraAppHome,
  resolveOpencodeCommandsDir,
  resolveOpencodeAgentsDir,
  setProfileDir,
  profileraDeprecation,
  validateArtifactCandidate,
  writeSessionBookmark,
};

// --- BEGIN GENERATED: INSTALL_ROOT_CONTRACT ---
const INSTALL_ROOT_CONTRACT = {
    "title": "App Home Interface And Safety Model",
    "plan": "Deepen Agentera Install Root Module",
    "task": 3,
    "captured": "2026-05-05",
    "purpose": "Define the read-only app-home classification contract that setup, doctor, upgrade, and runtime callers share. AGENTERA_HOME names the durable app home; managed app code lives under AGENTERA_HOME/app. This file is a model fixture only; it does not perform discovery, mutate app state, or migrate callers.\n",
    "source_precedence": [
      {
        "source": "explicit",
        "rank": 1,
        "label": "explicit --install-root",
        "rule": "Caller-provided app homes always win."
      },
      {
        "source": "environment",
        "rank": 2,
        "label": "AGENTERA_HOME",
        "rule": "Environment app homes are considered only when no explicit app home was provided."
      },
      {
        "source": "default",
        "rank": 3,
        "label": "default app home",
        "rule": "Default app homes are used only when explicit and environment app homes are absent."
      }
    ],
    "result_schema": {
      "required_fields": ["source", "kind", "safe_action", "diagnostic", "managed_status", "stale_status", "missing_evidence"],
      "field_contract": {
        "source": "One of explicit, environment, or default, with source_precedence.rank preserved.",
        "kind": "One app-home shape from root_kinds; callers must not infer managed app identity from paths.",
        "safe_action": "One action from safe_actions; classification itself never writes files.",
        "diagnostic": "Structured code, severity, message, and evidence for humans and JSON callers.",
        "managed_status": "managed, unmanaged, missing, invalid, or unknown.",
        "stale_status": "fresh, stale, not_applicable, or unknown.",
        "missing_evidence": "Required canonical evidence that was absent; empty when no evidence is missing."
      }
    },
    "mutation_policy": {
      "classification_writes_files": false,
      "durable_bundle_writes_allowed": false,
      "dry_run_allowed": true,
      "apply_requires_separate_confirmation": true
    },
    "bundle_identity": {
      "owner": "install_root_interface",
      "caller_local_identity_rules_allowed": false,
      "managed_bundle_evidence": ["scripts/agentera", "skills/agentera/SKILL.md", "registry.json", ".agentera-bundle.json"],
      "valid_for_callers": ["setup", "doctor", "upgrade", "runtime"]
    },
    "safe_actions": {
      "use_root": {
        "description": "App home has fresh managed app code; callers may use AGENTERA_HOME/app without extra identity checks.",
        "writes_files": false
      },
      "preview_refresh": {
        "description": "App home has stale or missing managed app code at app/; callers may present a dry-run refresh preview only.",
        "writes_files": false
      },
      "require_existing_managed_root": {
        "description": "App home was explicitly or environmentally selected but missing; callers must ask for a different managed app home or explicit install approval.",
        "writes_files": false
      },
      "reject_file_path": {
        "description": "App home resolves to a file; callers must reject it and ask for a directory.",
        "writes_files": false
      },
      "reject_unmanaged_directory": {
        "description": "App home is a directory but lacks recognized Agentera state or managed app evidence; callers must not overwrite it without an explicit force/install path.",
        "writes_files": false
      },
      "reject_invalid_bundle": {
        "description": "App home or its app/ directory has partial or malformed managed app evidence; callers must report the invalid evidence and avoid refresh/apply commands.",
        "writes_files": false
      }
    },
    "root_kinds": {
      "managed_fresh": {
        "managed_status": "managed",
        "stale_status": "fresh",
        "safe_action": "use_root",
        "diagnostic": {
          "code": "install_root.managed_fresh",
          "severity": "info",
          "message": "app home has fresh managed app code under app/"
        },
        "missing_evidence": []
      },
      "managed_stale": {
        "managed_status": "managed",
        "stale_status": "stale",
        "safe_action": "preview_refresh",
        "diagnostic": {
          "code": "install_root.managed_stale",
          "severity": "warning",
          "message": "app home has stale managed app code under app/"
        },
        "missing_evidence": ["current bundle marker/version or required CLI command evidence"]
      },
      "missing_explicit_or_environment": {
        "managed_status": "missing",
        "stale_status": "not_applicable",
        "safe_action": "require_existing_managed_root",
        "diagnostic": {
          "code": "install_root.missing_selected_root",
          "severity": "error",
          "message": "selected app home does not exist"
        },
        "missing_evidence": ["directory", "managed bundle evidence"]
      },
      "missing_default": {
        "managed_status": "missing",
        "stale_status": "stale",
        "safe_action": "preview_refresh",
        "diagnostic": {
          "code": "install_root.missing_default_root",
          "severity": "warning",
          "message": "default app home is missing and may be created only by a confirmed install or refresh"
        },
        "missing_evidence": ["directory", "managed bundle evidence"]
      },
      "file_valued_root": {
        "managed_status": "invalid",
        "stale_status": "not_applicable",
        "safe_action": "reject_file_path",
        "diagnostic": {
          "code": "install_root.file_path",
          "severity": "error",
          "message": "selected app home is a file, not a directory"
        },
        "missing_evidence": ["directory"]
      },
      "unmanaged_directory": {
        "managed_status": "unmanaged",
        "stale_status": "not_applicable",
        "safe_action": "reject_unmanaged_directory",
        "diagnostic": {
          "code": "install_root.unmanaged_directory",
          "severity": "error",
          "message": "selected directory is not a recognized Agentera app home"
        },
        "missing_evidence": ["managed bundle evidence"]
      },
      "invalid_bundle": {
        "managed_status": "invalid",
        "stale_status": "unknown",
        "safe_action": "reject_invalid_bundle",
        "diagnostic": {
          "code": "install_root.invalid_bundle",
          "severity": "error",
          "message": "selected app home has incomplete or malformed managed app evidence"
        },
        "missing_evidence": ["valid bundle marker and complete managed bundle evidence"]
      }
    },
    "inventory_links": {
      "canonical-suite-root-vs-managed-app-root": "canonical-suite-root-vs-managed-app-root",
      "behavior_shape_map": {
        "valid setup root": "managed_fresh",
        "missing explicit setup root": "missing_explicit_or_environment",
        "file explicit setup root": "file_valued_root",
        "unmanaged explicit setup directory": "unmanaged_directory",
        "env-derived valid setup root": "managed_fresh",
        "auto-detect/default setup root": "managed_fresh",
        "fresh managed upgrade root": "managed_fresh",
        "stale managed upgrade root": "managed_stale",
        "missing explicit or AGENTERA_HOME upgrade root": "missing_explicit_or_environment",
        "missing default upgrade root": "missing_default",
        "file upgrade root": "file_valued_root",
        "unmanaged upgrade directory": "unmanaged_directory",
        "OpenCode runtime AGENTERA_HOME candidate": "managed_fresh"
      }
    }
  };
// --- END GENERATED: INSTALL_ROOT_CONTRACT ---
