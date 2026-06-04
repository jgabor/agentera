import fs from "node:fs";
import path from "node:path";

import { expanduser, isFile, pathExists } from "../../core/paths.js";
import { CAPABILITY_AGENT_NAMES } from "./constants.js";

export interface AgentDescriptorChange {
  action: string;
  name: string;
  source: string;
  target: string;
  message: string;
  content: string;
}

export function codexAgentSourceDir(installRoot: string): string {
  const candidates = [
    path.join(installRoot, "app", "skills", "agentera", "agents"),
    path.join(installRoot, "skills", "agentera", "agents"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* not a dir */
    }
  }
  return candidates[0];
}

export function defaultAgentsDirForConfig(configPath: string): string {
  const expanded = expanduser(configPath);
  if (path.basename(expanded) === "config.toml" && path.basename(path.dirname(expanded)) === ".codex") {
    return path.join(path.dirname(expanded), "agents");
  }
  throw new Error(
    "Codex agent descriptors can be inferred only for documented config layouts: " +
      "~/.codex/config.toml or <project>/.codex/config.toml. " +
      "Pass --agents-dir for nonstandard --config-file paths.",
  );
}

function codexDescriptorManaged(text: string): boolean {
  const lines = text.split(/\r\n|\r|\n/).slice(0, 5);
  return lines.some((line) => line.trim() === "# agentera_managed: true");
}

export function planAgentDescriptorChanges(
  installRoot: string,
  agentsDir: string,
  opts: { force: boolean },
): AgentDescriptorChange[] {
  const sourceDir = codexAgentSourceDir(installRoot);
  const changes: AgentDescriptorChange[] = [];
  for (const name of CAPABILITY_AGENT_NAMES) {
    const source = path.join(sourceDir, `${name}.toml`);
    const target = path.join(agentsDir, `${name}.toml`);
    let sourceText: string;
    try {
      sourceText = fs.readFileSync(source, "utf8");
    } catch {
      changes.push({ action: "blocked", name, source, target, message: "source descriptor is missing", content: "" });
      continue;
    }
    if (!pathExists(target)) {
      changes.push({ action: "pending", name, source, target, message: "would install Codex agent descriptor", content: sourceText });
      continue;
    }
    if (!isFile(target)) {
      changes.push({ action: "blocked", name, source, target, message: "target exists but is not a regular file", content: sourceText });
      continue;
    }
    let targetText: string;
    try {
      targetText = fs.readFileSync(target, "utf8");
    } catch (exc) {
      changes.push({ action: "blocked", name, source, target, message: `cannot read target descriptor: ${(exc as Error).message}`, content: sourceText });
      continue;
    }
    if (targetText === sourceText) {
      changes.push({ action: "noop", name, source, target, message: "Codex agent descriptor is current", content: sourceText });
    } else if (opts.force || codexDescriptorManaged(targetText)) {
      changes.push({ action: "pending", name, source, target, message: "would refresh Codex agent descriptor", content: sourceText });
    } else {
      changes.push({
        action: "blocked",
        name,
        source,
        target,
        message: "target exists without Agentera ownership proof; treating it as user-owned",
        content: sourceText,
      });
    }
  }
  return changes;
}

export function writeAgentDescriptorChanges(changes: AgentDescriptorChange[]): void {
  for (const change of changes) {
    if (change.action !== "pending") continue;
    fs.mkdirSync(path.dirname(change.target), { recursive: true });
    fs.writeFileSync(change.target, change.content, "utf8");
  }
}

function readTextOrNull(p: string): string | null {
  if (!pathExists(p)) return null;
  return fs.readFileSync(p, "utf8");
}
