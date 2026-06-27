// Regression: OpenCode plugin hook handlers route through the v3 npm entrypoint
// (npx -y agentera@next), not uv-run / v2 Python managed scripts (defect #7, B4 task 1).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const PLUGIN_PATH = path.join(REPO_ROOT, ".opencode/plugins/agentera.js");

const HOOK_HANDLERS = [
  "runNpxHook",
  "validateArtifact",
  "validateArtifactCandidate",
  "writeSessionBookmark",
  "buildCompactionContext",
] as const;

const DIRECT_NPX_HANDLERS = ["runNpxHook", "validateArtifactCandidate", "buildCompactionContext"] as const;

const DELEGATES_TO_RUN_NPX_HOOK = ["validateArtifact", "writeSessionBookmark"] as const;

const FORBIDDEN_PATTERNS = [
  /\buv\s+run\b/,
  /\buvx\b/,
  /execFileSync\s*\(\s*["']uv["']/,
  /spawnSync\s*\(\s*["']uv["']/,
  /hooks\/validate_artifact\.py/,
  /scripts\/agentera/,
];

function extractFunctionBody(source: string, name: string): string {
  const sig = `function ${name}(`;
  const start = source.indexOf(sig);
  if (start === -1) throw new Error(`function ${name} not found in plugin source`);
  const openBrace = source.indexOf("{", start);
  if (openBrace === -1) throw new Error(`function ${name} has no body`);
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(openBrace, i + 1);
    }
  }
  throw new Error(`unbalanced braces in function ${name}`);
}

describe("OpenCode plugin v3 npx entrypoint source contract (B4-1, defect #7)", () => {
  const source = fs.readFileSync(PLUGIN_PATH, "utf8");

  it("defines NPX_CLI_ENTRYPOINT as npx -y agentera@next", () => {
    expect(source).toMatch(/const NPX_CLI_ENTRYPOINT = "npx -y agentera@next";/);
  });

  it.each(HOOK_HANDLERS)("%s has no uv-run or Python-managed-entrypoint calls", (handler) => {
    const body = extractFunctionBody(source, handler);
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(body).not.toMatch(pattern);
    }
  });

  it.each(DIRECT_NPX_HANDLERS)("%s routes CLI invocations through NPX_CLI_ENTRYPOINT", (handler) => {
    const body = extractFunctionBody(source, handler);
    expect(body).toContain("NPX_CLI_ENTRYPOINT");
  });

  it.each(DELEGATES_TO_RUN_NPX_HOOK)("%s delegates to runNpxHook (v3 npx router)", (handler) => {
    const body = extractFunctionBody(source, handler);
    expect(body).toContain("runNpxHook(");
  });

  it("runNpxHook builds an npx execFileSync command", () => {
    const body = extractFunctionBody(source, "runNpxHook");
    expect(body).toMatch(/execFileSync\s*\(\s*["']npx["']/);
    expect(body).toContain('args.push("hook", subcommand)');
  });

  it("runNpxHook does not gate on v2 managed scripts before invoking npx", () => {
    const body = extractFunctionBody(source, "runNpxHook");
    expect(body).not.toContain("resolveAgenteraHome");
    expect(body).not.toContain("isRunnableAgenteraAppRoot");
    expect(body).not.toContain("scripts/agentera");
  });

  it("validateArtifactCandidate uses spawnSync with npx", () => {
    const body = extractFunctionBody(source, "validateArtifactCandidate");
    expect(body).toMatch(/spawnSync\s*\(\s*["']npx["']/);
  });

  it("buildCompactionContext uses execFileSync with npx", () => {
    const body = extractFunctionBody(source, "buildCompactionContext");
    expect(body).toMatch(/execFileSync\s*\(\s*["']npx["']/);
  });

  it("validateArtifactCandidate and buildCompactionContext do not gate on v2 managed scripts", () => {
    for (const handler of ["validateArtifactCandidate", "buildCompactionContext"] as const) {
      const body = extractFunctionBody(source, handler);
      expect(body).not.toContain("resolveAgenteraHome");
      expect(body).not.toContain("isRunnableAgenteraAppRoot");
    }
  });
});
