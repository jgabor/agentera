import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import {
  applyMigrationPhases,
  dryRunMigration,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { loadProtocol, validateProtocolSelf } from "../../src/validate/capability.js";
import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";
import { migrationCtx, sandboxMigrationEnv } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const PROTOCOL_PATH = path.join(REPO_ROOT, "skills", "agentera", "protocol.yaml");

const V2_SWEDISH_VERBS = [
  "hej",
  "visionera",
  "resonera",
  "inspirera",
  "planera",
  "realisera",
  "optimera",
  "inspektera",
  "dokumentera",
  "profilera",
  "visualisera",
  "orkestrera",
] as const;

const ENGLISH_TO_SWEDISH_CAPABILITY: Record<string, string> = {
  status: "hej",
  vision: "visionera",
  discuss: "resonera",
  research: "inspirera",
  plan: "planera",
  build: "realisera",
  optimize: "optimera",
  audit: "inspektera",
  document: "dokumentera",
  profile: "profilera",
  design: "visualisera",
  orchestrate: "orkestrera",
};

const ENGLISH_TO_SWEDISH_PHASE: Record<string, string> = {
  envision: "visionera",
  deliberate: "resonera",
  plan: "planera",
  build: "realisera",
  audit: "inspektera",
};

type ProtocolDict = Record<string, unknown>;

let tmp: string;
let home: string;

function copyFixture(name: string, dest: string): string {
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

function collectSkillGlyphCapabilities(protocol: ProtocolDict): string[] {
  const group = protocol.SKILL_GLYPHS;
  if (!group || typeof group !== "object") return [];
  return Object.entries(group as Record<string, unknown>)
    .filter(([key]) => /^\d+$/.test(key))
    .map(([, entry]) => {
      if (entry && typeof entry === "object" && "capability" in entry) {
        return String((entry as Record<string, unknown>).capability);
      }
      return null;
    })
    .filter((value): value is string => value !== null);
}

function collectPhaseLabels(protocol: ProtocolDict): string[] {
  const group = protocol.PHASES;
  if (!group || typeof group !== "object") return [];
  const labels: string[] = [];
  for (const [key, entry] of Object.entries(group as Record<string, unknown>)) {
    if (!/^\d+$/.test(key) || !entry || typeof entry !== "object") continue;
    const phaseEntry = entry as Record<string, unknown>;
    if ("value" in phaseEntry) labels.push(String(phaseEntry.value));
    if (Array.isArray(phaseEntry.capabilities)) {
      for (const capability of phaseEntry.capabilities) labels.push(String(capability));
    }
  }
  return labels;
}

function assertNoSwedishEraVerbs(labels: readonly string[]): void {
  for (const label of labels) {
    expect(V2_SWEDISH_VERBS).not.toContain(label);
    for (const verb of V2_SWEDISH_VERBS) {
      expect(new RegExp(`\\b${verb}\\b`).test(label)).toBe(false);
    }
  }
}

function seedV2SkillMd(appBundleRoot: string): void {
  const skillPath = path.join(appBundleRoot, "skills", "agentera", "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(
    skillPath,
    [
      "---",
      "name: agentera",
      "capabilities:",
      "  - planera",
      "  - inspektera",
      "---",
      "",
      "# hej",
      "",
      "Route /agentera planera to the planera capability.",
      "",
    ].join("\n"),
    "utf8",
  );
}

function seedV2ProtocolYaml(appBundleRoot: string): void {
  const protocolPath = path.join(appBundleRoot, "skills", "agentera", "protocol.yaml");
  fs.mkdirSync(path.dirname(protocolPath), { recursive: true });
  const protocol = YAML.parse(fs.readFileSync(PROTOCOL_PATH, "utf8")) as ProtocolDict;
  const glyphs = protocol.SKILL_GLYPHS as Record<string, { capability?: string }>;
  for (const entry of Object.values(glyphs)) {
    if (entry?.capability && ENGLISH_TO_SWEDISH_CAPABILITY[entry.capability]) {
      entry.capability = ENGLISH_TO_SWEDISH_CAPABILITY[entry.capability];
    }
  }
  const phases = protocol.PHASES as Record<
    string,
    { value?: string; capabilities?: string[]; valid_successors?: string[] }
  >;
  for (const entry of Object.values(phases)) {
    if (entry?.value && ENGLISH_TO_SWEDISH_PHASE[entry.value]) {
      entry.value = ENGLISH_TO_SWEDISH_PHASE[entry.value];
    }
    if (entry?.capabilities) {
      entry.capabilities = entry.capabilities.map(
        (capability) => ENGLISH_TO_SWEDISH_CAPABILITY[capability] ?? capability,
      );
    }
    if (entry?.valid_successors) {
      entry.valid_successors = entry.valid_successors.map(
        (successor) => ENGLISH_TO_SWEDISH_PHASE[successor] ?? successor,
      );
    }
  }
  fs.writeFileSync(protocolPath, YAML.stringify(protocol));
}

function seedProgressPhase(project: string, phase: string): void {
  fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".agentera", "progress.yaml"),
    YAML.stringify({
      cycles: [{ number: 1, timestamp: "2026-06-27", type: "build", phase }],
    }),
  );
}

function capturePrime(
  env: Record<string, string>,
  opts: { context?: string } = {},
): Record<string, unknown> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  let out = "";
  try {
    const rc = cmdPrime(
      { command: "prime", format: "json", context: opts.context },
      { out: (chunk: string) => { out += chunk; }, err: () => {} },
    );
    expect(rc).toBe(0);
    return JSON.parse(out) as Record<string, unknown>;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeAll(() => {
  const result = spawnSync("pnpm", ["-C", "packages/cli", "build"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`pre-test cli build failed: ${result.stderr ?? result.stdout}`);
  }
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "installed-protocol-english-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
  setSuccessorAnnouncedOverrideForTests(true);
});

afterEach(() => {
  setSuccessorAnnouncedOverrideForTests(null);
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.HOME;
  delete process.env.AGENTERA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("repo v3 protocol.yaml English SKILL_GLYPHS/PHASES (#28)", () => {
  it("uses English capability and phase labels with zero Swedish -era verbs", () => {
    const protocol = loadProtocol(PROTOCOL_PATH);
    assertNoSwedishEraVerbs(collectSkillGlyphCapabilities(protocol));
    assertNoSwedishEraVerbs(collectPhaseLabels(protocol));
    expect(collectSkillGlyphCapabilities(protocol)).toContain("build");
    expect(collectPhaseLabels(protocol)).toContain("build");
    expect(collectPhaseLabels(protocol)).toContain("envision");
  });
});

describe("installed protocol.yaml after app-content refresh (#28)", () => {
  it("matches repo v3 protocol.yaml and resolves English glyph/phase metadata for prime", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "apply"));
    const project = copyFixture("v2-yaml-project", path.join(tmp, "project-apply"));
    seedV2SkillMd(path.join(appHome, "app"));
    seedV2ProtocolYaml(path.join(appHome, "app"));
    seedProgressPhase(project, "build");

    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const preview = dryRunMigration(ctx);
    applyMigrationPhases(ctx, preview);

    const installedProtocol = path.join(appHome, "skills", "agentera", "protocol.yaml");
    expect(fs.existsSync(installedProtocol)).toBe(true);
    expect(fs.readFileSync(installedProtocol, "utf8")).toBe(fs.readFileSync(PROTOCOL_PATH, "utf8"));

    const protocol = loadProtocol(installedProtocol);
    assertNoSwedishEraVerbs(collectSkillGlyphCapabilities(protocol));
    assertNoSwedishEraVerbs(collectPhaseLabels(protocol));
    expect(validateProtocolSelf(installedProtocol)).toEqual([]);

    const appEnv = {
      ...sandboxMigrationEnv(home, appHome),
      AGENTERA_HOME: appHome,
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: appHome,
    };
    const prevCwd = process.cwd();
    process.chdir(project);
    try {
      const payload = capturePrime(appEnv);
      const progress = payload.progress as Record<string, unknown>;
      const latest = progress.latest as Record<string, unknown>;
      expect(latest.phase).toBe("build");

      const buildPayload = capturePrime(appEnv, { context: "build" });
      const capabilityContext = buildPayload.capability_context as Record<string, unknown>;
      expect(capabilityContext.capability).toBe("build");
      for (const verb of V2_SWEDISH_VERBS) {
        expect(String(capabilityContext.capability ?? "")).not.toContain(verb);
      }
    } finally {
      process.chdir(prevCwd);
    }
  });
});
