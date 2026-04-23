// Agentera plugin for OpenCode
// Provides SessionStart context preload, PostToolUse artifact validation, and Stop session bookmark.
// Install: copy to ~/.config/opencode/plugins/agentera.js or .opencode/plugins/agentera.js

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export const AGENTERA_VERSION = "1.15.0";

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

function resolveArtifacts(dir) {
  const docsPath = path.join(dir, ".agentera", "DOCS.md");
  if (fs.existsSync(docsPath)) {
    return { docsPath, root: dir, agenteraDir: path.join(dir, ".agentera") };
  }
  return { root: dir, agenteraDir: path.join(dir, ".agentera") };
}

function readIf(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
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

function validateArtifact(filePath) {
  try {
    const scriptPath = path.join(
      process.env.AGENTERA_HOME || path.join(process.env.HOME, ".agents", "skills", "agentera"),
      "scripts", "validate_spec.py"
    );
    if (!fs.existsSync(scriptPath)) return;
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

export const Agentera = async ({ project, client, $, directory, worktree }) => {
  const root = findAgenteraRoot(directory || worktree || process.cwd());
  const agenteraDir = path.join(root, ".agentera");
  setProfileDir();

  return {
    "session.created": async ({ event }) => {
      bootstrapCommands();

      const progress = readIf(path.join(agenteraDir, "PROGRESS.md"));
      const todo = readIf(path.join(root, "TODO.md"));
      const vision = readIf(path.join(root, "VISION.md"));
      const health = readIf(path.join(agenteraDir, "HEALTH.md"));

      const lines = [];
      if (progress) {
        const firstCycle = progress.split("\n").filter((l) => l.startsWith("■ ## Cycle"))[0];
        if (firstCycle) lines.push(`Last progress: ${firstCycle.replace("■ ## ", "")}`);
      }
      if (health) {
        const gradeLine = health.split("\n").find((l) => l.startsWith("**Grades**"));
        if (gradeLine) lines.push(gradeLine.replace(/\*\*/g, ""));
      }
      if (todo) {
        const criticals = todo.split("\n").filter((l) => l.includes("⇶") && l.includes("- [ ]"));
        if (criticals.length > 0) lines.push(`${criticals.length} critical issue(s) in TODO.md`);
      }

      if (lines.length > 0) {
        const ctx = [
          "Agentera context preload:",
          ...lines,
          "",
          "Read the relevant artifacts before starting work.",
        ].join("\n");
        try {
          await client.session.create({ message: ctx });
        } catch {}
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool === "write" || input.tool === "edit") {
        const filePath = output?.args?.filePath || output?.args?.path;
        if (filePath && isArtifactPath(filePath, root)) {
          validateArtifact(filePath);
        }
      }
    },

    "session.idle": async ({ event }) => {
      const sessionPath = path.join(agenteraDir, "SESSION.md");
      const timestamp = new Date().toISOString().replace("T", " ").split(".")[0];
      const entry = `\n- ${timestamp} session idle`;

      try {
        fs.mkdirSync(agenteraDir, { recursive: true });
        const existing = readIf(sessionPath) || "# Session\n";
        fs.writeFileSync(sessionPath, existing + entry);
      } catch {}
    },
  };
};
