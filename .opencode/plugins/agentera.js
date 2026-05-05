// Agentera plugin for OpenCode
// Bootstraps slash commands at plugin init, injects AGENTERA_HOME via shell.env,
// writes session.yaml bookmarks via the generic event hook, and validates
// artifact writes via tool.execute.before plus tool.execute.after.
// Install: copy to ~/.config/opencode/plugins/agentera.js or .opencode/plugins/agentera.js

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const AGENTERA_VERSION = "2.0.0";
export const OPENCODE_SKILL_INSTALL_COMMAND = "npx skills add jgabor/agentera -g -a opencode -y";

export const COMMAND_TEMPLATES = {
  "agentera": `---
description: "Compound agent orchestration suite — 12 capabilities in one bundled skill"
agentera_managed: true
---
Load and execute the agentera bundled skill for this project.
`,
};

export function resolveOpencodeCommandsDir() {
  return process.env.OPENCODE_CONFIG_DIR
    ? path.join(process.env.OPENCODE_CONFIG_DIR, "commands")
    : path.join(process.env.HOME, ".config", "opencode", "commands");
}

export function resolveOpencodeSkillsDir() {
  return process.env.OPENCODE_CONFIG_DIR
    ? path.join(process.env.OPENCODE_CONFIG_DIR, "skills")
    : path.join(process.env.HOME, ".config", "opencode", "skills");
}

export function hasManagedMarker(filePath) {
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

export const commandBootstrap = { lastReport: null };

function validSkillDir(skillDir, name) {
  return fs.existsSync(path.join(skillDir, name, "SKILL.md"));
}

export function resolveInstalledAgenteraSkillsDir() {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const candidates = [
    process.env.AGENTERA_HOME && path.join(process.env.AGENTERA_HOME, "skills"),
    path.join(process.env.HOME, ".agents", "agentera", "skills"),
    path.join(process.env.HOME, ".agents", "skills"),
    path.join(pluginRoot, "skills"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (Object.keys(COMMAND_TEMPLATES).every((name) => validSkillDir(candidate, name))) {
      return candidate;
    }
  }

  return null;
}

function isManagedSkillSymlink(targetPath, name) {
  let linkTarget;
  try {
    linkTarget = fs.readlinkSync(targetPath);
  } catch {
    return false;
  }

  const normalized = linkTarget.toLowerCase();
  return normalized.includes("agentera") || path.basename(linkTarget) === name;
}

export const skillBootstrap = { lastReport: null };

export function bootstrapSkills() {
  const report = {
    repaired: [],
    restored: [],
    skippedUserOwned: [],
    unchanged: [],
    missingSource: [],
    installCommand: null,
  };

  try {
    const sourceDir = resolveInstalledAgenteraSkillsDir();
    if (!sourceDir) {
      report.installCommand = OPENCODE_SKILL_INSTALL_COMMAND;
      console.error(`[agentera] OpenCode skills not found. Install with: ${OPENCODE_SKILL_INSTALL_COMMAND}`);
      skillBootstrap.lastReport = report;
      return report;
    }

    const targetDir = resolveOpencodeSkillsDir();
    fs.mkdirSync(targetDir, { recursive: true });

    for (const name of Object.keys(COMMAND_TEMPLATES)) {
      const sourceSkill = path.join(sourceDir, name);
      const targetSkill = path.join(targetDir, name);
      if (!validSkillDir(sourceDir, name)) {
        report.missingSource.push(name);
        continue;
      }

      let stat = null;
      try {
        stat = fs.lstatSync(targetSkill);
      } catch {
        fs.symlinkSync(sourceSkill, targetSkill, "dir");
        report.restored.push(name);
        continue;
      }

      if (fs.existsSync(path.join(targetSkill, "SKILL.md"))) {
        report.unchanged.push(name);
        continue;
      }

      if (!stat.isSymbolicLink() || !isManagedSkillSymlink(targetSkill, name)) {
        report.skippedUserOwned.push(name);
        continue;
      }

      fs.unlinkSync(targetSkill);
      fs.symlinkSync(sourceSkill, targetSkill, "dir");
      report.repaired.push(name);
    }
  } catch (err) {
    console.error("[agentera] bootstrapSkills error:", err);
  }

  skillBootstrap.lastReport = report;
  return report;
}

export function bootstrapCommands() {
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
    path.join(".agentera", "session.yaml"),
  ];
  return artifacts.includes(rel)
    || (
      rel.startsWith(path.join(".agentera", "optimera") + path.sep)
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

export function resolveAgenteraHome() {
  const candidates = [
    process.env.AGENTERA_HOME,
    path.join(process.env.HOME, ".agents", "agentera"),
    path.join(process.env.HOME, ".agents", "skills", "agentera"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, "scripts", "agentera"))
      || fs.existsSync(path.join(candidate, "scripts", "validate_capability.py"))
    ) {
      return candidate;
    }
  }

  return null;
}

export function validateArtifact(filePath, projectRoot) {
  try {
    const agenteraHome = resolveAgenteraHome();
    if (!agenteraHome || !filePath) return;
    const scriptPath = path.join(agenteraHome, "hooks", "validate_artifact.py");
    if (!fs.existsSync(scriptPath)) return;
    const payload = JSON.stringify({
      cwd: projectRoot,
      hook_event_name: "tool.execute.after",
      tool_name: "Edit",
      tool_input: { file_path: filePath },
    });
    execFileSync("python3", [scriptPath], {
      input: payload,
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
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

export function validateArtifactCandidate(filePath, content, projectRoot) {
  try {
    const agenteraHome = resolveAgenteraHome();
    if (!agenteraHome) return { permissionDecision: "allow" };
    const scriptPath = path.join(agenteraHome, "hooks", "validate_artifact.py");
    if (!fs.existsSync(scriptPath)) return { permissionDecision: "allow" };
    const payload = JSON.stringify({
      runtime: "opencode",
      cwd: projectRoot,
      hook_event_name: "tool.execute.before",
      tool_name: "Edit",
      tool_input: { file_path: filePath, content },
    });
    const stdout = execFileSync("python3", [scriptPath], {
      input: payload,
      encoding: "utf8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!stdout) return { permissionDecision: "allow" };
    const decision = JSON.parse(stdout);
    if (!decision || typeof decision !== "object") {
      return { permissionDecision: "allow" };
    }
    return decision;
  } catch (err) {
    if (err && (err.status === 2 || err.status === 1)) {
      const reason = String(err.stderr || err.stdout || "Artifact validation failed").trim();
      return {
        permissionDecision: "deny",
        permissionDecisionReason: reason || "Artifact validation failed",
      };
    }
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

export function writeSessionBookmark(projectRoot) {
  try {
    const agenteraHome = resolveAgenteraHome();
    if (!agenteraHome) return;
    const scriptPath = path.join(agenteraHome, "hooks", "session_stop.py");
    if (!fs.existsSync(scriptPath)) return;
    const payload = JSON.stringify({
      cwd: projectRoot,
      hook_event_name: "session.idle",
    });
    execFileSync("python3", [scriptPath], {
      input: payload,
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {}
}

function setProfileDir() {
  if (process.env.PROFILERA_PROFILE_DIR) return;
  if (process.platform === "darwin") {
    process.env.PROFILERA_PROFILE_DIR = path.join(
      process.env.HOME, "Library", "Application Support", "agentera"
    );
  } else if (process.platform === "win32") {
    process.env.PROFILERA_PROFILE_DIR = path.join(
      process.env.APPDATA || path.join(process.env.USERPROFILE, "AppData", "Roaming"),
      "agentera"
    );
  } else {
    process.env.PROFILERA_PROFILE_DIR = path.join(
      process.env.XDG_DATA_HOME || path.join(process.env.HOME, ".local", "share"),
      "agentera"
    );
  }
}

// Lifecycle counter: increments every time OpenCode invokes the Agentera
// plugin function. Exported (and reset by) the smoke runner so the test
// harness can confirm the plan's "once per plugin load" assumption empirically.
export const lifecycle = { initCount: 0, lastInitAt: null };

export const Agentera = async (input = {}, _options) => {
  lifecycle.initCount += 1;
  lifecycle.lastInitAt = new Date().toISOString();
  if (process.env.AGENTERA_DEBUG_LIFECYCLE) {
    console.error(`[agentera] plugin init fired at ${lifecycle.lastInitAt} (count=${lifecycle.initCount})`);
  }

  setProfileDir();
  bootstrapCommands();
  bootstrapSkills();

  // Resolve install root once at init. Each shell.env invocation re-reads the
  // user-set AGENTERA_HOME so a value injected after plugin load (e.g. by a
  // wrapping shell) is preserved.
  const initialAgenteraHome = resolveAgenteraHome();
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
      // Honor any pre-existing value (process env or already-merged shell env).
      if (env.AGENTERA_HOME || process.env.AGENTERA_HOME) return;
      if (!initialAgenteraHome) return;
      env.AGENTERA_HOME = initialAgenteraHome;
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
  };
};
