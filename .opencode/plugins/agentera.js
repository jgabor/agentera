// Agentera plugin for OpenCode
// Bootstraps slash commands at plugin init, injects AGENTERA_HOME via shell.env,
// writes session.yaml bookmarks via the generic event hook, routes exact bare
// `hej` messages through Agentera via chat.message, and validates artifact
// writes via tool.execute.before plus tool.execute.after.
// Install: copy to ~/.config/opencode/plugins/agentera.js or .opencode/plugins/agentera.js

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const AGENTERA_VERSION = "2.3.0";
const OPENCODE_SKILL_INSTALL_COMMAND = "npx skills add jgabor/agentera -g -a opencode --skill agentera -y";
const REQUIRED_SKILL_NAMES = ["agentera"];
const LEGACY_BRIDGE_SKILL_NAMES = new Set(["hej"]);

const COMMAND_TEMPLATES = {
  "agentera": `---
description: "Compound agent orchestration suite: 12 capabilities in one bundled skill; exact bare hej routes to the Agentera dashboard"
agentera_managed: true
---
Load and execute the agentera bundled skill for this project. If the user's complete message is exactly hej, route it through Agentera's hej dashboard path instead of a generic greeting.
`,
  "hej": `---
description: "Legacy /hej slash bridge only; bare text hej routes through agentera"
agentera_managed: true
---
Use this only for explicit legacy /hej slash-command upgrades. For a bare text message exactly hej, load agentera and run the Agentera hej dashboard path.
`,
};

const BARE_HEJ_ROUTED_PROMPT = [
  "agentera",
  "",
  "OpenCode adapter note: the original complete user message was exactly `hej`.",
  "Route it as Agentera Layer 1 bare `hej`: run `agentera hej` first, render the hej dashboard, and do not answer as a generic greeting.",
].join("\n");

function meaningfulParts(parts) {
  return Array.isArray(parts)
    ? parts.filter((part) => part && part.ignored !== true)
    : [];
}

function normalizeBareHejTransportText(text) {
  // `opencode run "hej"` arrives as `hej\n`; strip only that transport newline.
  return text.replace(/\r?\n$/, "");
}

function isBareHejUserMessage(parts) {
  const active = meaningfulParts(parts);
  if (active.length !== 1) return false;
  const [part] = active;
  return part.type === "text"
    && typeof part.text === "string"
    && normalizeBareHejTransportText(part.text) === "hej";
}

function routeBareHejMessage(output) {
  if (!isBareHejUserMessage(output?.parts)) return false;
  const part = meaningfulParts(output.parts)[0];
  part.text = BARE_HEJ_ROUTED_PROMPT;
  part.metadata = {
    ...(part.metadata || {}),
    agenteraRoute: "bare-hej",
    originalText: "hej",
  };
  return true;
}

function resolveOpencodeCommandsDir() {
  return process.env.OPENCODE_CONFIG_DIR
    ? path.join(process.env.OPENCODE_CONFIG_DIR, "commands")
    : path.join(process.env.HOME, ".config", "opencode", "commands");
}

function resolveOpencodeSkillsDir() {
  return process.env.OPENCODE_CONFIG_DIR
    ? path.join(process.env.OPENCODE_CONFIG_DIR, "skills")
    : path.join(process.env.HOME, ".config", "opencode", "skills");
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

const commandBootstrap = { lastReport: null };

function validSkillDir(skillDir, name) {
  return fs.existsSync(path.join(skillDir, name, "SKILL.md"));
}

function validManagedSkillDir(skillDir, name) {
  if (!validSkillDir(skillDir, name)) return false;
  if (!LEGACY_BRIDGE_SKILL_NAMES.has(name)) return true;
  try {
    return fs.readFileSync(path.join(skillDir, name, "SKILL.md"), "utf8").includes("legacy_bridge: true");
  } catch {
    return false;
  }
}

function resolveInstalledAgenteraSkillsDir() {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const candidates = [
    process.env.AGENTERA_HOME && path.join(process.env.AGENTERA_HOME, "skills"),
    path.join(process.env.HOME, ".agents", "agentera", "skills"),
    path.join(process.env.HOME, ".agents", "skills"),
    path.join(pluginRoot, "skills"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (REQUIRED_SKILL_NAMES.every((name) => validManagedSkillDir(candidate, name))) {
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

const skillBootstrap = { lastReport: null };

function bootstrapSkills() {
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
      if (!validManagedSkillDir(sourceDir, name)) {
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

function bootstrapCommands() {
  const report = {
    restored: [],
    refreshed: [],
    skippedUserOwned: [],
    unchanged: [],
    markerVersion: null,
  };
  try {
    const sourceDir = resolveInstalledAgenteraSkillsDir();
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
      if (LEGACY_BRIDGE_SKILL_NAMES.has(name) && (!sourceDir || !validManagedSkillDir(sourceDir, name))) {
        continue;
      }
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

function resolveAgenteraHome() {
  // Keep this adapter-local resolver aligned with the shared install-root
  // contract fixture in `.agentera/install_root_interface_model.yaml` and the
  // Python implementation in `scripts/install_root.py`: AGENTERA_HOME first,
  // then the default durable root. The legacy
  // `~/.agents/skills/agentera` fallback below is a temporary OpenCode-only
  // compatibility exception for older manual skill installs; do not add more
  // install-root identity rules here.
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

function validateArtifact(filePath, projectRoot) {
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
    execFileSync("uv", ["run", scriptPath], {
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

function validateArtifactCandidate(filePath, content, projectRoot) {
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
    const stdout = execFileSync("uv", ["run", scriptPath], {
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

function writeSessionBookmark(projectRoot) {
  try {
    const agenteraHome = resolveAgenteraHome();
    if (!agenteraHome) return;
    const scriptPath = path.join(agenteraHome, "hooks", "session_stop.py");
    if (!fs.existsSync(scriptPath)) return;
    const payload = JSON.stringify({
      cwd: projectRoot,
      hook_event_name: "session.idle",
    });
    execFileSync("uv", ["run", scriptPath], {
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
const lifecycle = { initCount: 0, lastInitAt: null };

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
      // Honor already-merged shell env, otherwise propagate caller-selected env.
      if (env.AGENTERA_HOME) return;
      if (process.env.AGENTERA_HOME) {
        env.AGENTERA_HOME = process.env.AGENTERA_HOME;
        return;
      }
      if (!initialAgenteraHome) return;
      env.AGENTERA_HOME = initialAgenteraHome;
    },

    "chat.message": async (_input, output) => {
      routeBareHejMessage(output);
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

Agentera.__test = {
  AGENTERA_VERSION,
  OPENCODE_SKILL_INSTALL_COMMAND,
  COMMAND_TEMPLATES,
  BARE_HEJ_ROUTED_PROMPT,
  bootstrapCommands,
  bootstrapSkills,
  commandBootstrap,
  hasManagedMarker,
  isBareHejUserMessage,
  lifecycle,
  normalizeBareHejTransportText,
  resolveAgenteraHome,
  resolveOpencodeCommandsDir,
  resolveOpencodeSkillsDir,
  routeBareHejMessage,
  skillBootstrap,
  validateArtifactCandidate,
  writeSessionBookmark,
};

// --- BEGIN GENERATED: INSTALL_ROOT_CONTRACT ---
const INSTALL_ROOT_CONTRACT = {
    "title": "Install Root Interface And Safety Model",
    "plan": "Deepen Agentera Install Root Module",
    "task": 3,
    "captured": "2026-05-05",
    "purpose": "Define the read-only install-root classification contract that setup, doctor, upgrade, and runtime callers will share in later tasks. This file is a model fixture only; it does not perform discovery, mutate bundle state, or migrate callers.\n",
    "source_precedence": [
      {
        "source": "explicit",
        "rank": 1,
        "label": "explicit --install-root",
        "rule": "Caller-provided roots always win."
      },
      {
        "source": "environment",
        "rank": 2,
        "label": "AGENTERA_HOME",
        "rule": "Environment roots are considered only when no explicit root was provided."
      },
      {
        "source": "default",
        "rank": 3,
        "label": "default durable root",
        "rule": "Default roots are used only when explicit and environment roots are absent."
      }
    ],
    "result_schema": {
      "required_fields": ["source", "kind", "safe_action", "diagnostic", "managed_status", "stale_status", "missing_evidence"],
      "field_contract": {
        "source": "One of explicit, environment, or default, with source_precedence.rank preserved.",
        "kind": "One root shape from root_kinds; callers must not infer bundle identity from paths.",
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
        "description": "Root is fresh and managed; callers may use the root without extra bundle identity checks.",
        "writes_files": false
      },
      "preview_refresh": {
        "description": "Root is managed but stale or missing at the default location; callers may present a dry-run refresh preview only.",
        "writes_files": false
      },
      "require_existing_managed_root": {
        "description": "Root was explicitly or environmentally selected but missing; callers must ask for a different managed root or explicit install approval.",
        "writes_files": false
      },
      "reject_file_path": {
        "description": "Root resolves to a file; callers must reject it and ask for a directory.",
        "writes_files": false
      },
      "reject_unmanaged_directory": {
        "description": "Root is a directory but lacks managed bundle evidence; callers must not overwrite it without an explicit force/install path.",
        "writes_files": false
      },
      "reject_invalid_bundle": {
        "description": "Root has partial or malformed bundle evidence; callers must report the invalid evidence and avoid refresh/apply commands.",
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
          "message": "install root is managed and fresh"
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
          "message": "install root is managed but stale"
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
          "message": "selected install root does not exist"
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
          "message": "default durable root is missing and may be created only by a confirmed install or refresh"
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
          "message": "selected install root is a file, not a directory"
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
          "message": "selected directory is not a managed Agentera bundle"
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
          "message": "selected directory has incomplete or malformed Agentera bundle evidence"
        },
        "missing_evidence": ["valid bundle marker and complete managed bundle evidence"]
      }
    },
    "inventory_links": {
      "canonical-suite-root-vs-managed-bundle-root": "canonical-suite-root-vs-managed-bundle-root",
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
