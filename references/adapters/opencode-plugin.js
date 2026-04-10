// Agentera plugin for OpenCode
// Provides SessionStart context preload, PostToolUse artifact validation, and Stop session bookmark.
// Install: copy to ~/.config/opencode/plugins/agentera.js or .opencode/plugins/agentera.js

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

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

export const Agentera = async ({ project, client, $, directory, worktree }) => {
  const root = findAgenteraRoot(directory || worktree || process.cwd());
  const agenteraDir = path.join(root, ".agentera");

  return {
    "session.created": async ({ event }) => {
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
