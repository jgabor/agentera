// Agentera plugin for OpenCode
// Bootstraps slash commands at plugin init, injects AGENTERA_HOME via shell.env,
// and validates artifact writes via tool.execute.after.
// Install: copy to ~/.config/opencode/plugins/agentera.js or .opencode/plugins/agentera.js

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export const AGENTERA_VERSION = "1.22.0";

export const COMMAND_TEMPLATES = {
  "hej": `---
description: "Session entry point: briefing, status, and routing"
agentera_managed: true
---
Load and execute the hej skill for this project.
`,
  "visionera": `---
description: "Create or refine the project vision"
agentera_managed: true
---
Load and execute the visionera skill for this project.
`,
  "resonera": `---
description: "Structured deliberation through Socratic questioning"
agentera_managed: true
---
Load and execute the resonera skill for this project.
`,
  "inspirera": `---
description: "Analyze external sources and map patterns to this project"
agentera_managed: true
---
Load and execute the inspirera skill for this project.
`,
  "planera": `---
description: "Scale-adaptive planning with acceptance criteria"
agentera_managed: true
---
Load and execute the planera skill for this project.
`,
  "realisera": `---
description: "Run one autonomous development cycle"
agentera_managed: true
---
Load and execute the realisera skill for this project.
`,
  "optimera": `---
description: "Metric-driven optimization through experimentation"
agentera_managed: true
---
Load and execute the optimera skill for this project.
`,
  "inspektera": `---
description: "Codebase health audit with grades and findings"
agentera_managed: true
---
Load and execute the inspektera skill for this project.
`,
  "dokumentera": `---
description: "Documentation creation, maintenance, and audit"
agentera_managed: true
---
Load and execute the dokumentera skill for this project.
`,
  "profilera": `---
description: "Mine session history into a decision profile"
agentera_managed: true
---
Load and execute the profilera skill for this project.
`,
  "visualisera": `---
description: "Visual identity system creation and audit"
agentera_managed: true
---
Load and execute the visualisera skill for this project.
`,
  "orkestrera": `---
description: "Multi-cycle plan execution with evaluation gating"
agentera_managed: true
---
Load and execute the orkestrera skill for this project.
`,
};

export function resolveOpencodeCommandsDir() {
  return process.env.OPENCODE_CONFIG_DIR
    ? path.join(process.env.OPENCODE_CONFIG_DIR, "commands")
    : path.join(process.env.HOME, ".config", "opencode", "commands");
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
  return frontmatter.includes("agentera_managed: true");
}

export function bootstrapCommands() {
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
    if (existingVersion === AGENTERA_VERSION) return;

    for (const [name, content] of Object.entries(COMMAND_TEMPLATES)) {
      const targetFile = path.join(targetDir, `${name}.md`);
      if (fs.existsSync(targetFile) && !hasManagedMarker(targetFile)) {
        // user-owned file — skip
        continue;
      }
      fs.writeFileSync(targetFile, content);
    }

    fs.writeFileSync(markerFile, AGENTERA_VERSION);
  } catch (err) {
    console.error("[agentera] bootstrapCommands error:", err);
  }
}

function isArtifactPath(filePath, root) {
  const rel = path.relative(root, filePath);
  if (!rel) return false;
  const artifacts = [
    "VISION.md", "TODO.md", "CHANGELOG.md",
    path.join(".agentera", "PROGRESS.md"),
    path.join(".agentera", "DECISIONS.md"),
    path.join(".agentera", "PLAN.md"),
    path.join(".agentera", "HEALTH.md"),
    path.join(".agentera", "OBJECTIVE.md"),
    path.join(".agentera", "EXPERIMENTS.md"),
    path.join(".agentera", "DESIGN.md"),
    path.join(".agentera", "DOCS.md"),
    path.join(".agentera", "SESSION.md"),
  ];
  return artifacts.includes(rel);
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
    if (fs.existsSync(path.join(candidate, "scripts", "validate_spec.py"))) {
      return candidate;
    }
  }

  return null;
}

export function validateArtifact() {
  try {
    const agenteraHome = resolveAgenteraHome();
    if (!agenteraHome) return;
    const scriptPath = path.join(agenteraHome, "scripts", "validate_spec.py");
    execSync(`python3 "${scriptPath}"`, { timeout: 30000, stdio: "pipe" });
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

export const Agentera = async (_input, _options) => {
  lifecycle.initCount += 1;
  lifecycle.lastInitAt = new Date().toISOString();
  if (process.env.AGENTERA_DEBUG_LIFECYCLE) {
    console.error(`[agentera] plugin init fired at ${lifecycle.lastInitAt} (count=${lifecycle.initCount})`);
  }

  setProfileDir();
  bootstrapCommands();

  // Resolve install root once at init. Each shell.env invocation re-reads the
  // user-set AGENTERA_HOME so a value injected after plugin load (e.g. by a
  // wrapping shell) is preserved.
  const initialAgenteraHome = resolveAgenteraHome();

  return {
    "shell.env": async (_input, output) => {
      const env = output && output.env;
      if (!env || typeof env !== "object") return;
      // Honor any pre-existing value (process env or already-merged shell env).
      if (env.AGENTERA_HOME || process.env.AGENTERA_HOME) return;
      if (!initialAgenteraHome) return;
      env.AGENTERA_HOME = initialAgenteraHome;
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool === "write" || input.tool === "edit") {
        const filePath = output?.args?.filePath || output?.args?.path;
        const root = findAgenteraRoot(process.cwd());
        if (filePath && isArtifactPath(filePath, root)) {
          validateArtifact();
        }
      }
    },
  };
};
