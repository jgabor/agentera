import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { main } from "../../src/cli/dispatch.js";
import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { readProfileSignals } from "../../src/analytics/profileSignals.js";
import { readCurrentGeneration } from "../../src/analytics/extractCorpus/evidenceTiers.js";
import { personalGlossaryCandidateProjectionPath } from "../../src/analytics/personalGlossaryCandidateProjection.js";
import { parseExtractArgs } from "../../src/analytics/extractCorpus/cli.js";
import { runCoverageAudit } from "../../src/analytics/extractCorpus/coverageAudit.js";
import * as core from "../../src/analytics/extractCorpus/core.js";
import * as sqlite from "../../src/analytics/extractCorpus/sqliteSessions.js";

const repo = path.resolve(import.meta.dirname, "../../../..");
let root: string, project: string, profile: string, sessions: string, previousCwd: string;
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-profile-journey-"));
  project = path.join(root, "selected-project");
  profile = path.join(root, "profile");
  sessions = path.join(root, "codex");
  write(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  write(path.join(project, "AGENTS.md"), "# Rules\nPrefer small changes with focused tests.\n");
  write(path.join(project, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node test.js" } }));
  write(path.join(profile, "PROFILE.md"), "# Decision Profile: Fixture\n\n## Tensions\n\nRetain the original tension in the backup.\n");
  write(
    path.join(sessions, "session.jsonl"),
    [
      {
        timestamp: "2026-09-22T10:00:00Z",
        type: "session_meta",
        payload: { id: "fixture-session", cwd: project },
      },
      {
        timestamp: "2026-09-22T10:01:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Use focused tests before making broad changes." }],
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  write(path.join(root, "unselected-opencode.db"), "never open this unselected history store");
  vi.stubEnv("HOME", root);
  vi.stubEnv("XDG_DATA_HOME", path.join(root, "data"));
  vi.stubEnv("AGENTERA_HOME", path.join(root, "app"));
  vi.stubEnv("AGENTERA_PROFILE_DIR", profile);
  vi.stubEnv("PROFILERA_PROFILE_DIR", profile);
  vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", repo);
  previousCwd = process.cwd();
  process.chdir(project);
});
afterEach(() => {
  process.chdir(previousCwd);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
function run(args: string[], expected = 0): any {
  let out = "",
    err = "";
  const code = main(["node", "agentera", ...args], {
    out: (text) => (out += text),
    err: (text) => (err += text),
  });
  expect(code, out + err).toBe(expected);
  return JSON.parse(out);
}
function selection() {
  return [
    "--project-root",
    project,
    "--codex-sessions-dir",
    sessions,
    "--opencode-conversations-dir",
    path.join(root, "unselected-opencode.db"),
    "--copilot-conversations-dir",
    path.join(root, "absent-copilot"),
    "--cursor-projects-dir",
    path.join(root, "absent-cursor"),
    "--cursor-chats-dir",
    path.join(root, "absent-cursor-chats"),
    "--no-opencode",
    "--no-copilot",
    "--no-cursor",
    "--accept-coverage-gap",
  ];
}
const refresh = (extra: string[], code = 0) => run(["report", "refresh", "--format", "json", ...selection(), ...extra], code);

it("serves the complete same-run consent and replacement contract without changing glossary admission", () => {
  const parts: string[] = [];
  let args = ["prime", "--context", "profile", "--detail", "instructions", "--section", "instructions", "--limit", "20"];
  for (;;) {
    const result = run(args);
    parts.push(...result.items.map((part: { content: string }) => part.content));
    if (!result.next_command) break;
    args = (result.next_command.match(/'[^']*'|\S+/g) ?? []).slice(3).map((word: string) => (word.startsWith("'") ? word.slice(1, -1) : word));
  }
  const body = parts.join("");
  expect(body).toBe(CAPABILITY_INSTRUCTIONS.profile);
  expect(body).toContain("continue Steps 2–4 in this invocation without a restart handoff");
  expect(body).toContain("No or silence is not acquisition or replacement approval");
  expect(body).toContain("Changed sources or destinations require fresh approval");
  expect(body).toContain("including accumulated tensions");
  expect(body).toContain("Never overwrite that retained copy with the new base");
  expect(body).toContain("Reuse a valid completed tier for synthesis even if projection failed");
  expect(body).toContain("authenticated local-host review disposition flow");
  expect(body).not.toMatch(/outside this Full run|then start a new Full run|do not refresh during Full mode|using all session data/);
});

it("does not open skipped history for timestamp coverage while retaining selected-source coverage", () => {
  const readJsonl = vi.spyOn(core, "iterJsonl");
  const openSqlite = vi.spyOn(sqlite, "openSqlite");
  const args = parseExtractArgs(selection());
  const selected = runCoverageAudit(args);
  expect(selected.runtimes.find((entry) => entry.runtime === "codex")).toMatchObject({
    selected: true,
    earliest_session: "2026-09-22T10:00:00Z",
  });
  expect(readJsonl).toHaveBeenCalled();
  expect(openSqlite).not.toHaveBeenCalled();
  readJsonl.mockClear();
  const skipped = runCoverageAudit({ ...args, noCodex: true });
  expect(skipped.runtimes.find((entry) => entry.runtime === "codex")).toMatchObject({
    available: true,
    selected: false,
    earliest_session: null,
    latest_session: null,
  });
  expect(skipped.runtimes.find((entry) => entry.runtime === "opencode")).toMatchObject({
    available: true,
    selected: false,
    earliest_session: null,
  });
  expect(readJsonl).not.toHaveBeenCalled();
  expect(openSqlite).not.toHaveBeenCalled();
});

it("exposes generation metadata only through the explicit read-only input command", () => {
  const original = fs.readFileSync(path.join(profile, "PROFILE.md"));
  const inputs = run(["report", "profile-inputs"]);
  expect(inputs).toMatchObject({
    schemaVersion: "agentera.profileInputs.v1",
    profile: { path: path.join(profile, "PROFILE.md"), validity: { status: "valid" } },
    bounded_signals: { state: "missing" },
    privacy: { local_history_read: false, profile_content_emitted: false, writes: false },
  });
  expect(JSON.stringify(inputs)).not.toContain("Retain the original tension");
  expect(JSON.stringify(run(["prime", "--context", "profile"]))).not.toContain(profile);
  run(["report", "profile-inputs", "--consent", "local-history"], 2);
  expect(fs.readFileSync(path.join(profile, "PROFILE.md"))).toEqual(original);
  expect(fs.existsSync(path.join(profile, "intermediate"))).toBe(false);
  expect(run(["report", "explain", "--operation", "profile-inputs", "--section", "usage"]).items[0].content.schemaVersion).toBe(inputs.schemaVersion);
});

it("refreshes only the selected synthetic sources after consent and reads valid completed evidence without acquiring again", () => {
  const oldProfile = fs.readFileSync(path.join(profile, "PROFILE.md"));
  const source = fs.readFileSync(path.join(sessions, "session.jsonl"));
  expect(refresh([], 2).privacy.local_history_read).toBe(false);
  expect(refresh(["--dry-run"]).privacy.tier_write).toBe(false);
  expect(readCurrentGeneration(path.join(profile, "intermediate/tiers"))).toBeNull();
  const result = refresh(["--consent", "local-history"]);
  expect(result).toMatchObject({
    status: "pass",
    evidence: { status: "published" },
    projection: { status: "published" },
    privacy: { historical_imports: [], local_history_write: false },
  });
  const inputs = readProfileSignals(result.tier_path);
  // Deliberately excluded runtimes retain the existing incomplete-coverage caveat.
  expect(inputs.state).toBe("incomplete");
  expect(inputs.sufficiency.sufficient).toBe(true);
  expect(inputs.profile_signal_count).toBeGreaterThan(0);
  expect(inputs.signals.every((signal) => signal.runtime === "codex" || signal.runtime === "filesystem")).toBe(true);
  const generation = readCurrentGeneration(inputs.tiers_dir)!.manifest.generation;
  expect(readProfileSignals(result.tier_path)).toEqual(inputs);
  expect(readCurrentGeneration(inputs.tiers_dir)!.manifest.generation).toBe(generation);
  expect(fs.readFileSync(path.join(profile, "PROFILE.md"))).toEqual(oldProfile);
  expect(fs.readFileSync(path.join(sessions, "session.jsonl"))).toEqual(source);
});

it("retains valid completed evidence and the old profile when projection publication fails", () => {
  fs.mkdirSync(personalGlossaryCandidateProjectionPath(), { recursive: true });
  const oldProfile = fs.readFileSync(path.join(profile, "PROFILE.md"));
  const result = refresh(["--consent", "local-history"], 1);
  expect(result).toMatchObject({
    status: "fail",
    evidence: { status: "published" },
    projection: { status: "failed" },
  });
  const inputs = readProfileSignals(result.tier_path);
  expect(inputs.state).toBe("incomplete");
  expect(inputs.sufficiency.sufficient).toBe(true);
  expect(readCurrentGeneration(inputs.tiers_dir)!.manifest.generation).toBe(result.evidence.generation);
  expect(fs.readFileSync(path.join(profile, "PROFILE.md"))).toEqual(oldProfile);
});
