import fs from "node:fs";
import path from "node:path";

import { resolvePath } from "../core/paths.js";
import { isNpxBundleRoot, resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMappingFile } from "../core/yaml.js";
import { validateStructuredInputInventory } from "../registries/structuredInputInventory.js";

const AUTHORITY_RELATIVE_PATH = "references/meta/retained-reference-authority.yaml";
const LIVE_ROOTS = ["references", "skills/agentera/references"] as const;
const RETAINED_CLASSES = new Set(["current", "migration-only", "runbook"]);
const ABSENT_CLASSES = new Set(["historical", "delete"]);
const CONSUMPTION_KINDS = new Set(["loads"]);
const CONSUMER_KINDS = new Set(["runtime", "validator"]);
const READER_CALLS = [
  "readFileSync",
  "readFile",
  "loadYamlMappingFile",
] as const;

type Mapping = Record<string, unknown>;
type ImportedSymbol = { module: string; symbol: string };

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Mapping
    : null;
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !path.isAbsolute(value)
    && !value.split(/[\\/]/).includes("..");
}

function isReferencePath(value: unknown): value is string {
  if (!isSafeRelativePath(value)) return false;
  return LIVE_ROOTS.some((root) => value === root || value.startsWith(root + "/"));
}

function isProductionModulePath(value: unknown): value is string {
  return isSafeRelativePath(value) && (
    /^packages\/cli\/src\/.+\.ts$/u.test(value)
    || /^packages\/cli\/scripts\/.+\.mjs$/u.test(value)
  );
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

/** Reject a path that escapes, or enters a source tree through, a symbolic link. */
function regularContainedFile(root: string, relative: string): string | null {
  if (!isSafeRelativePath(relative)) return null;
  const resolvedRoot = resolvePath(root);
  const candidate = path.resolve(resolvedRoot, relative);
  if (!pathInside(resolvedRoot, candidate)) return null;
  let current = resolvedRoot;
  for (const part of relative.split(/[\\/]/)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return null;
  }
  try {
    if (!fs.statSync(candidate).isFile()) return null;
    const realRoot = fs.realpathSync(resolvedRoot);
    const realCandidate = fs.realpathSync(candidate);
    return pathInside(realRoot, realCandidate) ? candidate : null;
  } catch {
    return null;
  }
}

function sourceWithoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:\\])\/\/.*$/gmu, "$1");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function braceEnd(source: string, opening: number): number | null {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = opening; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

function parenthesisEnd(source: string, opening: number): number | null {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = opening; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function splitArguments(source: string): string[] {
  const argumentsList: string[] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") round += 1;
    else if (character === ")") round -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
    else if (character === "," && round === 0 && square === 0 && curly === 0) {
      argumentsList.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const finalArgument = source.slice(start).trim();
  if (finalArgument) argumentsList.push(finalArgument);
  return argumentsList;
}

function namedCalls(source: string, names: readonly string[]): Array<{ name: string; argumentsList: string[] }> {
  const calls: Array<{ name: string; argumentsList: string[] }> = [];
  const re = new RegExp(`\\b(${names.map(escapeRegExp).join("|")})\\s*\\(`, "gu");
  for (const match of source.matchAll(re)) {
    if (match.index === undefined) continue;
    const opening = source.indexOf("(", match.index);
    const closing = parenthesisEnd(source, opening);
    if (closing === null) continue;
    calls.push({
      name: match[1]!,
      argumentsList: splitArguments(source.slice(opening + 1, closing)),
    });
  }
  return calls;
}

function functionParameterLists(source: string): Array<{ name: string; parameters: string[] }> {
  const lists: Array<{ name: string; parameters: string[] }> = [];
  const re = /function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gu;
  for (const match of source.matchAll(re)) {
    if (match.index === undefined) continue;
    const opening = match.index + match[0].length - 1;
    const closing = parenthesisEnd(source, opening);
    if (closing === null) continue;
    lists.push({
      name: match[1]!,
      parameters: source.slice(opening + 1, closing).split(","),
    });
  }
  return lists;
}

function declarationSource(source: string, symbol: string): string | null {
  const escaped = escapeRegExp(symbol);
  const functionMatch = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*\\(`,
    "u",
  ).exec(source);
  if (functionMatch && functionMatch.index !== undefined) {
    const opening = source.indexOf("{", functionMatch.index + functionMatch[0].length);
    const end = opening < 0 ? null : braceEnd(source, opening);
    return end === null ? null : source.slice(functionMatch.index, end);
  }
  const valueMatch = new RegExp(
    `(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`,
    "u",
  ).exec(source);
  if (!valueMatch || valueMatch.index === undefined) return null;
  const end = source.indexOf(";", valueMatch.index);
  return end < 0 ? source.slice(valueMatch.index) : source.slice(valueMatch.index, end + 1);
}

function declaredSymbols(source: string): string[] {
  const symbols = new Set<string>();
  for (const match of source.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gu)) {
    symbols.add(match[1]!);
  }
  for (const match of source.matchAll(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gu)) {
    symbols.add(match[1]!);
  }
  return [...symbols];
}

function resolveImportedModule(root: string, importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = [
    candidate,
    candidate.replace(/\.js$/u, ".ts"),
    candidate.replace(/\.mjs$/u, ".mjs"),
    `${candidate}/index.ts`,
  ];
  for (const relative of candidates) {
    if (!isProductionModulePath(relative)) continue;
    if (regularContainedFile(root, relative)) return relative;
  }
  return null;
}

function importedSymbols(root: string, modulePath: string, source: string): Map<string, ImportedSymbol> {
  const imports = new Map<string, ImportedSymbol>();
  const re = /(?:import|export)\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/gu;
  for (const match of source.matchAll(re)) {
    const importedModule = resolveImportedModule(root, modulePath, match[2]!);
    if (!importedModule) continue;
    for (const item of match[1]!.split(",")) {
      const parsed = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?\s*$/u.exec(item);
      if (parsed) imports.set(parsed[2] ?? parsed[1]!, { module: importedModule, symbol: parsed[1]! });
    }
  }
  return imports;
}

function sourceClosure(root: string, modulePath: string, symbol: string, referencePath: string): string[] {
  const fragments: string[] = [];
  const visited = new Set<string>();
  const visit = (currentModule: string, currentSymbol: string): void => {
    const key = `${currentModule}:${currentSymbol}`;
    if (visited.has(key)) return;
    visited.add(key);
    const absolute = regularContainedFile(root, currentModule);
    if (!absolute) return;
    const source = sourceWithoutComments(fs.readFileSync(absolute, "utf8"));
    const declaration = declarationSource(source, currentSymbol);
    if (!declaration) return;
    fragments.push(declaration);
    const imports = importedSymbols(root, currentModule, source);
    for (const name of source.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gu)) {
      const local = name[1]!;
      if (local !== currentSymbol && new RegExp(`\\b${escapeRegExp(local)}\\s*\\(`, "u").test(declaration)) {
        visit(currentModule, local);
      }
    }
    for (const [local, imported] of imports) {
      const importedPath = regularContainedFile(root, imported.module);
      const importedSource = importedPath ? sourceWithoutComments(fs.readFileSync(importedPath, "utf8")) : "";
      const importedDeclaration = declarationSource(importedSource, imported.symbol);
      if (
        importedDeclaration
        && (new RegExp(`\\b${escapeRegExp(local)}\\s*\\(`, "u").test(declaration)
          || referencePathExpression(importedDeclaration.replace(/^[^=]+=/u, "").replace(/;\s*$/u, ""), referencePath))
      ) {
        visit(imported.module, imported.symbol);
      }
    }
    for (const local of declaredSymbols(source)) {
      const localDeclaration = declarationSource(source, local);
      if (localDeclaration && !/function\s+/u.test(localDeclaration)
        && (
          referencePathExpression(localDeclaration.replace(/^[^=]+=/u, "").replace(/;\s*$/u, ""), referencePath)
          || new RegExp(`\\b${escapeRegExp(local)}\\b`, "u").test(declaration)
        )) {
        fragments.push(localDeclaration);
      }
    }
  };
  visit(modulePath, symbol);
  return fragments;
}

function exactStringLiteral(expression: string): string | null {
  const match = /^\s*(["'])([\s\S]*)\1\s*$/u.exec(expression);
  return match ? match[2]! : null;
}

function pathCallArguments(expression: string): string[][] {
  const calls: string[][] = [];
  for (const match of expression.matchAll(/\bpath\.(?:join|resolve)\s*\(/gu)) {
    if (match.index === undefined) continue;
    const opening = expression.indexOf("(", match.index);
    const closing = parenthesisEnd(expression, opening);
    if (closing !== null) calls.push(splitArguments(expression.slice(opening + 1, closing)));
  }
  return calls;
}

/**
 * Evaluate only the path forms used by production consumers. A match must be
 * one exact literal/binding/provider, or literals joined inside one path call.
 * Unrelated literals in an array, options argument, or surrounding expression
 * never combine into a path.
 */
function referencePathExpression(
  expression: string,
  referencePath: string,
  bindings: Set<string> = new Set(),
  providers: Set<string> = new Set(),
): boolean {
  const literal = exactStringLiteral(expression.replace(/\s+as\s+(?:const|any|unknown|string)\s*$/u, ""));
  if (literal === referencePath) return true;
  const identifier = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*$/u.exec(expression)?.[1];
  if (identifier && bindings.has(identifier)) return true;
  if ([...providers].some((provider) =>
    new RegExp(`^\\s*${escapeRegExp(provider)}\\s*\\([^)]*\\)\\s*$`, "u").test(expression))) {
    return true;
  }
  for (const argumentsList of pathCallArguments(expression)) {
    let suffix: string[] = [];
    for (const argument of argumentsList) {
      const argumentLiteral = exactStringLiteral(argument);
      if (argumentLiteral !== null) {
        suffix.push(argumentLiteral);
      } else if (
        referencePathExpression(argument, referencePath, bindings, providers)
        || [...bindings].some((binding) => new RegExp(
          `^\\s*\\.\\.\\.\\s*${escapeRegExp(binding)}\\.split\\(\\s*["']/["']\\s*\\)\\s*$`,
          "u",
        ).test(argument))
      ) {
        suffix = [referencePath];
      } else {
        // An unknown value can be a root prefix, but it breaks any previously
        // accumulated literal path.
        suffix = [];
      }
    }
    if (path.posix.normalize(path.posix.join(...suffix)) === referencePath) return true;
  }
  return false;
}

function returnExpressions(declaration: string): string[] {
  return [...declaration.matchAll(/\breturn\s+([^;\n}]+)/gu)].map((match) => match[1]!.trim());
}

function referenceFacts(fragments: string[], referencePath: string): {
  bindings: Set<string>;
  providers: Set<string>;
} {
  const bindings = new Set<string>();
  const providers = new Set<string>();
  const source = fragments.join("\n");
  const declarations = [...source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([^;]+);/gu)];
  const functions = functionParameterLists(source);
  const parameterNames = new Map(functions.map(({ name, parameters }) => [
    name,
    parameters.map((parameter) => /^\s*([A-Za-z_$][A-Za-z0-9_$]*)/u.exec(parameter)?.[1] ?? ""),
  ]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of declarations) {
      const name = match[1]!;
      if (!bindings.has(name) && referencePathExpression(match[2]!, referencePath, bindings, providers)) {
        bindings.add(name);
        changed = true;
      }
    }
    for (const { name } of functions) {
      if (providers.has(name)) continue;
      const declaration = declarationSource(source, name);
      if (declaration && returnExpressions(declaration).some((expression) =>
        referencePathExpression(expression, referencePath, bindings, providers))) {
        providers.add(name);
        changed = true;
      }
    }
    for (const call of namedCalls(source, [...parameterNames.keys()])) {
      const parameters = parameterNames.get(call.name);
      if (!parameters) continue;
      call.argumentsList.forEach((argument, index) => {
        const parameter = parameters[index];
        if (parameter && !bindings.has(parameter)
          && referencePathExpression(argument, referencePath, bindings, providers)) {
          bindings.add(parameter);
          changed = true;
        }
      });
    }
    for (const functionParameters of functions) {
      for (const parameter of functionParameters.parameters) {
        const match = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)[^=]*=([\s\S]+)$/u.exec(parameter);
        if (match && !bindings.has(match[1]!)
          && referencePathExpression(match[2]!, referencePath, bindings, providers)) {
          bindings.add(match[1]!);
          changed = true;
        }
      }
    }
  }
  return { bindings, providers };
}

function hasExactReadOrParse(fragments: string[], referencePath: string): boolean {
  const source = fragments.join("\n");
  const { bindings, providers } = referenceFacts(fragments, referencePath);
  return namedCalls(source, READER_CALLS).some(({ argumentsList }) => {
    const pathArgument = argumentsList[0];
    return pathArgument !== undefined
      && referencePathExpression(pathArgument, referencePath, bindings, providers);
  });
}

function allProductionModules(root: string): string[] {
  const modules: string[] = [];
  const visit = (relative: string): void => {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) visit(path.posix.join(relative, entry.name));
      return;
    }
    if (stat.isFile() && isProductionModulePath(relative)) modules.push(relative);
  };
  visit("packages/cli/src");
  visit("packages/cli/scripts");
  return modules;
}

function productionEntrypoints(root: string): string[] {
  const entrypoints = new Set<string>();
  if (regularContainedFile(root, "packages/cli/src/bin/agentera.ts")) {
    entrypoints.add("packages/cli/src/bin/agentera.ts");
  }
  const packagePath = regularContainedFile(root, "packages/cli/package.json");
  if (!packagePath) return [...entrypoints];
  try {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as Mapping;
    const scripts = mapping(packageJson.scripts);
    for (const script of Object.values(scripts ?? {})) {
      if (typeof script !== "string") continue;
      for (const match of script.matchAll(/(?:^|\s)(scripts\/[A-Za-z0-9_./-]+\.mjs)\b/gu)) {
        const candidate = `packages/cli/${match[1]!}`;
        if (regularContainedFile(root, candidate)) entrypoints.add(candidate);
      }
    }
  } catch {
    // The participant validation reports malformed package metadata through the runbook check.
  }
  return [...entrypoints];
}

function reachableProductionModules(root: string): Set<string> {
  const reachable = new Set<string>();
  const pending = productionEntrypoints(root);
  while (pending.length > 0) {
    const modulePath = pending.pop()!;
    if (reachable.has(modulePath)) continue;
    const absolute = regularContainedFile(root, modulePath);
    if (!absolute) continue;
    reachable.add(modulePath);
    const source = sourceWithoutComments(fs.readFileSync(absolute, "utf8"));
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu)) {
      const dependency = resolveImportedModule(root, modulePath, match[1]!);
      if (dependency && !reachable.has(dependency)) pending.push(dependency);
    }
  }
  return reachable;
}

interface FunctionDeclaration {
  name: string;
  start: number;
  end: number;
  body: string;
}

function functionDeclarations(source: string): FunctionDeclaration[] {
  const declarations: FunctionDeclaration[] = [];
  const re = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gu;
  for (const match of source.matchAll(re)) {
    if (match.index === undefined) continue;
    const opening = source.indexOf("{", match.index + match[0].length);
    const end = opening < 0 ? null : braceEnd(source, opening);
    if (end === null) continue;
    declarations.push({
      name: match[1]!,
      start: match.index,
      end,
      body: source.slice(opening + 1, end - 1),
    });
  }
  return declarations;
}

function topLevelExecutionSource(source: string, declarations: FunctionDeclaration[]): string {
  const characters = [...source];
  for (const declaration of declarations) {
    for (let index = declaration.start; index < declaration.end; index += 1) characters[index] = " ";
  }
  return characters.join("");
}

function symbolIsReachable(root: string, modulePath: string, symbol: string): boolean {
  const reachable = reachableProductionModules(root);
  if (!reachable.has(modulePath)) return false;
  const modules = new Map<string, {
    source: string;
    functions: Map<string, FunctionDeclaration>;
    imports: Map<string, ImportedSymbol>;
  }>();
  for (const candidate of reachable) {
    const absolute = regularContainedFile(root, candidate);
    if (!absolute) continue;
    const source = sourceWithoutComments(fs.readFileSync(absolute, "utf8"));
    const declarations = functionDeclarations(source);
    modules.set(candidate, {
      source,
      functions: new Map(declarations.map((declaration) => [declaration.name, declaration])),
      imports: importedSymbols(root, candidate, source),
    });
  }
  const target = modules.get(modulePath);
  if (!target) return false;
  // A reachable module executes non-function declarations while loading.
  // Declared functions require an actual call chain from module evaluation.
  if (!target.functions.has(symbol)) return true;

  const reachedFunctions = new Set<string>();
  const pending: Array<{ modulePath: string; source: string }> = [];
  for (const [candidate, module] of modules) {
    pending.push({
      modulePath: candidate,
      source: topLevelExecutionSource(module.source, [...module.functions.values()]),
    });
  }
  while (pending.length > 0) {
    const current = pending.pop()!;
    const module = modules.get(current.modulePath);
    if (!module) continue;
    const callableNames = [...new Set([...module.functions.keys(), ...module.imports.keys()])];
    for (const call of namedCalls(current.source, callableNames)) {
      const imported = module.imports.get(call.name);
      let calledModule = imported?.module ?? current.modulePath;
      let calledSymbol = imported?.symbol ?? call.name;
      const forwarded = new Set<string>();
      while (!modules.get(calledModule)?.functions.has(calledSymbol)) {
        const forwardingKey = `${calledModule}:${calledSymbol}`;
        if (forwarded.has(forwardingKey)) break;
        forwarded.add(forwardingKey);
        const next = modules.get(calledModule)?.imports.get(calledSymbol);
        if (!next) break;
        calledModule = next.module;
        calledSymbol = next.symbol;
      }
      const key = `${calledModule}:${calledSymbol}`;
      if (reachedFunctions.has(key)) continue;
      const calledDeclaration = modules.get(calledModule)?.functions.get(calledSymbol);
      if (!calledDeclaration) continue;
      reachedFunctions.add(key);
      pending.push({ modulePath: calledModule, source: calledDeclaration.body });
    }
  }
  return reachedFunctions.has(`${modulePath}:${symbol}`);
}

/** Whether a root has source files needed to audit source-only retained references. */
export function isRetainedReferenceSourceCheckout(root: string = resolveSourceRoot()): boolean {
  const resolved = resolvePath(root);
  return !isNpxBundleRoot(resolved)
    && regularContainedFile(resolved, "packages/cli/package.json") !== null
    && regularContainedFile(resolved, "packages/cli/src/bin/agentera.ts") !== null
    && regularContainedFile(resolved, AUTHORITY_RELATIVE_PATH) !== null;
}

function listLiveFiles(root: string, relative: string, errors: string[]): string[] {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    errors.push(`${relative}: live reference roots must not contain symlinks`);
    return [];
  }
  if (stat.isFile()) return [relative.replace(/\\/gu, "/")];
  if (!stat.isDirectory()) {
    errors.push(`${relative}: live reference entry must be a regular file or directory`);
    return [];
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`${child}: live reference roots must not contain symlinks`);
    } else if (entry.isDirectory() || entry.isFile()) {
      files.push(...listLiveFiles(root, child, errors));
    } else {
      errors.push(`${child}: live reference entry must be a regular file`);
    }
  }
  return files;
}

function validateProductionParticipant(
  root: string,
  referencePath: string,
  label: string,
  raw: unknown,
  requireConsumption: boolean,
): string[] {
  const value = mapping(raw);
  if (!value) return [`${referencePath}: ${label} must be a mapping`];
  const errors: string[] = [];
  const modulePath = value.module;
  const symbol = value.symbol;
  if (!isProductionModulePath(modulePath)) {
    errors.push(`${referencePath}: ${label}.module must name a contained production packages/cli src or scripts module`);
    return errors;
  }
  if (typeof symbol !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(symbol)) {
    errors.push(`${referencePath}: ${label}.symbol must name a production symbol`);
    return errors;
  }
  const absoluteModule = regularContainedFile(root, modulePath);
  if (!absoluteModule) {
    errors.push(`${referencePath}: ${label}.module must be a contained regular production file, not a symlink`);
    return errors;
  }
  const source = sourceWithoutComments(fs.readFileSync(absoluteModule, "utf8"));
  if (!declarationSource(source, symbol)) {
    errors.push(`${referencePath}: ${label}.symbol is not declared by ${modulePath}`);
    return errors;
  }
  if (!requireConsumption) return errors;

  const kind = value.kind;
  const consumption = value.consumption;
  if (!CONSUMER_KINDS.has(String(kind))) {
    errors.push(`${referencePath}: ${label}.kind must be runtime or validator`);
  }
  if (!CONSUMPTION_KINDS.has(String(consumption))) {
    errors.push(`${referencePath}: ${label}.consumption must be loads`);
    return errors;
  }
  const fragments = sourceClosure(root, modulePath, symbol, referencePath);
  if (!hasExactReadOrParse(fragments, referencePath)) {
    errors.push(`${referencePath}: ${label} must read or parse the exact reference; unrelated reads and emitted strings do not count`);
  }
  if (!symbolIsReachable(root, modulePath, symbol)) {
    errors.push(`${referencePath}: ${label}.symbol is not reachable from a production CLI or package-script entrypoint`);
  }
  return errors;
}

function validateTrackedCommand(root: string, referencePath: string, command: string): string | null {
  if (/[|;&><`$]/u.test(command)) {
    return `${referencePath}: runbook command must be one noninteractive tracked command without shell composition`;
  }
  const pnpm = /^pnpm -C ([A-Za-z0-9_./-]+) run ([A-Za-z0-9:_-]+)$/u.exec(command);
  if (pnpm) {
    const packageDirectory = pnpm[1];
    const packageJson = regularContainedFile(root, path.posix.join(packageDirectory, "package.json"));
    if (!isSafeRelativePath(packageDirectory) || !packageJson) {
      return `${referencePath}: runbook command package directory is not tracked`;
    }
    try {
      const data = JSON.parse(fs.readFileSync(packageJson, "utf8")) as Mapping;
      const scripts = mapping(data.scripts);
      if (typeof scripts?.[pnpm[2]] !== "string") {
        return `${referencePath}: runbook command script '${pnpm[2]}' is not tracked in ${packageDirectory}/package.json`;
      }
    } catch (error) {
      return `${referencePath}: runbook command package metadata is unreadable: ${(error as Error).message}`;
    }
    return null;
  }
  const node = /^node (packages\/cli\/dist\/bin\/agentera\.js)(?: [A-Za-z0-9_./:=,-]+)*$/u.exec(command);
  if (node) {
    try {
      const packageJsonPath = regularContainedFile(root, "packages/cli/package.json");
      if (!packageJsonPath) throw new Error("packages/cli/package.json is not a regular file");
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Mapping;
      const bin = mapping(packageJson.bin);
      if (bin?.agentera !== "dist/bin/agentera.js") {
        return `${referencePath}: runbook command must use the tracked agentera package bin`;
      }
    } catch (error) {
      return `${referencePath}: runbook command package metadata is unreadable: ${(error as Error).message}`;
    }
    return null;
  }
  return `${referencePath}: runbook command must use a tracked pnpm script or the local agentera bin`;
}

function validateRunbook(root: string, referencePath: string, raw: Mapping): string[] {
  const errors: string[] = [];
  const maintainer = raw.maintainer;
  const sourceCheckout = raw.source_checkout_root;
  const workingDirectory = raw.working_directory;
  const command = raw.command;
  if (typeof maintainer !== "string" || !maintainer.trim()) {
    errors.push(`${referencePath}: runbook maintainer is required`);
  }
  if (sourceCheckout !== ".") {
    errors.push(`${referencePath}: runbook source_checkout_root must be the source checkout root '.'`);
  } else if (!isRetainedReferenceSourceCheckout(root)) {
    errors.push(`${referencePath}: runbook source_checkout_root is not a source checkout`);
  }
  if (!isSafeRelativePath(workingDirectory) && workingDirectory !== ".") {
    errors.push(`${referencePath}: runbook working_directory must be root-relative`);
  } else if (!fs.existsSync(path.join(root, String(workingDirectory))) || !fs.statSync(path.join(root, String(workingDirectory))).isDirectory()) {
    errors.push(`${referencePath}: runbook working_directory does not exist`);
  }
  if (typeof command !== "string" || !command.trim()) {
    errors.push(`${referencePath}: runbook command is required`);
  } else {
    const commandError = validateTrackedCommand(root, referencePath, command);
    if (commandError) errors.push(commandError);
  }
  const documentPath = regularContainedFile(root, referencePath);
  if (!documentPath) return errors;
  const document = fs.readFileSync(documentPath, "utf8");
  if (typeof maintainer === "string" && !document.includes(`- Maintainer: ${maintainer}`)) {
    errors.push(`${referencePath}: runbook must visibly name its maintainer`);
  }
  if (sourceCheckout === "." && !document.includes("- Source checkout root: `.`")) {
    errors.push(`${referencePath}: runbook must visibly name the source checkout root`);
  }
  if (typeof workingDirectory === "string" && !document.includes(`- Working directory: \`${workingDirectory}\``)) {
    errors.push(`${referencePath}: runbook must visibly name its root-relative working directory`);
  }
  if (typeof command === "string" && !document.includes(`- Command: \`${command}\``)) {
    errors.push(`${referencePath}: runbook must visibly name its exact command`);
  }
  return errors;
}

/** Validate the complete source-checkout retained-reference inventory. */
export function validateRetainedReferenceAuthority(root: string = resolveSourceRoot()): string[] {
  const resolvedRoot = resolvePath(root);
  if (!isRetainedReferenceSourceCheckout(resolvedRoot)) {
    return [
      `${AUTHORITY_RELATIVE_PATH}: retained-reference validation requires a source checkout with packages/cli/src; ` +
      "recovery: run it from the repository root after pnpm -C packages/cli build",
    ];
  }
  const authorityPath = regularContainedFile(resolvedRoot, AUTHORITY_RELATIVE_PATH);
  if (!authorityPath) return [`${AUTHORITY_RELATIVE_PATH}: authority file must be a contained regular file`];
  let authority: Mapping;
  try {
    authority = loadYamlMappingFile(authorityPath) as Mapping;
  } catch (error) {
    return [`${AUTHORITY_RELATIVE_PATH}: ${(error as Error).message}`];
  }

  const errors: string[] = [];
  if (authority.schema_version !== "agentera.retainedReferenceAuthority.v1") {
    errors.push(`${AUTHORITY_RELATIVE_PATH}: unsupported schema_version`);
  }
  if (!Array.isArray(authority.live_roots) || JSON.stringify(authority.live_roots) !== JSON.stringify(LIVE_ROOTS)) {
    errors.push(`${AUTHORITY_RELATIVE_PATH}: live_roots must be ${LIVE_ROOTS.join(", ")}`);
  }
  if (!Array.isArray(authority.inventory)) {
    return [...errors, `${AUTHORITY_RELATIVE_PATH}: inventory must be a list`];
  }

  const entries = new Map<string, Mapping>();
  for (const [index, raw] of authority.inventory.entries()) {
    const entry = mapping(raw);
    if (!entry) {
      errors.push(`${AUTHORITY_RELATIVE_PATH}: inventory[${index}] must be a mapping`);
      continue;
    }
    const referencePath = entry.path;
    const classification = entry.classification;
    if (!isReferencePath(referencePath)) {
      errors.push(`${AUTHORITY_RELATIVE_PATH}: inventory[${index}].path must stay in a live reference root`);
      continue;
    }
    if (!RETAINED_CLASSES.has(String(classification)) && !ABSENT_CLASSES.has(String(classification))) {
      errors.push(`${referencePath}: classification must be current, migration-only, runbook, historical, or delete`);
      continue;
    }
    if (entries.has(referencePath)) {
      errors.push(`${referencePath}: inventory paths must be unique`);
      continue;
    }
    entries.set(referencePath, entry);
  }

  const liveFiles = new Set(LIVE_ROOTS.flatMap((liveRoot) => listLiveFiles(resolvedRoot, liveRoot, errors)));
  for (const referencePath of [...liveFiles].sort()) {
    const entry = entries.get(referencePath);
    if (!entry) {
      errors.push(`${referencePath}: live reference is absent from the retained-reference inventory`);
      continue;
    }
    if (ABSENT_CLASSES.has(String(entry.classification))) {
      errors.push(`${referencePath}: ${entry.classification} inventory entries must be absent from live roots`);
    }
  }

  for (const [referencePath, entry] of entries) {
    const classification = String(entry.classification);
    if (RETAINED_CLASSES.has(classification) && !liveFiles.has(referencePath)) {
      errors.push(`${referencePath}: retained ${classification} reference is missing from live roots`);
      continue;
    }
    if (ABSENT_CLASSES.has(classification)) {
      if (liveFiles.has(referencePath)) {
        errors.push(`${referencePath}: ${classification} inventory entries must be absent from live roots`);
      }
      continue;
    }
    if (classification === "current" || classification === "migration-only") {
      if (classification === "migration-only" && !/^references\/(?:adapters|cli)\//u.test(referencePath)) {
        errors.push(`${referencePath}: migration-only references must remain in references/adapters or references/cli`);
      }
      errors.push(...validateProductionParticipant(resolvedRoot, referencePath, "production_owner", entry.production_owner, false));
      if (!Array.isArray(entry.consumers) || entry.consumers.length === 0) {
        errors.push(`${referencePath}: ${classification} references require a runtime or validator consumer`);
      } else {
        for (const [index, consumer] of entry.consumers.entries()) {
          errors.push(...validateProductionParticipant(resolvedRoot, referencePath, `consumers[${index}]`, consumer, true));
        }
      }
    } else if (classification === "runbook") {
      errors.push(...validateRunbook(resolvedRoot, referencePath, entry));
    }
  }
  return errors;
}

export interface RetainedReferenceAuthorityMainOptions {
  root?: string;
  out?: (line: string) => void;
}

export function retainedReferenceAuthorityMain(opts: RetainedReferenceAuthorityMainOptions = {}): number {
  const root = resolvePath(opts.root ?? resolveSourceRoot());
  const errors = validateRetainedReferenceAuthority(root);
  if (errors.length === 0) {
    errors.push(...validateStructuredInputInventory(
      path.join(root, "references/analysis/structured-input-inventory.yaml"),
    ));
  }
  const out = opts.out ?? ((line: string) => process.stdout.write(line + "\n"));
  if (errors.length > 0) {
    out("retained reference authority validation failed:");
    for (const error of errors) out(`- ${error}`);
    return 1;
  }
  out("retained reference authority ok");
  return 0;
}
