export const RETIRED_STARTUP_GUIDANCE_PATTERNS = [
  ["fallback_commands", /fallback_commands/],
  ["fallback_command", /fallback_command/],
  ["fallback_only", /fallback_only/],
  ["cli_fallback", /cli_fallback/],
  ["included state families", /included state families/],
  ["included/missing state", /included\/missing state/],
  ["missing_state", /missing_state/],
  ["write_contract", /write_contract/],
  ["writer payload", /writer payload/],
  ["source_contract", /source_contract/],
  ["source contract", /source[- ]contract/i],
  ["startup_contract", /startup_contract/],
  ["complete_for_*", /complete_for_/],
] as const;

export function retiredStartupGuidanceViolations(content: string): string[] {
  return RETIRED_STARTUP_GUIDANCE_PATTERNS
    .filter(([, pattern]) => pattern.test(content))
    .map(([name]) => name);
}

const PRE_CUTOVER_BOOTSTRAP_GUIDANCE_PATTERNS = [
  ["bare prime", /(?<![\w@-])agentera prime(?:\s+--[^`\n]*)?/],
  ["bare doctor", /(?<![\w@-])agentera doctor(?:\s+--[^`\n]*)?/],
  ["bare route", /(?<![\w@-])agentera route (?:request|receipt)\b[^`\n]*/],
  ["bare development upgrade", /(?<![\w@-])agentera upgrade --channel development\b[^`\n]*/],
  ["stable bootstrap", /\bnpx\s+-y\s+agentera@latest\s+(?:prime|doctor|route|upgrade)\b[^`\n]*/],
] as const;

const AUTHORITY_EXTENSIONS = new Set([".md", ".yaml", ".yml"]);
const STABLE_HEADING = "## Stable v2 line";
const DEVELOPMENT_HEADING = "## Upgrading v2 to v3 development channel";
const ALLOWED_STABLE_V2_COMMANDS = new Set([
  "npx -y agentera@latest upgrade --dry-run",
  "npx -y agentera@latest upgrade --yes",
]);

function executableContext(line: string, matchIndex: number, fenced: boolean): boolean {
  const prefix = line.slice(0, matchIndex);
  if (fenced && line.trimStart().startsWith(line.slice(matchIndex))) return true;
  if (/^\s*(?:[-\w.]+):\s*$/.test(prefix)) {
    const value = line.slice(matchIndex).replace(/[`'"].*$/, "").trim();
    return /^(?:agentera (?:prime|doctor)(?:\s+--|$)|agentera route (?:request|receipt)\b|agentera upgrade --channel development\b|npx\s+-y\s+agentera@latest\s+(?:prime|doctor|route|upgrade)\b)/.test(value);
  }
  if (/^\s*(?:[-*+]\s+)?$/.test(prefix)) return true;
  const inlineStart = prefix.lastIndexOf("`");
  if (inlineStart >= 0) {
    const prose = prefix.slice(0, inlineStart);
    return /(?:^|[.!?:]\s+|^\s*[-*+]\s+)(?:must\s+|should\s+)?(?:run|invoke|execute|use|start|begin|retry|rerun|call)(?:\s+only)?\s*$/i.test(prose);
  }
  return /(?:^|[.!?:]\s+|^\s*[-*+]\s+)(?:must\s+|should\s+)?(?:run|invoke|execute|use|start|begin|retry|rerun|call)\s*:?\s*$/i.test(prefix);
}

function commandViolations(content: string): string[] {
  const violations = new Set<string>();
  let fenced = false;
  for (const line of content.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    for (const [name, pattern] of PRE_CUTOVER_BOOTSTRAP_GUIDANCE_PATTERNS) {
      const match = pattern.exec(line);
      if (match && executableContext(line, match.index, fenced)) violations.add(name);
    }
  }
  return [...violations];
}

export function preCutoverBootstrapGuidanceViolations(content: string): string[] {
  return commandViolations(content);
}

export function preCutoverBootstrapAuthorityViolations(relativePath: string, content: string): string[] {
  if (relativePath !== "UPGRADE.md") return commandViolations(content);
  const lines = content.split("\n");
  const stable = lines.flatMap((line, index) => line === STABLE_HEADING ? [index] : []);
  const development = lines.flatMap((line, index) => line === DEVELOPMENT_HEADING ? [index] : []);
  const nextSection = stable.length === 1
    ? lines.findIndex((line, index) => index > stable[0] && /^##\s+/.test(line))
    : -1;
  if (stable.length !== 1 || development.length !== 1 || development[0] <= stable[0] || nextSection !== development[0]) {
    return ["stable-v2 section boundary"];
  }
  const stableBody = lines.slice(stable[0] + 1, development[0]).map((line) =>
    ALLOWED_STABLE_V2_COMMANDS.has(line.trim()) ? "" : line
  );
  return [
    ...commandViolations(lines.slice(0, stable[0]).join("\n")),
    ...commandViolations(stableBody.join("\n")),
    ...commandViolations(lines.slice(development[0] + 1).join("\n")),
  ];
}

function collectAuthorityFiles(root: string, relativePath: string, surfaces: Set<string>): void {
  const target = path.join(root, relativePath);
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) collectAuthorityFiles(root, path.join(relativePath, entry), surfaces);
  } else if (stat.isFile() && AUTHORITY_EXTENSIONS.has(path.extname(relativePath))) {
    surfaces.add(relativePath.split(path.sep).join("/"));
  }
}

export function registryBundledAuthorityPaths(root: string): string[] {
  const registryPath = path.join(root, "references/adapters/package-registry.yaml");
  const registry = YAML.parse(fs.readFileSync(registryPath, "utf8")) as Record<string, any>;
  const record = (registry.records as Array<Record<string, any>>).find((entry) => entry.identity?.id === "agentera");
  if (!record) throw new Error("package registry omits agentera bundle authority");
  const surfaces = new Set<string>();
  for (const entry of [...record.bundle_surfaces.directories, ...record.bundle_surfaces.files]) {
    collectAuthorityFiles(root, String(entry.path), surfaces);
  }
  return [...surfaces].sort();
}

export function registryBundledAuthorityViolations(
  root: string,
  overrides: ReadonlyMap<string, string> = new Map(),
): string[] {
  return registryBundledAuthorityPaths(root).flatMap((relativePath) =>
    preCutoverBootstrapAuthorityViolations(
      relativePath,
      overrides.get(relativePath) ?? fs.readFileSync(path.join(root, relativePath), "utf8"),
    ).map((violation) => `${relativePath}: ${violation}`)
  );
}
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
