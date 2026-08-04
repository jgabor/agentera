import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CAPABILITY_NAMES } from "../../src/cli/capabilityContext/types.js";
import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { buildPrimeCapabilityContextPayload } from "../../src/cli/capabilityContext.js";
import { runProfileGroundingCommand } from "../../src/cli/commands/profileGrounding.js";
import { cmdPrime, collectOrientationState } from "../../src/cli/commands/prime.js";
import {
  acquireProfile,
  readProfileSourceSafely,
  type ProfileValidityClass,
} from "../../src/cli/profileAcquisition.js";
import { personalProfileGroundingContract } from "../../src/registries/glossaryEntryContract.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCHEMAS_DIR = path.join(REPO_ROOT, "skills/agentera/schemas/artifacts");
const PRIVACY_TRAP = "PRIVATE_PROFILE_BYTES_MUST_NOT_ESCAPE";
const VALIDITY_CLASSES: ProfileValidityClass[] = [
  "absent", "valid", "malformed", "ambiguous", "unreadable", "unsafe", "oversized", "invalid_utf8",
];

const EMPTY_GLOSSARY = [
  "<!-- agentera:personal-glossary:start -->",
  "## Glossary",
  "",
  "```json",
  '{"schema_version":"agentera.personalGlossarySection.v1","as_of":"2026-07-30","confidence_basis":{},"entries":[]}',
  "```",
  "<!-- agentera:personal-glossary:end -->",
].join("\n");

let root: string;
let project: string;
let profileDir: string;
let profilePath: string;
let previousCwd: string;
let previousEnv: Record<string, string | undefined>;

function env(): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: path.join(root, "home"),
    AGENTERA_HOME: path.join(root, "app-home"),
    AGENTERA_PROFILE_DIR: profileDir,
    AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
    AGENTERA_PROFILE_MAX_AGE_DAYS: "7",
  };
}

function captureReport(): { rc: number; out: string; err: string; payload: Record<string, any> } {
  let out = "";
  let err = "";
  const rc = runProfileGroundingCommand(["--format", "json"], {
    out: (text) => (out += text),
    err: (text) => (err += text),
  });
  return { rc, out, err, payload: JSON.parse(out) };
}

function capturePrime(context?: string): { rc: number; out: string; err: string; payload: Record<string, any> } {
  let out = "";
  let err = "";
  const rc = cmdPrime({ command: "prime", context, format: "json" }, {
    out: (text) => (out += text),
    err: (text) => (err += text),
  });
  return { rc, out, err, payload: JSON.parse(out) };
}

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function writeScenario(validityClass: ProfileValidityClass): (() => void) | undefined {
  if (validityClass === "absent") return;
  if (validityClass === "valid") fs.writeFileSync(profilePath, `# Profile\n\n${EMPTY_GLOSSARY}\n`);
  if (validityClass === "malformed") fs.writeFileSync(profilePath, `# Profile\n${PRIVACY_TRAP}\n<!-- agentera:personal-glossary:start -->\n`);
  if (validityClass === "ambiguous") fs.writeFileSync(profilePath, `# Profile\n${PRIVACY_TRAP}\n## Glossary\n`);
  if (validityClass === "unsafe") fs.mkdirSync(profilePath);
  if (validityClass === "oversized") fs.writeFileSync(profilePath, Buffer.alloc(65_537, 65));
  if (validityClass === "invalid_utf8") fs.writeFileSync(profilePath, Buffer.from([0xc3, 0x28]));
  if (validityClass === "unreadable") {
    fs.writeFileSync(profilePath, PRIVACY_TRAP);
    const original = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(target) === profilePath) throw Object.assign(new Error(PRIVACY_TRAP), { code: "EACCES" });
      return original(target, flags, mode);
    }) as typeof fs.openSync);
    return () => vi.restoreAllMocks();
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-acquisition-"));
  project = path.join(root, "project");
  profileDir = path.join(root, `profile-${PRIVACY_TRAP}`);
  profilePath = path.join(profileDir, "PROFILE.md");
  fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  previousCwd = process.cwd();
  previousEnv = {
    HOME: process.env.HOME,
    AGENTERA_HOME: process.env.AGENTERA_HOME,
    AGENTERA_PROFILE_DIR: process.env.AGENTERA_PROFILE_DIR,
    AGENTERA_BOOTSTRAP_SOURCE_ROOT: process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT,
    AGENTERA_PROFILE_MAX_AGE_DAYS: process.env.AGENTERA_PROFILE_MAX_AGE_DAYS,
  };
  Object.assign(process.env, env());
  process.chdir(project);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(previousCwd);
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("shared bounded profile acquisition", () => {
  it("keeps the contract vocabulary executable and singular", () => {
    const contract = personalProfileGroundingContract();
    expect(contract.validityClasses).toEqual(VALIDITY_CLASSES);
    expect(contract.validityStatuses).toEqual(["absent", "valid", "repair_needed"]);
    expect(contract.freshnessStates).toEqual(["current", "stale", "unknown"]);
  });

  it.each(["\n", "\r\n"])("accepts a valid owned Glossary with %j line endings and strips it", (newline) => {
    fs.writeFileSync(profilePath, `# Profile${newline}${newline}${EMPTY_GLOSSARY.replaceAll("\n", newline)}${newline}AFTER${newline}`);
    const acquired = acquireProfile(SCHEMAS_DIR, env());
    expect(acquired.validity).toEqual({ status: "valid", class: "valid", recovery: null });
    expect(acquired.groundingContent).toBe(`# Profile${newline}${newline}${newline}AFTER${newline}`);
    expect(acquired.groundingContent).not.toContain("Glossary");
  });

  it.each([false, true])("preserves a UTF-8 BOM outside the owned Glossary (owned=%s)", (owned) => {
    const suffix = owned ? `\n${EMPTY_GLOSSARY}\nAFTER\n` : "\nAFTER\n";
    fs.writeFileSync(profilePath, Buffer.from(`\uFEFF# Profile${suffix}`, "utf8"));
    const acquired = acquireProfile(SCHEMAS_DIR, env());
    const expected = owned ? "\uFEFF# Profile\n\nAFTER\n" : "\uFEFF# Profile\nAFTER\n";
    expect(acquired.validity.class).toBe("valid");
    expect(acquired.groundingContent).toBe(expected);
    expect(Buffer.from(acquired.groundingContent!, "utf8")[0]).toBe(0xef);
    expect(acquired.groundingContent).not.toContain("Glossary");
    const report = captureReport();
    expect(report.rc).toBe(0);
    expect(report.payload.content).toBe(expected);
    expect(Buffer.from(report.payload.content, "utf8")[0]).toBe(0xef);
  });

  it("separates current, stale, and unknown freshness from valid structure", () => {
    for (const [days, state] of [[1, "current"], [10, "stale"]] as const) {
      fs.writeFileSync(profilePath, `# Profile\n<!-- Generated: ${isoDaysAgo(days)} | Data: x -->\n`);
      const acquired = acquireProfile(SCHEMAS_DIR, env());
      expect(acquired.validity).toEqual({ status: "valid", class: "valid", recovery: null });
      expect(acquired.freshness).toMatchObject({ state, days_since_generated: days, stale_threshold_days: 7 });
    }
    fs.writeFileSync(profilePath, "# Profile\n");
    expect(acquireProfile(SCHEMAS_DIR, env()).freshness.state).toBe("unknown");
  });

  it("accepts exactly 65,536 bytes and rejects one byte over", () => {
    fs.writeFileSync(profilePath, Buffer.alloc(65_536, 65));
    expect(acquireProfile(SCHEMAS_DIR, env()).validity.class).toBe("valid");
    fs.writeFileSync(profilePath, Buffer.alloc(65_537, 65));
    expect(acquireProfile(SCHEMAS_DIR, env()).validity).toMatchObject({ status: "repair_needed", class: "oversized" });
  });

  it("keeps fallback reads safe and rejects final symlinks, non-files, and changed sources", () => {
    fs.writeFileSync(profilePath, "stable");
    expect(readProfileSourceSafely(profilePath, 65_536, { noFollowFlag: 0 }).status).toBe("ok");
    fs.rmSync(profilePath);
    const target = path.join(root, PRIVACY_TRAP);
    fs.writeFileSync(target, "# external\n");
    try {
      fs.symlinkSync(target, profilePath);
      expect(readProfileSourceSafely(profilePath, 65_536).status).toBe("unsafe");
      fs.rmSync(profilePath);
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
    }
    fs.mkdirSync(profilePath);
    expect(readProfileSourceSafely(profilePath, 65_536).status).toBe("unsafe");
    fs.rmSync(profilePath, { recursive: true });
    fs.writeFileSync(profilePath, "before");
    expect(readProfileSourceSafely(profilePath, 65_536, {
      afterRead: () => fs.writeFileSync(profilePath, "after!"),
    }).status).toBe("unsafe");
    expect(readProfileSourceSafely(profilePath, 65_536, {
      noFollowFlag: 0,
      afterPathSnapshot: () => {
        fs.rmSync(profilePath);
        fs.writeFileSync(profilePath, "replacement");
      },
    }).status).toBe("unsafe");
  });

  it("accepts a stable profile beneath a symlinked parent and rejects parent retarget races", () => {
    const first = path.join(root, "parent-first");
    const second = path.join(root, "parent-second");
    const linked = path.join(root, "parent-link");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, "PROFILE.md"), "first");
    fs.writeFileSync(path.join(second, "PROFILE.md"), "second");
    try {
      fs.symlinkSync(first, linked, "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(String((error as NodeJS.ErrnoException).code))) return;
      throw error;
    }
    const linkedProfile = path.join(linked, "PROFILE.md");
    expect(readProfileSourceSafely(linkedProfile, 65_536, { noFollowFlag: 0 }).status).toBe("ok");
    expect(readProfileSourceSafely(linkedProfile, 65_536, {
      noFollowFlag: 0,
      afterPathSnapshot: () => {
        fs.rmSync(linked);
        fs.symlinkSync(second, linked, "dir");
      },
    }).status).toBe("unsafe");
  });

  it.each(VALIDITY_CLASSES)("keeps profile validity out of bounded Prime startup for %s", (validityClass) => {
    const cleanup = writeScenario(validityClass);
    try {
      const state = collectOrientationState({ projectRoot: project, home: path.join(root, "home"), env: env() });
      const report = captureReport();
      const bare = capturePrime();
      const status = capturePrime("status");
      expect(report.payload.validity).toEqual(state.profile_dict.validity);
      expect(bare.rc).toBe(0);
      expect(status.rc).toBe(0);
      expect(bare.payload.profile).toBeUndefined();
      expect(status.payload.capability_context.context.status_context.profile).toBeUndefined();
      expect(state.profile_dict.validity.class).toBe(validityClass);
      expect(state.profile_dict.status).not.toBe("loaded");
      expect(report.rc === 0).toBe(validityClass === "valid");
      if (validityClass === "valid") {
        expect(report.payload.content).toContain("# Profile");
        expect(report.payload.content).not.toContain("Glossary");
      } else {
        expect(report.payload.content).toBeNull();
        expect(report.payload.recovery).toBe(report.payload.validity.recovery);
        expect(report.payload.freshness.state).toBe("unknown");
      }
      for (const capability of CAPABILITY_NAMES) {
        const payload = buildPrimeCapabilityContextPayload(state, capability);
        expect(payload.capability_context.profile).toBeUndefined();
        expect(payload.capability_context.startup.availability).toEqual(expect.arrayContaining([
          expect.objectContaining({ family: "profile", availability: "deferred", detail_command: "npx -y agentera@next report profile-grounding --format json" }),
        ]));
        expect(JSON.stringify(payload)).not.toContain(PRIVACY_TRAP);
      }
      for (const output of [report.out, report.err, bare.out, bare.err, status.out, status.err, JSON.stringify(state.profile_dict)]) {
        expect(output).not.toContain(PRIVACY_TRAP);
        expect(output).not.toContain(profilePath);
      }
    } finally {
      cleanup?.();
    }
  });

  it("never exposes the resolved path through prime startup", () => {
    fs.writeFileSync(profilePath, "# Profile\n");
    for (const capability of CAPABILITY_NAMES) {
      const prime = capturePrime(capability);
      expect(prime.rc).toBe(0);
      const served = prime.payload.capability_context;
      expect(JSON.stringify(served)).not.toContain(profilePath);
      expect(served.profile).toBeUndefined();
    }
  });

  it("serves only the current Status validity and freshness vocabulary", () => {
    const served = CAPABILITY_INSTRUCTIONS.status;
    expect(served).toContain("`valid`, `absent`, or `repair_needed`");
    expect(served).toContain("Freshness is separate");
    expect(served).toContain("MUST NOT receive refresh advice");
    expect(served).not.toMatch(/`?loaded`?\s*(?:\||or)\s*`?not found`?/i);
  });
});
