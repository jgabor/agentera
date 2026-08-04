import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import ts from "typescript";

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

export type BootstrapAuthorityLocation =
  | { line: number; column: number }
  | { structured_path: string };

export interface BootstrapAuthorityDiagnostic {
  path: string;
  location: BootstrapAuthorityLocation;
  candidate: { raw: string; normalized: string } | null;
  violation: string;
  correction: string;
}

export interface BootstrapAuthorityInventoryRecord {
  path: string;
  surface: "source" | "bundle" | "generated" | "emitted";
  classification: "parsed_and_scanned" | "reason_classified";
  reason: string;
}

export interface BootstrapAuthorityInventory {
  records: BootstrapAuthorityInventoryRecord[];
  diagnostics: BootstrapAuthorityDiagnostic[];
}

const STABLE_HEADING = "## Stable v2 line";
const DEVELOPMENT_HEADING = "## Upgrading v2 to v3 development channel";
const STABLE_COMMANDS = [
  "npx -y agentera@latest upgrade --dry-run",
  "npx -y agentera@latest upgrade --yes",
] as const;
const INSTRUCTIONAL_EXTENSIONS = new Set([".md", ".json", ".yaml", ".yml"]);
const BOOTSTRAP_COMMANDS = new Set(["prime", "doctor", "upgrade", "route"]);
const IMPERATIVE = /(?:^|[\p{White_Space},.!?:])(?:must\s+|should\s+|then\s+)?(?:run|invoke|execute|use|start|begin|retry|rerun|call|type|enter)\s*:?[\p{White_Space}]*$/iu;

interface ShellToken {
  raw: string;
  value: string;
  start: number;
  decorated: boolean;
}

function normalizeCandidate(raw: string): string {
  return raw.normalize("NFKC").replace(/\\\r?\n[\p{White_Space}]*/gu, " ").replace(/[\p{White_Space}]+/gu, " ").trim();
}

function tokenizeShell(raw: string): { tokens: ShellToken[]; operators: string[]; error: string | null } {
  const tokens: ShellToken[] = [];
  const operators: string[] = [];
  let token: ShellToken | null = null;
  let quote: "'" | '"' | null = null;
  const current = (index: number): ShellToken => token ??= { raw: "", value: "", start: index, decorated: false };
  const finish = (): void => { if (token) tokens.push(token); token = null; };
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote) {
      const part = current(index);
      part.raw += character;
      if (character === quote) { quote = null; part.decorated = true; }
      else if (character === "\\" && quote === '"' && index + 1 < raw.length) {
        part.decorated = true;
        part.raw += raw[++index];
        part.value += raw[index];
      } else {
        if (character === "`" || (character === "$" && raw[index + 1] === "(")) operators.push("substitution");
        part.value += character;
      }
      continue;
    }
    if (/[\p{White_Space}]/u.test(character)) { finish(); continue; }
    if (character === "'" || character === '"') {
      const part = current(index);
      part.raw += character;
      part.decorated = true;
      quote = character;
      continue;
    }
    if (character === "\\") {
      if (raw[index + 1] === "\r" && raw[index + 2] === "\n") { operators.push("line_continuation"); index += 2; continue; }
      if (raw[index + 1] === "\n") { operators.push("line_continuation"); index += 1; continue; }
      const part = current(index);
      part.decorated = true;
      part.raw += character;
      if (index + 1 < raw.length) { part.raw += raw[++index]; part.value += raw[index]; }
      continue;
    }
    if (character === "<") {
      const placeholder = /^<[-A-Za-z0-9_{}|]+>/.exec(raw.slice(index))?.[0];
      if (placeholder) {
        const part = current(index);
        part.raw += placeholder;
        part.value += placeholder;
        index += placeholder.length - 1;
        continue;
      }
    }
    if (character === "`" || (character === "$" && raw[index + 1] === "(") || (/[<>]/.test(character) && raw[index + 1] === "(")) operators.push("substitution");
    if (/[;&|<>()[\]]/.test(character)) {
      finish();
      let operator = character;
      if (raw[index + 1] === character || (character === ">" && raw[index + 1] === "&")) operator += raw[++index];
      operators.push(operator);
      tokens.push({ raw: operator, value: operator, start: index - operator.length + 1, decorated: false });
      continue;
    }
    const part = current(index);
    part.raw += character;
    part.value += character;
  }
  finish();
  return { tokens, operators, error: quote ? `unterminated ${quote} quote` : null };
}

function commandTokenIndex(tokens: ShellToken[]): number {
  return tokens.findIndex((token, index) => /^agentera(?:@.+)?$/u.test(token.value)
    && BOOTSTRAP_COMMANDS.has(tokens[index + 1]?.value ?? ""));
}

function correctionFor(tokens: ShellToken[], commandIndex: number): string {
  return `npx -y agentera@next ${tokens.slice(commandIndex + 1).map(({ value }) => value).join(" ")}`.trim();
}

function commandObjectDiagnostic(
  sourcePath: string,
  location: BootstrapAuthorityLocation,
  rawObject: string,
  stableAllowed: boolean,
  descriptiveInline = false,
): BootstrapAuthorityDiagnostic | null {
  const raw = rawObject.trim().replace(/[.!?:]+$/, "");
  const parsed = tokenizeShell(raw);
  let commandIndex = commandTokenIndex(parsed.tokens);
  let commandTokens = parsed.tokens;
  let nestedWrapper = false;
  if (commandIndex < 0) {
    for (const token of parsed.tokens.filter(({ decorated }) => decorated)) {
      const nested = tokenizeShell(token.value);
      const nestedIndex = commandTokenIndex(nested.tokens);
      if (nestedIndex >= 0) {
        commandIndex = nestedIndex;
        commandTokens = nested.tokens;
        nestedWrapper = true;
        break;
      }
    }
  }
  if (commandIndex < 0) return null;
  const descriptiveTail = commandIndex === 0
    && parsed.tokens[0].value === "agentera"
    && parsed.tokens.length > 2
    && !parsed.tokens[2].value.startsWith("--")
    && !(parsed.tokens[1].value === "route" && ["request", "receipt"].includes(parsed.tokens[2].value));
  if (descriptiveTail) return null;
  if (descriptiveInline && !nestedWrapper && commandIndex === 0 && parsed.tokens.length === 2 && parsed.tokens[0].value === "agentera") return null;
  const normalized = parsed.tokens.map(({ value }) => value).join(" ");
  const exactDevelopment = raw.startsWith("npx -y agentera@next ")
    && parsed.tokens[0]?.raw === "npx"
    && parsed.tokens[1]?.raw === "-y"
    && parsed.tokens[2]?.raw === "agentera@next"
    && commandIndex === 2
    && parsed.operators.length === 0
    && parsed.error === null;
  if (exactDevelopment) return null;
  if (stableAllowed && STABLE_COMMANDS.includes(raw as typeof STABLE_COMMANDS[number])) return null;
  let violation = "ambiguous_executable";
  if (parsed.error) violation = "malformed_command_context";
  else if (commandTokens[commandIndex].value === "agentera@latest") violation = "stable_channel_outside_exemption";
  else if (parsed.operators.length > 0) violation = "command_composition";
  else if (nestedWrapper) violation = "command_wrapper";
  else if (commandIndex > 2 || (commandIndex > 0 && parsed.tokens[0]?.value !== "npx")) violation = "command_wrapper";
  else if (parsed.tokens[commandIndex].value === "agentera") violation = "bare_executable";
  else if (parsed.tokens[commandIndex].value === "agentera@next") violation = "noncanonical_development_executable";
  else if (parsed.tokens[0]?.value === "npx") violation = "ambiguous_npx_executable";
  return {
    path: sourcePath,
    location,
    candidate: { raw, normalized: normalizeCandidate(normalized) },
    violation,
    correction: correctionFor(commandTokens, commandIndex),
  };
}

function scanCommandObject(
  sourcePath: string,
  raw: string,
  location: BootstrapAuthorityLocation,
  stableAllowed = false,
  descriptiveInline = false,
): BootstrapAuthorityDiagnostic[] {
  const diagnostic = commandObjectDiagnostic(sourcePath, location, raw, stableAllowed, descriptiveInline);
  return diagnostic ? [diagnostic] : [];
}

function structuredPath(parent: string, key: string | number): string {
  return typeof key === "number" ? `${parent}[${key}]` : `${parent}[${JSON.stringify(key)}]`;
}

function shellLikePrefix(tokens: ShellToken[], commandIndex: number): boolean {
  if (commandIndex === 0 || (tokens[0]?.value === "npx" && commandIndex <= 2)) return true;
  return tokens.slice(0, commandIndex).every(({ value }) =>
    /^(?:npx|-y|env|command|exec|sudo|bash|sh|zsh|fish|[$>❯]|[A-Za-z_][A-Za-z0-9_]*=.*)$/u.test(value)
    || /^(?:&&|\|\||\||;|\$\(|`)$/.test(value));
}

function scanStructuredString(sourcePath: string, value: string, currentPath: string): BootstrapAuthorityDiagnostic[] {
  const location = { structured_path: currentPath } as const;
  const diagnostics: BootstrapAuthorityDiagnostic[] = [];
  let prose = value;
  for (const match of value.matchAll(/`([^`\n]+)`/g)) {
    diagnostics.push(...scanCommandObject(sourcePath, match[1], location, false, true));
    prose = prose.replace(match[0], " ".repeat(match[0].length));
  }
  const parsed = tokenizeShell(prose);
  const commandIndex = commandTokenIndex(parsed.tokens);
  if (commandIndex >= 0) {
    const knownWrapper = /^(?:env|command|exec|sudo|bash|sh|zsh|fish|timeout|xargs|nice|stdbuf|watch)$/u.test(parsed.tokens[0]?.value ?? "");
    if (knownWrapper || shellLikePrefix(parsed.tokens, commandIndex)) return [...diagnostics, ...scanCommandObject(sourcePath, prose, location)];
    const npxIndex = parsed.tokens.slice(0, commandIndex).findLastIndex(({ value: token }) => token === "npx");
    if (npxIndex >= 0) return [...diagnostics, ...scanCommandObject(sourcePath, prose.slice(parsed.tokens[npxIndex].start), location)];
    const prefix = prose.slice(0, parsed.tokens[commandIndex].start);
    if (IMPERATIVE.test(prefix)) return [...diagnostics, ...scanCommandObject(sourcePath, prose.slice(parsed.tokens[commandIndex].start), location)];
  }
  diagnostics.push(...prose.split(/\r?\n/).flatMap((line) => {
    const lineParsed = tokenizeShell(line);
    const lineCommand = commandTokenIndex(lineParsed.tokens);
    if (lineCommand < 0) return [];
    if (shellLikePrefix(lineParsed.tokens, lineCommand)) return scanCommandObject(sourcePath, line, location);
    const prefix = line.slice(0, lineParsed.tokens[lineCommand].start);
    return IMPERATIVE.test(prefix) ? scanCommandObject(sourcePath, line.slice(lineParsed.tokens[lineCommand].start), location) : [];
  }));
  return diagnostics;
}

function scanStructuredValue(
  sourcePath: string,
  value: unknown,
  currentPath = "$",
  ancestry = new WeakSet<object>(),
): BootstrapAuthorityDiagnostic[] {
  if (typeof value === "string") return scanStructuredString(sourcePath, value, currentPath);
  if (!value || typeof value !== "object") return [];
  if (ancestry.has(value)) return [malformedDiagnostic(sourcePath, "yaml_alias_cycle", `recursive value at ${currentPath}`)];
  ancestry.add(value);
  const diagnostics = Array.isArray(value)
    ? value.flatMap((entry, index) => scanStructuredValue(sourcePath, entry, structuredPath(currentPath, index), ancestry))
    : Object.entries(value).flatMap(([key, entry]) => scanStructuredValue(sourcePath, entry, structuredPath(currentPath, key), ancestry));
  ancestry.delete(value);
  return diagnostics;
}

function malformedDiagnostic(sourcePath: string, format: string, message: string): BootstrapAuthorityDiagnostic {
  return {
    path: sourcePath,
    location: { structured_path: "$" },
    candidate: null,
    violation: `malformed_${format}`,
    correction: `Correct the ${format.toUpperCase()} structure before command-authority validation: ${message.split("\n")[0]}`,
  };
}

function scanYaml(sourcePath: string, content: string): BootstrapAuthorityDiagnostic[] {
  try {
    const document = YAML.parseDocument(content, { uniqueKeys: true });
    if (document.errors.length > 0) return [malformedDiagnostic(sourcePath, "yaml", document.errors[0].message)];
    return scanStructuredValue(sourcePath, document.toJS({ maxAliasCount: 100 }));
  } catch (error) {
    return [malformedDiagnostic(sourcePath, "yaml", error instanceof Error ? error.message : String(error))];
  }
}

function scanJson(sourcePath: string, content: string): BootstrapAuthorityDiagnostic[] {
  try {
    const duplicateCheck = YAML.parseDocument(content, { schema: "json", uniqueKeys: true });
    if (duplicateCheck.errors.length > 0) return [malformedDiagnostic(sourcePath, "json", duplicateCheck.errors[0].message)];
    return scanStructuredValue(sourcePath, JSON.parse(content));
  } catch (error) {
    return [malformedDiagnostic(sourcePath, "json", error instanceof Error ? error.message : String(error))];
  }
}

function stableSequenceDiagnostic(sourcePath: string, line: number, violation: string): BootstrapAuthorityDiagnostic {
  return {
    path: sourcePath,
    location: { line, column: 1 },
    candidate: null,
    violation,
    correction: `Keep exactly these adjacent ordered lines only in ${STABLE_HEADING}: ${STABLE_COMMANDS.join(" ; ")}`,
  };
}

function scanMarkdownObjects(
  sourcePath: string,
  content: string,
  lineOffset: number,
  stableLines: ReadonlySet<number> = new Set(),
): BootstrapAuthorityDiagnostic[] {
  const diagnostics: BootstrapAuthorityDiagnostic[] = [];
  const lines = content.split(/\r?\n/);
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = index + 1 + lineOffset;
    let rawLine = lines[index];
    if (/^\s*```/.test(rawLine)) { fenced = !fenced; continue; }
    while (/\\\s*$/.test(rawLine) && index + 1 < lines.length) rawLine += `\n${lines[++index]}`;
    const location = (column = 1): BootstrapAuthorityLocation => ({ line: sourceLine, column });
    if (fenced) {
      diagnostics.push(...scanCommandObject(sourcePath, rawLine.trim(), location(rawLine.search(/\S|$/) + 1), stableLines.has(sourceLine)));
      continue;
    }

    let prose = rawLine;
    for (const match of rawLine.matchAll(/`([^`\n]+)`/g)) {
      const prefix = rawLine.slice(0, match.index);
      diagnostics.push(...scanCommandObject(sourcePath, match[1], location(match.index! + 2), false, !IMPERATIVE.test(prefix)));
      prose = prose.replace(match[0], " ".repeat(match[0].length));
    }
    if (/^\s*\|/.test(prose)) {
      let cursor = 0;
      for (const cell of prose.split("|")) {
        const trimmed = cell.trim();
        if (trimmed && !/^:?-+:?$/.test(trimmed)) diagnostics.push(...scanCommandObject(sourcePath, trimmed, location(cursor + cell.search(/\S|$/) + 1)));
        cursor += cell.length + 1;
      }
      continue;
    }
    const list = /^(\s*(?:[-*+] |\d+[.)] ))(.*)$/u.exec(prose);
    const object = list ? list[2] : prose.trim();
    const objectColumn = list ? list[1].length + 1 : prose.search(/\S|$/) + 1;
    const parsed = tokenizeShell(object);
    const commandIndex = commandTokenIndex(parsed.tokens);
    if (commandIndex < 0) continue;
    if (shellLikePrefix(parsed.tokens, commandIndex)) {
      diagnostics.push(...scanCommandObject(sourcePath, object, location(objectColumn), stableLines.has(sourceLine)));
      continue;
    }
    const prefix = object.slice(0, parsed.tokens[commandIndex].start);
    if (IMPERATIVE.test(prefix)) {
      diagnostics.push(...scanCommandObject(sourcePath, object.slice(parsed.tokens[commandIndex].start), location(objectColumn + parsed.tokens[commandIndex].start)));
    }
  }
  return diagnostics;
}

function scanMarkdown(sourcePath: string, content: string): BootstrapAuthorityDiagnostic[] {
  const lines = content.split(/\r?\n/);
  let bodyOffset = 0;
  const diagnostics: BootstrapAuthorityDiagnostic[] = [];
  if (lines[0] === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line === "---");
    if (end < 0) return [malformedDiagnostic(sourcePath, "markdown_frontmatter", "missing closing --- boundary")];
    diagnostics.push(...scanYaml(`${sourcePath}#frontmatter`, lines.slice(1, end).join("\n")));
    bodyOffset = end + 1;
  }
  if (sourcePath !== "UPGRADE.md" && !sourcePath.endsWith("/UPGRADE.md")) {
    return [...diagnostics, ...scanMarkdownObjects(sourcePath, lines.slice(bodyOffset).join("\n"), bodyOffset)];
  }

  const stable = lines.flatMap((line, index) => line === STABLE_HEADING ? [index] : []);
  const development = lines.flatMap((line, index) => line === DEVELOPMENT_HEADING ? [index] : []);
  const nextSection = stable.length === 1 ? lines.findIndex((line, index) => index > stable[0] && /^##\s+/.test(line)) : -1;
  if (stable.length !== 1 || development.length !== 1 || nextSection !== development[0]) {
    return [...diagnostics, stableSequenceDiagnostic(sourcePath, (stable[0] ?? 0) + 1, "stable_v2_section_boundary")];
  }
  const stableCandidates = lines.slice(stable[0] + 1, development[0]).flatMap((line, relativeIndex) =>
    commandTokenIndex(tokenizeShell(line.trim()).tokens) >= 0 ? [{ line: stable[0] + relativeIndex + 2, text: line.trim() }] : [],
  );
  const exact = stableCandidates.length === 2
    && stableCandidates.every((entry, index) => entry.text === STABLE_COMMANDS[index])
    && stableCandidates[1].line === stableCandidates[0].line + 1;
  if (!exact) diagnostics.push(stableSequenceDiagnostic(sourcePath, stable[0] + 1, "stable_v2_sequence"));
  const allowedLines = exact ? new Set(stableCandidates.map(({ line }) => line)) : new Set<number>();
  diagnostics.push(...scanMarkdownObjects(sourcePath, content, 0, allowedLines));
  return diagnostics;
}

export function preCutoverBootstrapAuthorityDiagnostics(relativePath: string, content: string): BootstrapAuthorityDiagnostic[] {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === ".md") return scanMarkdown(relativePath, content);
  if (extension === ".json") return scanJson(relativePath, content);
  if (extension === ".yaml" || extension === ".yml") return scanYaml(relativePath, content);
  return [{
    path: relativePath,
    location: { structured_path: "$" },
    candidate: null,
    violation: "unclassified_format",
    correction: "Declare an inspectable exemption with a non-empty reason or add a parse-aware scanner.",
  }];
}

/** Compatibility projection for complete machine-emitted text guidance. */
export function preCutoverBootstrapGuidanceViolations(content: string): string[] {
  return [...new Set(scanMarkdownObjects("<emitted>", content, 0).map(({ violation }) => violation))];
}

/** Compatibility projection for one registry-owned source. */
export function preCutoverBootstrapAuthorityViolations(relativePath: string, content: string): string[] {
  return [...new Set(preCutoverBootstrapAuthorityDiagnostics(relativePath, content).map(({ violation }) => violation))];
}

function collectFiles(root: string, relativePath: string, files: Set<string>, diagnostics: BootstrapAuthorityDiagnostic[]): void {
  const target = path.join(root, relativePath);
  if (!fs.existsSync(target)) {
    diagnostics.push({
      path: relativePath,
      location: { structured_path: "$" },
      candidate: null,
      violation: "inventory_omission",
      correction: "Restore the registry-owned surface or update the registry and its inspectable classification together.",
    });
    return;
  }
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) collectFiles(root, path.join(relativePath, entry), files, diagnostics);
  } else if (stat.isFile()) files.add(relativePath.split(path.sep).join("/"));
}

function registryRecord(root: string, packaged: boolean): Record<string, any> {
  const registryPath = path.join(root, packaged ? "bundle/references/adapters/package-registry.yaml" : "references/adapters/package-registry.yaml");
  const registry = YAML.parse(fs.readFileSync(registryPath, "utf8")) as Record<string, any>;
  const record = (registry.records as Array<Record<string, any>>)?.find((entry) => entry.identity?.id === "agentera");
  if (!record) throw new Error("package registry omits agentera bundle authority");
  return record;
}

function discoverEmittedProducerPaths(root: string): Set<string> {
  const sourceRoot = path.join(root, "packages/cli/src");
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(target);
    }
  };
  walk(sourceRoot);
  const sources = new Map(files.map((file) => [file, ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)]));
  const constructorPath = path.join(sourceRoot, "cli/preCutoverCommand.ts");
  const exported = new Map<string, Set<string>>([[constructorPath, new Set(["preCutoverCommand", "preCutoverInstructionBody", "preCutoverCommandFromBare"])] ]);
  const resolveModule = (from: string, specifier: string): string | null => {
    if (!specifier.startsWith(".")) return null;
    const base = path.resolve(path.dirname(from), specifier);
    for (const candidate of [base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts")]) {
      if (sources.has(candidate)) return candidate;
    }
    return null;
  };
  const discovered = new Set<string>();
  for (let pass = 0; pass < files.length + 1; pass += 1) {
    let changed = false;
    for (const [file, source] of sources) {
      if (file === constructorPath) continue;
      const locals = new Set<string>();
      const namespaces = new Map<string, Set<string>>();
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const target = resolveModule(file, statement.moduleSpecifier.text);
        const targetExports = target ? exported.get(target) : undefined;
        if (!targetExports || !statement.importClause) continue;
        const bindings = statement.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (targetExports.has(element.propertyName?.text ?? element.name.text)) locals.add(element.name.text);
          }
        } else if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, targetExports);
      }
      const callsTainted = (node: ts.Node): boolean => {
        let found = false;
        const visit = (child: ts.Node): void => {
          if (found) return;
          if (ts.isCallExpression(child)) {
            if (ts.isIdentifier(child.expression) && locals.has(child.expression.text)) found = true;
            if (ts.isPropertyAccessExpression(child.expression)
              && ts.isIdentifier(child.expression.expression)
              && namespaces.get(child.expression.expression.text)?.has(child.expression.name.text)) found = true;
          }
          ts.forEachChild(child, visit);
        };
        visit(node);
        return found;
      };
      const referencesTainted = (node: ts.Node): boolean => (ts.isIdentifier(node) && locals.has(node.text))
        || (ts.isPropertyAccessExpression(node)
          && ts.isIdentifier(node.expression)
          && namespaces.get(node.expression.text)?.has(node.name.text) === true);
      for (let localPass = 0; localPass < source.statements.length + 1; localPass += 1) {
        const before = locals.size;
        const visitDeclaration = (node: ts.Node): void => {
          if (ts.isFunctionDeclaration(node) && node.name && node.body && callsTainted(node.body)) locals.add(node.name.text);
          if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
            && (callsTainted(node.initializer) || referencesTainted(node.initializer))) locals.add(node.name.text);
          ts.forEachChild(node, visitDeclaration);
        };
        visitDeclaration(source);
        if (locals.size === before) break;
      }
      const moduleExports = new Set(exported.get(file) ?? []);
      let producer = callsTainted(source);
      for (const statement of source.statements) {
        if (ts.isExportDeclaration(statement)) {
          const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
            ? resolveModule(file, statement.moduleSpecifier.text)
            : null;
          const targetExports = target ? exported.get(target) : undefined;
          if (!statement.exportClause && targetExports) {
            for (const name of targetExports) moduleExports.add(name);
            producer = targetExports.size > 0;
          } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            for (const element of statement.exportClause.elements) {
              const sourceName = element.propertyName?.text ?? element.name.text;
              if ((targetExports?.has(sourceName)) || (!target && locals.has(sourceName))) {
                moduleExports.add(element.name.text);
                producer = true;
              }
            }
          }
        }
        const exportedModifier = statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) ?? false;
        if (exportedModifier && ts.isFunctionDeclaration(statement) && statement.name && locals.has(statement.name.text)) moduleExports.add(statement.name.text);
        if (exportedModifier && ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && locals.has(declaration.name.text)) moduleExports.add(declaration.name.text);
          }
        }
      }
      const previous = exported.get(file);
      if (!previous || moduleExports.size !== previous.size || [...moduleExports].some((name) => !previous.has(name))) {
        exported.set(file, moduleExports);
        changed = true;
      }
      if (producer) discovered.add(path.relative(root, file).split(path.sep).join("/"));
    }
    if (!changed) break;
  }
  return discovered;
}

export function registryBootstrapAuthorityInventory(root: string, packaged = false): BootstrapAuthorityInventory {
  const diagnostics: BootstrapAuthorityDiagnostic[] = [];
  const records: BootstrapAuthorityInventoryRecord[] = [];
  const record = registryRecord(root, packaged);
  const prefix = packaged ? "bundle/" : "";
  const files = new Set<string>();
  for (const entry of [...record.bundle_surfaces.directories, ...record.bundle_surfaces.files]) {
    collectFiles(root, `${prefix}${String(entry.path)}`, files, diagnostics);
  }
  const exemptions = new Map<string, string>((record.bootstrap_command_authority?.exemptions ?? []).map((entry: any) => [String(entry.path), String(entry.reason ?? "")]));
  for (const inventoryPath of [...files].sort()) {
    const authorityPath = packaged ? inventoryPath.slice("bundle/".length) : inventoryPath;
    const extension = path.extname(authorityPath).toLowerCase();
    const exemptionReason = exemptions.get(authorityPath);
    if (exemptionReason) {
      records.push({ path: inventoryPath, surface: packaged ? "bundle" : "source", classification: "reason_classified", reason: exemptionReason });
    } else if (INSTRUCTIONAL_EXTENSIONS.has(extension)) {
      records.push({ path: inventoryPath, surface: packaged ? "bundle" : "source", classification: "parsed_and_scanned", reason: `${extension.slice(1)} parser and command scanner` });
      diagnostics.push(...preCutoverBootstrapAuthorityDiagnostics(authorityPath, fs.readFileSync(path.join(root, inventoryPath), "utf8")).map((item) => ({ ...item, path: inventoryPath })));
    } else {
      records.push({ path: inventoryPath, surface: packaged ? "bundle" : "source", classification: "reason_classified", reason: "" });
      diagnostics.push({
        path: inventoryPath,
        location: { structured_path: "$" },
        candidate: null,
        violation: "inventory_unclassified",
        correction: "Add a non-empty path-specific exemption reason or a parse-aware scanner classification.",
      });
    }
  }

  for (const generated of record.bundle_surfaces.generated_files ?? []) {
    const generatedPath = String(generated.path);
    if (!packaged) {
      records.push({ path: generatedPath, surface: "generated", classification: "reason_classified", reason: String(generated.command_authority_reason ?? "") });
      if (!generated.command_authority_reason) diagnostics.push({ path: generatedPath, location: { structured_path: "$" }, candidate: null, violation: "generated_unclassified", correction: "Declare why the generated source is not scanned until package construction." });
      continue;
    }
    const packagedPath = `bundle/${generatedPath}`;
    collectFiles(root, packagedPath, new Set(), diagnostics);
    records.push({ path: packagedPath, surface: "generated", classification: "reason_classified", reason: String(generated.command_authority_reason ?? "") });
    if (fs.existsSync(path.join(root, packagedPath))) diagnostics.push(...preCutoverBootstrapAuthorityDiagnostics(packagedPath, fs.readFileSync(path.join(root, packagedPath), "utf8")));
  }

  const producerEntries = record.bootstrap_command_authority?.emitted_producers ?? [];
  for (const producer of producerEntries) records.push({
    path: String(producer.path),
    surface: "emitted",
    classification: "reason_classified",
    reason: String(producer.reason ?? ""),
  });
  const sourceRoot = path.join(root, "packages/cli/src");
  if (!packaged && fs.existsSync(sourceRoot)) {
    const discovered = discoverEmittedProducerPaths(root);
    const declared = new Set<string>(producerEntries.map((entry: any) => String(entry.path)));
    for (const omitted of [...discovered].filter((entry) => !declared.has(entry)).sort()) diagnostics.push({ path: omitted, location: { structured_path: "$" }, candidate: null, violation: "emitted_producer_omitted", correction: "Classify this producer in package-registry.yaml and add an output check or inspectable constructor reason." });
    for (const stale of [...declared].filter((entry) => !discovered.has(entry)).sort()) diagnostics.push({ path: stale, location: { structured_path: "$" }, candidate: null, violation: "emitted_producer_missing", correction: "Remove the stale producer classification or restore its guarded producer." });
  }
  for (const producer of producerEntries) {
    if (!producer.reason) diagnostics.push({ path: String(producer.path), location: { structured_path: "$" }, candidate: null, violation: "emitted_producer_unclassified", correction: "Add a non-empty inspectable classification reason." });
  }
  return { records, diagnostics };
}

function normalizedInventoryRecord(record: BootstrapAuthorityInventoryRecord): string {
  const kind = record.surface === "source" || record.surface === "bundle" ? "bundle" : record.surface;
  const logicalPath = record.surface === "bundle" || (record.surface === "generated" && record.path.startsWith("bundle/"))
    ? record.path.slice("bundle/".length)
    : record.path;
  return JSON.stringify({ kind, path: logicalPath, classification: record.classification, reason: record.reason });
}

export function registryBootstrapAuthorityParity(sourceRoot: string, packageRoot: string): {
  source: string[];
  package: string[];
  diagnostics: BootstrapAuthorityDiagnostic[];
} {
  const sourceInventory = registryBootstrapAuthorityInventory(sourceRoot);
  const packageInventory = registryBootstrapAuthorityInventory(packageRoot, true);
  const source = [...new Set(sourceInventory.records.map(normalizedInventoryRecord))].sort();
  const packaged = [...new Set(packageInventory.records.map(normalizedInventoryRecord))].sort();
  const diagnostics = [...sourceInventory.diagnostics, ...packageInventory.diagnostics];
  for (const missing of source.filter((entry) => !packaged.includes(entry))) diagnostics.push({
    path: JSON.parse(missing).path,
    location: { structured_path: "$" },
    candidate: null,
    violation: "package_inventory_missing",
    correction: `Restore the extracted-package record exactly: ${missing}`,
  });
  for (const extra of packaged.filter((entry) => !source.includes(entry))) diagnostics.push({
    path: JSON.parse(extra).path,
    location: { structured_path: "$" },
    candidate: null,
    violation: "package_inventory_extra_or_mismatched",
    correction: `Remove or correctly classify the unmatched extracted-package record: ${extra}`,
  });
  return { source, package: packaged, diagnostics };
}

export function registryBundledAuthorityPaths(root: string): string[] {
  return registryBootstrapAuthorityInventory(root).records
    .filter(({ surface }) => surface === "source")
    .map(({ path: sourcePath }) => sourcePath)
    .sort();
}

export function registryBundledAuthorityViolations(
  root: string,
  overrides: ReadonlyMap<string, string> = new Map(),
): string[] {
  if (overrides.size === 0) return registryBootstrapAuthorityInventory(root).diagnostics.map(({ path: sourcePath, violation }) => `${sourcePath}: ${violation}`);
  return registryBundledAuthorityPaths(root).flatMap((relativePath) => {
    const content = overrides.get(relativePath) ?? fs.readFileSync(path.join(root, relativePath), "utf8");
    return preCutoverBootstrapAuthorityViolations(relativePath, content).map((violation) => `${relativePath}: ${violation}`);
  });
}
