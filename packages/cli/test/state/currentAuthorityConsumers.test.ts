import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../../..");

const CURRENT_STATE_CONSUMERS = [
  "packages/cli/src/cli/commands/prime/collectOrientationState.ts",
  "packages/cli/src/cli/commands/prime/collectEntityOrientation.ts",
  "packages/cli/src/cli/commands/query.ts",
  "packages/cli/src/cli/commands/state/decisions.ts",
  "packages/cli/src/cli/commands/state/docs.ts",
  "packages/cli/src/cli/commands/state/experimentRecords.ts",
  "packages/cli/src/cli/commands/state/experiments.ts",
  "packages/cli/src/cli/commands/state/get.ts",
  "packages/cli/src/cli/commands/state/health.ts",
  "packages/cli/src/cli/commands/state/list.ts",
  "packages/cli/src/cli/commands/state/objective.ts",
  "packages/cli/src/cli/commands/state/plan.ts",
  "packages/cli/src/cli/commands/state/plans.ts",
  "packages/cli/src/cli/commands/state/planTasks.ts",
  "packages/cli/src/cli/commands/state/progress.ts",
  "packages/cli/src/cli/commands/state/todo.ts",
  "packages/cli/src/cli/commands/state/write.ts",
  "packages/cli/src/state/durability.ts",
  "packages/cli/src/state/write/transaction.ts",
] as const;

const LEGACY_SELECTOR_CALLS = [
  "listStateEntries(",
  "retrieveStateEntry(",
  "listPlans(",
  "getPlan(",
  "listPlanTasks(",
  "getPlanTask(",
  "listExperiments(",
  "getExperiment(",
  "scanStartupArtifact(",
] as const;

const MIGRATION_READERS = [
  "packages/cli/src/state/entityMigrationPreview.ts",
  "packages/cli/src/upgrade/migrateArtifactsV2ToV3.ts",
  "packages/cli/src/migrate/v2HandoffManifest.ts",
] as const;

const LEGACY_AGGREGATES = ["decisions", "plan", "progress", "health", "todo", "docs", "objectives", "experiments"] as const;
const PATH_CONSTRUCTORS = ["path.join", "path.resolve", "resolvePath", "fs.readFileSync", "fs.existsSync", "fs.writeFileSync"] as const;

function source(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function productionTypeScript(): string[] {
  const root = path.join(ROOT, "packages/cli/src");
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function callBodies(text: string, callee: string): string[] {
  const bodies: string[] = [];
  const calls = new RegExp(`${callee.replace(".", "\\.")}\\s*\\(`, "g");
  for (const match of text.matchAll(calls)) {
    const start = match.index!;
    let depth = 1;
    let quote = "";
    let escaped = false;
    const bodyStart = start + match[0].length;
    for (let index = bodyStart; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (quote) { if (char === quote) quote = ""; continue; }
      if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
      if (char === "(") depth += 1;
      else if (char === ")" && --depth === 0) { bodies.push(text.slice(bodyStart, index)); break; }
    }
  }
  return bodies;
}

function legacyReaderCalls(text: string): string[] {
  const findings: string[] = [];
  for (const call of LEGACY_SELECTOR_CALLS) {
    const name = call.slice(0, -1);
    const declaration = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`, "g");
    const declaredAt = new Set([...text.matchAll(declaration)].map((match) => match.index! + match[0].lastIndexOf(name)));
    const invoked = new RegExp(`\\b${name}\\s*\\(`, "g");
    for (const match of text.matchAll(invoked)) if (!declaredAt.has(match.index!)) findings.push(`${name}()`);
  }
  return findings;
}

interface SourceLiteral { quote: string; value: string; start: number; end: number }

function stringLiterals(text: string): SourceLiteral[] {
  const literals: SourceLiteral[] = [];
  for (let index = 0; index < text.length;) {
    if (text.startsWith("//", index)) { index = text.indexOf("\n", index + 2); if (index < 0) break; continue; }
    if (text.startsWith("/*", index)) { index = text.indexOf("*/", index + 2); if (index < 0) break; index += 2; continue; }
    const quote = text[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") { index += 1; continue; }
    const start = index;
    let value = "";
    let escaped = false;
    index += 1;
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) { value += char; escaped = false; continue; }
      if (char === "\\") { value += char; escaped = true; continue; }
      if (char === quote) { index += 1; break; }
      value += char;
    }
    literals.push({ quote, value, start, end: index });
  }
  return literals;
}

function isStandaloneLiteral(text: string, literal: SourceLiteral): boolean {
  const lineStart = text.lastIndexOf("\n", literal.start - 1) + 1;
  const nextLine = text.indexOf("\n", literal.end);
  const lineEnd = nextLine < 0 ? text.length : nextLine;
  const prefix = text.slice(lineStart, literal.start).trim();
  const suffix = text.slice(literal.end, lineEnd);
  return (prefix === "" || /^(?:(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=)$/.test(prefix)) && /^;?\s*$/.test(suffix);
}

function aggregateConstructions(text: string): string[] {
  const findings = new Set<string>();
  for (const literal of stringLiterals(text)) for (const aggregate of LEGACY_AGGREGATES) {
    if ((isStandaloneLiteral(text, literal) || (literal.quote === "`" && literal.value.includes("${"))) && literal.value.includes(`.agentera/${aggregate}.yaml`)) {
      findings.add(`aggregate path ${aggregate}.yaml`);
    }
  }
  for (const callee of PATH_CONSTRUCTORS) for (const body of callBodies(text, callee)) {
    const compact = body.replace(/\s+/g, "").replace(/["'`]/g, "");
    for (const aggregate of LEGACY_AGGREGATES) {
      if (compact.includes(`.agentera/${aggregate}.yaml`) || compact.includes(`.agentera,${aggregate}.yaml`) || compact.includes(`.agentera/+${aggregate}.yaml`)) {
        findings.add(`aggregate path ${aggregate}.yaml`);
      }
    }
  }
  return [...findings].sort();
}

function violations(relative: string, text: string): string[] {
  if ((MIGRATION_READERS as readonly string[]).includes(relative)) return [];
  return [...legacyReaderCalls(text), ...aggregateConstructions(text)];
}

describe("current entity authority consumer inventory", () => {
  it("keeps current startup, state, durability, and writer consumers free of local mode routing", () => {
    for (const relative of CURRENT_STATE_CONSUMERS) {
      const text = source(relative);
      expect(text, relative).not.toContain("detectStateMode(");
      expect(text, relative).not.toContain("detectStateModeBinding(");
      for (const call of LEGACY_SELECTOR_CALLS) expect(text, `${relative}: ${call}`).not.toContain(call);
    }
  });

  it("scans every production TypeScript file for retired readers and aggregate paths", () => {
    for (const file of productionTypeScript()) {
      const relative = path.relative(ROOT, file);
      expect(violations(relative, fs.readFileSync(file, "utf8")), relative).toEqual([]);
    }
  });

  it("detects hostile standalone literals, templates, path segments, and named readers", () => {
    const target = "packages/cli/src/cli/hostile.ts";
    for (const aggregate of LEGACY_AGGREGATES) {
      expect(violations(target, `const stale = ".agentera/${aggregate}.yaml";`)).toContain(`aggregate path ${aggregate}.yaml`);
    }
    expect(violations(target, 'const stale = ".agentera/decisions.yaml";')).toEqual(["aggregate path decisions.yaml"]);
    const template = "const stale = `${root}/.agentera/decisions.yaml`;";
    expect(violations(target, template)).toEqual(["aggregate path decisions.yaml"]);
    expect(violations(target, 'path.join(root, ".agentera", "decisions.yaml");')).toEqual(["aggregate path decisions.yaml"]);
    expect(violations(target, "path.join ( root, '.agentera', 'decisions.yaml' );")).toEqual(["aggregate path decisions.yaml"]);
    expect(violations(target, 'retrieveStateEntry(root, "decisions", 1);')).toEqual(["retrieveStateEntry()"]);
  });

  it("allows entity paths and excludes only the exact migration owners", () => {
    const hostile = 'const stale = ".agentera/decisions.yaml";';
    expect(violations("packages/cli/src/cli/entity-reader.ts", 'const current = ".agentera/entities/decisions/decision/abcdefghij.yaml";')).toEqual([]);
    for (const relative of MIGRATION_READERS) expect(violations(relative, hostile), relative).toEqual([]);
  });

  it("preserves the closed read-only migration and handoff reader inventory", () => {
    for (const relative of MIGRATION_READERS) expect(fs.existsSync(path.join(ROOT, relative)), relative).toBe(true);
    const migration = source(MIGRATION_READERS[0]);
    for (const aggregate of [
      ".agentera/progress.yaml",
      ".agentera/decisions.yaml",
      ".agentera/health.yaml",
      ".agentera/plan.yaml",
    ]) expect(migration, aggregate).toContain(aggregate);
    expect(migration).toContain("read_only: true");
    expect(migration).toContain("mutation_performed: false");
  });
});
