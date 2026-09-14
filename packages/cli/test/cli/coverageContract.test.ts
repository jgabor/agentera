import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "../../../..");
const skillRoot = path.join(root, "skills/agentera");
const document = fs.readFileSync(path.join(root, "docs/cli-coverage-contract.md"), "utf8");

function section(start: string, end: string): string {
  const from = document.indexOf(start);
  const to = document.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return document.slice(from, to);
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : [path.relative(skillRoot, file)];
  });
}

describe("single-file host CLI coverage contract", () => {
  it("maps the complete skill inventory to owner commands and acceptance evidence", () => {
    const inventory = section("## Coverage map:", "## Required referenced guidance");
    const mapped = [...inventory.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
    const artifacts = section("### Artifact files (12)", "### Capability files (48)");
    const artifactRows = [...artifacts.matchAll(/^\| `schemas\/artifacts\/([^`]+)\.yaml` \| (\w+) \| (.+) \| (E\d+(?:, E\d+)*) \|$/gm)];
    expect(artifactRows).toHaveLength(12);
    for (const row of artifactRows) {
      expect(row[1]).toBe(row[2]);
    }
    expect(mapped).toHaveLength(16);
    expect(inventory).toContain("agentera schema --artifact A --section S");

    const capabilities = [...inventory.matchAll(/^\| (\w+) \| `agentera route explain --topic triggers --capability (\w+)` \| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \|$/gm)];
    expect(capabilities).toHaveLength(12);
    for (const [, capability, triggerCapability, artifactsCommand, validationCommand, exitCommand] of capabilities) {
      expect(triggerCapability).toBe(capability);
      for (const [detail, command] of [
        ["artifacts", artifactsCommand],
        ["validation", validationCommand],
        ["exit", exitCommand],
      ]) {
        expect(command).toBe(`agentera prime --context ${capability} --detail ${detail}`);
      }
      for (const file of ["triggers", "artifacts", "validation", "exit"]) mapped.push(`capabilities/${capability}/schemas/${file}.yaml`);
    }
    expect(mapped).toHaveLength(64);
    expect(new Set(mapped).size).toBe(mapped.length);
    expect(mapped.sort()).toEqual(sourceFiles(skillRoot).sort());
    for (const row of inventory.split("\n").filter((line) => line.startsWith("| `"))) expect(row).toMatch(/\| E\d+(?:, E\d+)* \|$/);
    expect(inventory).toContain("triggers.yaml (E5) | artifacts.yaml (E4) | validation.yaml (E4, E7) | exit.yaml (E4)");
  });

  it("resolves referenced guidance and evidence without making tests a semantic authority", () => {
    const references = section("## Required referenced guidance", "## Reconciliation decisions");
    const capabilities = fs.readdirSync(path.join(skillRoot, "capabilities"));
    for (const row of references.split("\n").filter((line) => line.startsWith("| `"))) {
      const sources = row.slice(0, row.indexOf(" | ", 2));
      for (const [, source] of sources.matchAll(/`([^`]+)`/g)) {
        const file = source.split("#")[0];
        for (const expanded of file.includes("<name>") ? capabilities.map((name) => file.replace("<name>", name)) : [file]) {
          expect(fs.statSync(path.join(root, expanded)).isFile(), expanded).toBe(true);
        }
      }
      expect(row).toMatch(/\| E\d+(?:, E\d+)* \|$/);
    }
    const evidence = new Set([...document.matchAll(/^- \*\*(E\d+) —/gm)].map((match) => match[1]));
    expect(evidence.size).toBe(10);
    for (const [, id] of document.matchAll(/\b(E\d+)\b/g)) expect(evidence.has(id), id).toBe(true);
  });

  it("keeps full-plan review descriptions consistent with the zero-allowed check", () => {
    const artifact = YAML.parse(fs.readFileSync(path.join(skillRoot, "schemas/artifacts/plan.yaml"), "utf8"));
    const capability = YAML.parse(fs.readFileSync(path.join(skillRoot, "capabilities/plan/schemas/validation.yaml"), "utf8"));
    const rule = artifact.VALIDATION[3];
    expect(rule.id).toBe("PV3");
    expect(rule.description).toMatch(/nonnegative critic_issues counts/);
    expect(rule.description).toMatch(/Zero findings is valid after full-plan review/);
    expect(rule.checks.join(" ")).toMatch(/nonnegative counts; zero findings is valid after full-plan review/);
    expect(capability.VALIDATION[3].description).toMatch(/Zero findings is valid/);
    expect(rule.description).not.toMatch(/non[- ]?zero/i);
  });
});
