import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

import { loadArtifactRegistry } from "../../src/registries/artifactRegistry.js";
import {
  applyMigrationPhases,
  dryRunMigration,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";
import { migrationCtx } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const REPO_ROOT = path.resolve(__dirname, "../../../..");

const SWEDISH_CAPABILITY_VERBS = [
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

const ENGLISH_CAPABILITY_NAMES = [
  "status",
  "vision",
  "discuss",
  "research",
  "plan",
  "build",
  "optimize",
  "audit",
  "document",
  "profile",
  "design",
  "orchestrate",
] as const;

/** v3 BUDGET pins that differ from common v2 bleed-through (defect #12). */
const V3_BUDGET_LIMITS: Record<string, number | null> = {
  decisions: 1000,
};

const PRODUCER_CONSUMER_KEY = /^(?:producer|producers|consumer|consumers)$/i;

let tmp: string;
let home: string;

function copyFixture(name: string, dest: string): string {
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
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

function walkYamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".yaml")) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function asStringList(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return [String(value).trim()].filter(Boolean);
}

function swedishProducerConsumerHits(values: string[]): string[] {
  const swedish = new Set<string>(SWEDISH_CAPABILITY_VERBS);
  return values.filter((value) => swedish.has(value));
}

function collectProducerConsumerFieldViolations(
  value: unknown,
  relPath: string,
  keyPath: string,
): string[] {
  const errors: string[] = [];
  if (value === null || typeof value !== "object") {
    return errors;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      errors.push(...collectProducerConsumerFieldViolations(item, relPath, `${keyPath}[${index}]`));
    });
    return errors;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = keyPath ? `${keyPath}.${key}` : key;
    if (PRODUCER_CONSUMER_KEY.test(key)) {
      const hits = swedishProducerConsumerHits(asStringList(child));
      for (const hit of hits) {
        errors.push(`${relPath}: ${childPath} uses Swedish capability verb '${hit}'`);
      }
    }
    errors.push(...collectProducerConsumerFieldViolations(child, relPath, childPath));
  }
  return errors;
}

function assertCapabilitySchemaDirsEnglish(skillsRoot: string): void {
  const capabilitiesDir = path.join(skillsRoot, "agentera", "capabilities");
  const swedish = new Set<string>(SWEDISH_CAPABILITY_VERBS);
  const english = new Set<string>(ENGLISH_CAPABILITY_NAMES);
  for (const name of fs.readdirSync(capabilitiesDir)) {
    const full = path.join(capabilitiesDir, name);
    if (!fs.statSync(full).isDirectory()) {
      continue;
    }
    expect(swedish.has(name), `${name} capability directory must not use a Swedish-era verb`).toBe(
      false,
    );
    expect(english.has(name), `${name} capability directory must use an English canonical name`).toBe(
      true,
    );
  }
}

function assertCapabilitySchemasFreeOfSwedishProducerConsumer(skillsRoot: string): string[] {
  const schemasRoot = path.join(skillsRoot, "agentera", "capabilities");
  const errors: string[] = [];
  for (const file of walkYamlFiles(schemasRoot)) {
    const rel = path.relative(skillsRoot, file);
    const data = YAML.parse(fs.readFileSync(file, "utf8"));
    errors.push(...collectProducerConsumerFieldViolations(data, rel, ""));
  }
  return errors;
}

function assertArtifactSchemasEnglishAndV3Limits(skillsRoot: string): string[] {
  const artifactDir = path.join(skillsRoot, "agentera", "schemas", "artifacts");
  const errors: string[] = [];
  for (const file of walkYamlFiles(artifactDir)) {
    const rel = path.relative(skillsRoot, file);
    const data = YAML.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    errors.push(...collectProducerConsumerFieldViolations(data, rel, ""));

    const meta = data.meta as Record<string, unknown> | undefined;
    if (!meta) {
      continue;
    }
    const artifactId = String(meta.name ?? path.basename(file, ".yaml"));
    const expectedLimit = V3_BUDGET_LIMITS[artifactId];
    if (expectedLimit === undefined) {
      continue;
    }
    const budget = data.BUDGET as Record<string, Record<string, unknown>> | undefined;
    const perEntry = budget
      ? Object.values(budget).find((entry) => entry?.scope === "per_decision_entry")
      : undefined;
    const maxWords = perEntry?.max_words;
    if (maxWords !== expectedLimit) {
      errors.push(
        `${rel}: BUDGET per_decision_entry max_words expected v3 value ${expectedLimit}, got ${String(maxWords)}`,
      );
    }
  }
  return errors;
}

function assertInstalledArtifactSchemas(root: string): void {
  const skillsRoot = path.join(root, "skills");
  assertCapabilitySchemaDirsEnglish(skillsRoot);
  expect(assertCapabilitySchemasFreeOfSwedishProducerConsumer(skillsRoot)).toEqual([]);
  expect(assertArtifactSchemasEnglishAndV3Limits(skillsRoot)).toEqual([]);

  const records = loadArtifactRegistry(
    path.join(skillsRoot, "agentera", "schemas", "artifacts"),
    path.join(root, "references", "artifacts", "artifact-registry-interface-model.yaml"),
  );
  const swedish = new Set<string>(SWEDISH_CAPABILITY_VERBS);
  for (const record of records.values()) {
    for (const producer of record.producers) {
      expect(swedish.has(producer), `ArtifactRecord producer '${producer}' must be English`).toBe(
        false,
      );
    }
    for (const consumer of record.consumers) {
      if (consumer === "all_skills") {
        continue;
      }
      expect(swedish.has(consumer), `ArtifactRecord consumer '${consumer}' must be English`).toBe(
        false,
      );
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "installed-artifact-schemas-"));
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

describe("installed artifact schemas (B6-4 / defect #12)", () => {
  it("repo source declares English producer/consumer and v3 validation limits", () => {
    assertInstalledArtifactSchemas(REPO_ROOT);
  });

  it("upgrade refresh copies English producer/consumer schemas into the app home", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "apply"));
    const project = copyFixture("v2-yaml-project", path.join(tmp, "project"));
    seedV2SkillMd(path.join(appHome, "app"));

    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const preview = dryRunMigration(ctx);
    applyMigrationPhases(ctx, preview);

    assertInstalledArtifactSchemas(appHome);

    const sourceSchemas = path.join(REPO_ROOT, "skills", "agentera", "capabilities");
    const installedSchemas = path.join(appHome, "skills", "agentera", "capabilities");
    for (const sourceFile of walkYamlFiles(sourceSchemas)) {
      const rel = path.relative(sourceSchemas, sourceFile);
      const installedFile = path.join(installedSchemas, rel);
      expect(fs.existsSync(installedFile), `missing installed capability schema ${rel}`).toBe(true);
      expect(fs.readFileSync(installedFile, "utf8")).toBe(fs.readFileSync(sourceFile, "utf8"));
    }
  });
});
