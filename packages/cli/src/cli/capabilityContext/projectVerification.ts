import path from "node:path";

import type { JsonObject, JsonValue } from "../../core/jsonValue.js";
import { assertValidatedProjectRoot, validateRealProjectRoot, type ValidatedProjectRoot } from "../../state/projectRoot.js";
import { projectPathIsStable, readProjectFileSnapshot, snapshotProjectPath } from "../../state/safeProjectFile.js";

const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_RECIPE_ROWS = 40;
const MAX_COMMANDS = 12;
const MAX_EVALUATED_COMMANDS = 64;
const MAX_PROVENANCE = 16;
const MAX_REJECTIONS = 12;
const MAX_DIAGNOSTICS = 8;
const MAX_ALIAS_DEPTH = 8;
const MAX_POINTER_STRING = 160;
const VERIFICATION_LABEL = /\b(validate|verification|tests?|package boundary|typecheck|build|compaction|lint)\b/i;
const SAFE_TOKEN = /^[A-Za-z0-9@._:/=-]+$/;
const SCRIPT_NAME = /^[A-Za-z0-9@._:-]+$/;

type Rejection = { when: string; command: string; reason: string };
type SourcePointer = {
  source_family: string;
  path: string;
  line?: number;
  field?: string;
  recipe_label?: string;
  recipe_command?: string;
};

interface Candidate {
  when: string;
  commands: string[];
  line: number;
}

interface ResolvedCommand {
  command: string;
  provenance: SourcePointer[];
}

interface PackageManifest {
  scripts: Record<string, unknown>;
}

interface ResolutionState {
  projectRoot: string;
  validatedRoot: ValidatedProjectRoot | null;
  rejections: Rejection[];
  diagnostics: string[];
  rejectionOmitted: number;
  diagnosticOmitted: number;
  candidateCommandOmitted: number;
}

type ProjectPathFailure = "missing" | "symlink" | "outside" | "unsafe";

export function discoverProjectVerification(projectRoot: string): JsonObject {
  const resolvedRoot = path.resolve(projectRoot);
  let validatedRoot: ValidatedProjectRoot | null = null;
  try {
    validatedRoot = validateRealProjectRoot(resolvedRoot);
  } catch {
    validatedRoot = null;
  }
  const state: ResolutionState = {
    projectRoot: resolvedRoot,
    validatedRoot,
    rejections: [],
    diagnostics: [],
    rejectionOmitted: 0,
    diagnosticOmitted: 0,
    candidateCommandOmitted: 0,
  };
  if (state.validatedRoot === null) diagnostic(state, "Project root is missing, symlinked, or unsafe.");
  const candidates = readRecipeCandidates(state);
  const resolvedRows: Array<{ candidate: Candidate; commands: ResolvedCommand[] }> = [];
  let processedCommands = 0;
  for (const candidate of candidates) {
    const commands: ResolvedCommand[] = [];
    for (const command of candidate.commands) {
      if (processedCommands >= MAX_EVALUATED_COMMANDS) {
        state.candidateCommandOmitted += 1;
        continue;
      }
      processedCommands += 1;
      const resolved = resolveCommand(state, candidate, command);
      if (resolved) commands.push(resolved);
    }
    resolvedRows.push({ candidate, commands });
  }
  if (state.candidateCommandOmitted > 0) diagnostic(state, "Verification command evaluation limit reached.");

  const accepted = new Map<string, SourcePointer[]>();
  const rowsByLabel = new Map<string, typeof resolvedRows>();
  for (const row of resolvedRows) {
    const key = row.candidate.when.trim().toLowerCase();
    const group = rowsByLabel.get(key) ?? [];
    group.push(row);
    rowsByLabel.set(key, group);
  }
  for (const rows of rowsByLabel.values()) {
    const canonicalSets = new Set(rows.filter((row) => row.commands.length > 0).map((row) => JSON.stringify([...new Set(row.commands.map(({ command }) => command))].sort())));
    if (canonicalSets.size > 1) {
      const first = rows[0].candidate;
      reject(state, first.when, first.commands.join(" · "), "conflicting_recipe_label");
      continue;
    }
    for (const row of rows) {
      for (const resolved of row.commands) {
        const provenance = accepted.get(resolved.command) ?? [];
        for (const pointer of resolved.provenance) {
          if (!provenance.some((entry) => JSON.stringify(entry) === JSON.stringify(pointer))) provenance.push(pointer);
        }
        accepted.set(resolved.command, provenance);
      }
    }
  }

  const commandOmitted = Math.max(0, accepted.size - MAX_COMMANDS) + state.candidateCommandOmitted;
  const expectedCommands: JsonValue[] = [...accepted.entries()].slice(0, MAX_COMMANDS).map(([command, allProvenance]) => {
    const provenance = allProvenance.slice(0, MAX_PROVENANCE);
    return {
      command,
      source_provenance: provenance as unknown as JsonValue,
      provenance_omitted_count: allProvenance.length - provenance.length,
    };
  });
  const provenanceOmitted = expectedCommands.some((entry) => (entry as JsonObject).provenance_omitted_count !== 0);
  const hasOmissions = commandOmitted > 0 || provenanceOmitted || state.rejectionOmitted > 0 || state.diagnosticOmitted > 0;
  const hasProblems = state.rejections.length > 0 || state.diagnostics.length > 0 || hasOmissions;
  return {
    status: hasOmissions ? "partial" : expectedCommands.length === 0 ? "unavailable" : hasProblems ? "partial" : "available",
    expected_commands: expectedCommands,
    command_omitted_count: commandOmitted,
    rejections: state.rejections as unknown as JsonValue,
    rejection_omitted_count: state.rejectionOmitted,
    diagnostics: state.diagnostics,
    diagnostic_omitted_count: state.diagnosticOmitted,
    resolution_policy: {
      id: "agents_recipe_table_package_scripts_v1",
      selection: "agents_recipe_table",
      package_binding: "root_or_pnpm_c",
      aliases: "resolve_before_conflicts",
      node_arguments: "tokens_without_absolute_or_parent_paths",
      missing_node_target: "reject",
      execution: "never",
    },
  };
}

function readRecipeCandidates(state: ResolutionState): Candidate[] {
  const guidancePath = path.join(state.projectRoot, "AGENTS.md");
  const sourceResult = readBoundedText(guidancePath, state, "AGENTS.md");
  if ("reason" in sourceResult) return [];
  const source = sourceResult.text;
  const lines = source.split(/\r?\n/);
  const header = lines.findIndex((line) => line.trim() === "| When | Command |");
  if (header < 0 || !/^\|\s*:?-+\s*\|\s*:?-+\s*\|$/.test((lines[header + 1] ?? "").trim())) {
    diagnostic(state, "AGENTS.md recipe table '| When | Command |' is missing or malformed.");
    return [];
  }

  const rows: Candidate[] = [];
  for (let index = header + 2; index < lines.length && lines[index].trim().startsWith("|"); index += 1) {
    if (rows.length >= MAX_RECIPE_ROWS) {
      diagnostic(state, `AGENTS.md recipe table exceeds ${MAX_RECIPE_ROWS} rows.`);
      break;
    }
    const cells = lines[index]
      .trim()
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length !== 2) {
      diagnostic(state, `AGENTS.md recipe row ${index + 1} is malformed.`);
      continue;
    }
    const [when, commandCell] = cells;
    if (!VERIFICATION_LABEL.test(when)) continue;
    if (!pointerStringIsSafe(when)) {
      reject(state, when, commandCell, "source_pointer_too_long");
      continue;
    }
    const commands = inlineCommands(commandCell);
    if (commands === null || commands.length === 0) {
      reject(state, when, commandCell, "command_cell_malformed");
      continue;
    }
    rows.push({ when, commands, line: index + 1 });
  }
  return rows;
}

function inlineCommands(cell: string): string[] | null {
  const matches = [...cell.matchAll(/`([^`\r\n]+)`/g)];
  if (matches.length === 0) return null;
  const remainder = cell
    .replace(/`[^`\r\n]+`/g, "")
    .replaceAll("·", "")
    .trim();
  return remainder === "" ? matches.map((match) => match[1].trim()) : null;
}

function resolveCommand(state: ResolutionState, candidate: Candidate, command: string): ResolvedCommand | null {
  const when = candidate.when;
  if (!pointerStringIsSafe(command)) return rejected(state, when, command, "source_pointer_too_long");
  if (/<[^>]+>|\.\.\.|…/.test(command)) return rejected(state, when, command, "placeholder_not_allowed");
  if (/\|\||[;|><$()'"`\\]/.test(command)) return rejected(state, when, command, "unsupported_syntax");
  const segments = command.split(/\s+&&\s+/);
  if (segments.length > 2 || segments.some((segment) => segment.length === 0)) {
    return rejected(state, when, command, "unsupported_command_chain");
  }

  const canonical: string[] = [];
  const provenance: SourcePointer[] = [
    {
      source_family: "project_guidance",
      path: "AGENTS.md",
      line: candidate.line,
      recipe_label: when,
      recipe_command: command,
    },
  ];
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/);
    if (tokens.some((token) => !SAFE_TOKEN.test(token))) return rejected(state, when, command, "unsupported_syntax");
    if (tokens[0] === "pnpm") {
      const resolved = resolvePnpm(state, tokens);
      if (typeof resolved === "string") return rejected(state, when, command, resolved);
      canonical.push(resolved.command);
      provenance.push(...resolved.provenance);
      continue;
    }
    if (tokens[0] === "node") {
      const resolved = resolveNode(state, tokens);
      if ("reason" in resolved) return rejected(state, when, command, resolved.reason);
      canonical.push(resolved.command);
      provenance.push(...resolved.provenance);
      continue;
    }
    return rejected(state, when, command, "unsupported_or_missing_executable");
  }
  return {
    command: canonical.join(" && "),
    provenance,
  };
}

function resolvePnpm(
  state: ResolutionState,
  tokens: string[],
):
  | {
      command: string;
      provenance: SourcePointer[];
    }
  | string {
  let directory = ".";
  let index = 1;
  if (tokens[index] === "-C") {
    directory = tokens[index + 1] ?? "";
    index += 2;
  }
  if (tokens[index] === "run") index += 1;
  const script = tokens[index];
  if (!script || index !== tokens.length - 1) return "unsupported_pnpm_syntax";
  if (!SCRIPT_NAME.test(script) || !pointerStringIsSafe(script)) return "unsupported_pnpm_script_name";
  const packageRoot = resolveInsideRoot(state.projectRoot, directory);
  if (!packageRoot) return "package_path_outside_project";
  const manifestPath = path.join(packageRoot, "package.json");
  const manifestRelative = relativeProjectPath(state.projectRoot, manifestPath);
  if (!pointerStringIsSafe(manifestRelative)) return "source_pointer_too_long";
  const manifestResult = readBoundedText(manifestPath, state, manifestRelative, false);
  if ("reason" in manifestResult) {
    return manifestResult.reason === "missing" ? "package_manifest_unavailable" : "package_path_unsafe";
  }
  const manifestSource = manifestResult.text;
  let manifest: PackageManifest;
  try {
    const parsed = JSON.parse(manifestSource) as { scripts?: unknown };
    const scripts = parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts) ? (parsed.scripts as Record<string, unknown>) : {};
    manifest = {
      scripts,
    };
  } catch {
    return "package_manifest_malformed";
  }
  const alias = resolveScriptAlias(manifest.scripts, script);
  if (typeof alias === "string") return alias;
  const prefix = directory === "." ? "pnpm" : `pnpm -C ${relativeProjectPath(state.projectRoot, packageRoot)}`;
  const canonicalCommand = `${prefix} run ${alias.canonical}`;
  if (!pointerStringIsSafe(canonicalCommand) || alias.chain.some((name) => !pointerStringIsSafe(`scripts.${name}`))) {
    return "source_pointer_too_long";
  }
  return {
    command: canonicalCommand,
    provenance: alias.chain.map((name) => ({
      source_family: "package_manifest",
      path: manifestRelative,
      field: `scripts.${name}`,
    })),
  };
}

function resolveScriptAlias(scripts: Record<string, unknown>, requested: string): { canonical: string; chain: string[] } | string {
  const chain: string[] = [];
  let current = requested;
  for (let depth = 0; depth <= MAX_ALIAS_DEPTH; depth += 1) {
    if (chain.includes(current)) return "package_script_alias_cycle";
    if (!SCRIPT_NAME.test(current) || !pointerStringIsSafe(current)) return "unsupported_pnpm_script_name";
    chain.push(current);
    const body = scripts[current];
    if (typeof body !== "string") return "package_script_missing";
    const alias = /^pnpm\s+(?:run\s+)?(\S+)$/.exec(body.trim());
    if (!alias) return { canonical: current, chain };
    if (!SCRIPT_NAME.test(alias[1])) return { canonical: current, chain };
    current = alias[1];
  }
  return "package_script_alias_depth_exceeded";
}

function resolveNode(state: ResolutionState, tokens: string[]): { command: string; provenance: SourcePointer[] } | { reason: string } {
  if (tokens.length < 2) return { reason: "unsupported_node_syntax" };
  const target = resolveInsideRoot(state.projectRoot, tokens[1]);
  if (!target || path.isAbsolute(tokens[1])) return { reason: "node_target_outside_project" };
  const targetStatus = projectFileStatus(state, target);
  if (targetStatus === "unsafe") return { reason: "node_target_path_unsafe" };
  if (targetStatus === "missing") return { reason: "node_target_missing" };
  if (!nodeArgumentsAreSafe(tokens.slice(2))) return { reason: "node_argument_path_unsafe" };
  return {
    command: `node ${relativeProjectPath(state.projectRoot, target)}${tokens.length > 2 ? ` ${tokens.slice(2).join(" ")}` : ""}`,
    provenance: [],
  };
}

function nodeArgumentsAreSafe(args: string[]): boolean {
  return args.every((argument) => {
    const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argument;
    if (!value) return true;
    const normalized = value.replaceAll("\\", "/");
    return !path.posix.isAbsolute(normalized) && !path.win32.isAbsolute(value) && !normalized.split("/").includes("..");
  });
}

function readBoundedText(filePath: string, state: ResolutionState, label: string, reportDiagnostic = true): { text: string } | { reason: ProjectPathFailure } {
  if (state.validatedRoot === null) return { reason: "unsafe" };
  const relative = relativeProjectPath(state.projectRoot, filePath);
  try {
    assertValidatedProjectRoot(state.validatedRoot);
    const pathSnapshot = snapshotProjectPath(state.validatedRoot.path, relative, "file");
    if (pathSnapshot.kind === "missing") {
      if (reportDiagnostic) diagnostic(state, `${label} is missing or rejected by bounded path safety (missing).`);
      return { reason: "missing" };
    }
    if (pathSnapshot.kind === "unsafe") {
      const reason = pathSnapshot.reason === "symlink" ? "symlink" : "unsafe";
      if (reportDiagnostic) diagnostic(state, `${label} is missing or rejected by bounded path safety (${reason}).`);
      return { reason };
    }
    if (pathSnapshot.leaf.size > BigInt(MAX_SOURCE_BYTES)) {
      if (reportDiagnostic) diagnostic(state, `${label} is not a bounded regular file.`);
      return { reason: "unsafe" };
    }
    if (!projectPathIsStable(pathSnapshot)) return { reason: "unsafe" };
    const fileSnapshot = readProjectFileSnapshot(state.validatedRoot, relative);
    if (fileSnapshot.kind !== "file" || fileSnapshot.bytes.byteLength > MAX_SOURCE_BYTES) {
      const reason = fileSnapshot.kind === "missing" ? "missing" : fileSnapshot.kind === "unsafe" && fileSnapshot.reason === "symlink" ? "symlink" : "unsafe";
      if (reportDiagnostic) diagnostic(state, `${label} is missing or rejected by bounded path safety (${reason}).`);
      return { reason };
    }
    return { text: fileSnapshot.bytes.toString("utf8") };
  } catch {
    if (reportDiagnostic) diagnostic(state, `${label} is missing or unreadable.`);
    return { reason: "unsafe" };
  }
}

function projectFileStatus(state: ResolutionState, filePath: string): "file" | "missing" | "unsafe" {
  if (state.validatedRoot === null) return "unsafe";
  try {
    assertValidatedProjectRoot(state.validatedRoot);
    const snapshot = snapshotProjectPath(state.validatedRoot.path, relativeProjectPath(state.projectRoot, filePath), "file");
    if (snapshot.kind === "missing") return "missing";
    if (snapshot.kind === "unsafe" || !projectPathIsStable(snapshot)) return "unsafe";
    assertValidatedProjectRoot(state.validatedRoot);
    return "file";
  } catch {
    return "unsafe";
  }
}

function resolveInsideRoot(root: string, relative: string): string | null {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) return null;
  const resolved = path.resolve(root, relative);
  return isInside(root, resolved) ? resolved : null;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function relativeProjectPath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/") || ".";
}

function reject(state: ResolutionState, when: string, command: string, reason: string): void {
  if (state.rejections.length < MAX_REJECTIONS) {
    state.rejections.push({
      when: pointerStringIsSafe(when) ? when : "<overlong-label>",
      command: pointerStringIsSafe(command) ? command : "<overlong-command>",
      reason,
    });
  } else state.rejectionOmitted += 1;
}

function rejected(state: ResolutionState, when: string, command: string, reason: string): null {
  reject(state, when, command, reason);
  return null;
}

function diagnostic(state: ResolutionState, message: string): void {
  const bounded = pointerStringIsSafe(message) ? message : "Verification diagnostic exceeded its string bound.";
  if (state.diagnostics.length < MAX_DIAGNOSTICS) state.diagnostics.push(bounded);
  else state.diagnosticOmitted += 1;
}

function pointerStringIsSafe(value: string): boolean {
  return [...value].length <= MAX_POINTER_STRING;
}
