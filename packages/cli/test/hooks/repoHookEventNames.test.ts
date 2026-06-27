import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

const CLAUDE_PASCAL_EVENTS = new Set(["SessionStart", "Stop", "PostToolUse"]);
const CODEX_PASCAL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
const CURSOR_CAMEL_EVENTS = new Set(["sessionStart", "sessionEnd", "preToolUse", "postToolUse"]);
const COPILOT_CAMEL_EVENTS = new Set(["sessionStart", "sessionEnd", "preToolUse", "postToolUse"]);

/** PascalCase keys used by Claude Code and Codex — must not appear in Cursor/Copilot hook configs. */
const PASCAL_EVENT_KEYS = new Set([
  "SessionStart",
  "Stop",
  "PostToolUse",
  "PreToolUse",
  "UserPromptSubmit",
  "SubagentStop",
  "PermissionRequest",
]);

/** camelCase keys used by Cursor and Copilot — must not appear in Claude/Codex hook object keys. */
const CAMEL_EVENT_KEYS = new Set([
  "sessionStart",
  "sessionEnd",
  "preToolUse",
  "postToolUse",
  "userPromptSubmitted",
  "errorOccurred",
]);

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
}

function hookObjectKeys(relativePath: string): string[] {
  const parsed = readJson(relativePath) as { hooks?: Record<string, unknown> };
  return Object.keys(parsed.hooks ?? {});
}

function assertNoCrossRuntimeKeys(
  relativePath: string,
  allowed: Set<string>,
  forbidden: Set<string>,
): void {
  const keys = hookObjectKeys(relativePath);
  expect(keys.sort()).toEqual([...allowed].sort());
  for (const key of keys) {
    expect(forbidden.has(key), `${relativePath} must not use cross-runtime event key ${key}`).toBe(
      false,
    );
  }
}

describe("repo hook event names per runtime (B5 task 5, defect #41)", () => {
  it("hooks/hooks.json targets Claude Code with PascalCase SessionStart, Stop, PostToolUse", () => {
    const parsed = readJson("hooks/hooks.json") as { description?: string };
    expect(parsed.description ?? "").toMatch(/Claude Code/i);
    assertNoCrossRuntimeKeys("hooks/hooks.json", CLAUDE_PASCAL_EVENTS, CAMEL_EVENT_KEYS);
  });

  it.each(["hooks/codex-hooks.json", "hooks/codex-plugin-hooks.json"])(
    "%s targets Codex with PascalCase PreToolUse and PostToolUse",
    (relativePath) => {
      const parsed = readJson(relativePath) as { description?: string };
      expect(parsed.description ?? "").toMatch(/Codex/i);
      assertNoCrossRuntimeKeys(relativePath, CODEX_PASCAL_EVENTS, CAMEL_EVENT_KEYS);
    },
  );

  it(".cursor/hooks.json targets Cursor IDE with camelCase sessionStart, sessionEnd, preToolUse, postToolUse", () => {
    const parsed = readJson(".cursor/hooks.json") as { description?: string };
    expect(parsed.description ?? "").toMatch(/Cursor/i);
    assertNoCrossRuntimeKeys(".cursor/hooks.json", CURSOR_CAMEL_EVENTS, PASCAL_EVENT_KEYS);
  });

  it.each([
    "sessionStart",
    "sessionEnd",
    "preToolUse",
    "postToolUse",
  ] as const)(".github/hooks/%s.json targets GitHub Copilot CLI with camelCase name field", (event) => {
    const relativePath = `.github/hooks/${event}.json`;
    const parsed = readJson(relativePath) as { description?: string; name?: string };
    expect(parsed.description ?? "").toMatch(/Copilot/i);
    expect(parsed.name).toBe(event);
    expect(COPILOT_CAMEL_EVENTS.has(parsed.name ?? "")).toBe(true);
    expect(PASCAL_EVENT_KEYS.has(parsed.name ?? "")).toBe(false);
  });
});

describe("OpenCode plugin hook boundary (B5 task 5, defect #41)", () => {
  const pluginPath = path.join(REPO_ROOT, ".opencode/plugins/agentera.js");
  const source = fs.readFileSync(pluginPath, "utf8");

  it("uses OpenCode tool.execute.before and tool.execute.after events, not hooks/hooks.json", () => {
    expect(source).toContain('"tool.execute.before"');
    expect(source).toContain('"tool.execute.after"');
    expect(source).not.toContain("hooks/hooks.json");
    expect(source).not.toMatch(/SessionStart|sessionStart/);
  });

  it("documents the OpenCode-native hook surface in the file header", () => {
    expect(source).toMatch(/tool\.execute\.before/);
    expect(source).toMatch(/tool\.execute\.after/);
    expect(source).not.toContain("hooks.json");
  });
});
