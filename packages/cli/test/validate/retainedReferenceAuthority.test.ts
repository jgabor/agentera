import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isRetainedReferenceSourceCheckout, validateRetainedReferenceAuthority } from "../../src/validate/retainedReferenceAuthority.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function fixture(): { root: string; authority: Record<string, any> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retained-reference-authority-"));
  roots.push(root);
  write(root, "packages/cli/package.json", JSON.stringify({ bin: { agentera: "dist/bin/agentera.js" } }));
  write(root, "packages/cli/src/current.ts", 'export function loadCurrent() { return fs.readFileSync("references/current.yaml"); }\n');
  write(root, "packages/cli/src/migration.ts", 'export function loadMigration() { return fs.readFileSync("references/adapters/migration.yaml"); }\n');
  write(root, "packages/cli/src/validator.ts", 'export function validateManifest() { return fs.readFileSync("references/meta/retained-reference-authority.yaml"); }\n');
  write(root, "packages/cli/src/bin/agentera.ts", ['import { loadCurrent } from "../current.js";', 'import { loadMigration } from "../migration.js";', 'import { validateManifest } from "../validator.js";', "loadCurrent();", "loadMigration();", "validateManifest();", ""].join("\n"));
  write(root, "references/current.yaml", "current: true\n");
  write(root, "references/adapters/migration.yaml", "migration: true\n");
  write(root, "references/runbook.md", ["# Runbook", "", "- Maintainer: Agentera CLI maintainers", "- Source checkout root: `.`", "- Working directory: `.`", "- Command: `node packages/cli/dist/bin/agentera.js check validate capability-contract`", ""].join("\n"));
  const authority = {
    schema_version: "agentera.retainedReferenceAuthority.v1",
    live_roots: ["references", "skills/agentera/references"],
    inventory: [
      {
        path: "references/current.yaml",
        classification: "current",
        production_owner: { module: "packages/cli/src/current.ts", symbol: "loadCurrent" },
        consumers: [
          {
            kind: "runtime",
            module: "packages/cli/src/current.ts",
            symbol: "loadCurrent",
            consumption: "loads",
          },
        ],
      },
      {
        path: "references/adapters/migration.yaml",
        classification: "migration-only",
        production_owner: { module: "packages/cli/src/migration.ts", symbol: "loadMigration" },
        consumers: [
          {
            kind: "runtime",
            module: "packages/cli/src/migration.ts",
            symbol: "loadMigration",
            consumption: "loads",
          },
        ],
      },
      {
        path: "references/runbook.md",
        classification: "runbook",
        maintainer: "Agentera CLI maintainers",
        source_checkout_root: ".",
        working_directory: ".",
        command: "node packages/cli/dist/bin/agentera.js check validate capability-contract",
      },
      {
        path: "references/meta/retained-reference-authority.yaml",
        classification: "current",
        production_owner: { module: "packages/cli/src/validator.ts", symbol: "validateManifest" },
        consumers: [
          {
            kind: "validator",
            module: "packages/cli/src/validator.ts",
            symbol: "validateManifest",
            consumption: "loads",
          },
        ],
      },
      { path: "references/cli/old.md", classification: "historical" },
      { path: "skills/agentera/references/deleted.md", classification: "delete" },
    ],
  };
  write(root, "references/meta/retained-reference-authority.yaml", YAML.stringify(authority));
  return { root, authority };
}

function rewrite(root: string, authority: Record<string, any>): void {
  write(root, "references/meta/retained-reference-authority.yaml", YAML.stringify(authority));
}

describe("retained reference authority", () => {
  it("passes a source checkout with current, migration-only, runbook, historical, and delete entries", () => {
    const { root } = fixture();
    expect(isRetainedReferenceSourceCheckout(root)).toBe(true);
    expect(validateRetainedReferenceAuthority(root)).toEqual([]);
  });

  it("analyzes reachable modules once per validation invocation", () => {
    const { root } = fixture();
    const entrypoint = path.join(root, "packages/cli/src/bin/agentera.ts");
    const readFileSync = vi.spyOn(fs, "readFileSync");

    expect(validateRetainedReferenceAuthority(root)).toEqual([]);
    expect(readFileSync.mock.calls.filter(([file]) => file === entrypoint)).toHaveLength(2);
  });

  it("rebuilds reachability analysis for each validation invocation", () => {
    const { root } = fixture();
    expect(validateRetainedReferenceAuthority(root)).toEqual([]);

    write(root, "packages/cli/src/bin/agentera.ts", "\n");
    expect(validateRetainedReferenceAuthority(root)).toContain("references/current.yaml: consumers[0].symbol is not reachable from a production CLI or package-script entrypoint");
  });

  it("rejects a current reference supported only by a test module", () => {
    const { root, authority } = fixture();
    authority.inventory[0].consumers[0].module = "packages/cli/test/current.test.ts";
    rewrite(root, authority);
    expect(validateRetainedReferenceAuthority(root)).toContain("references/current.yaml: consumers[0].module must name a contained production packages/cli src or scripts module");
  });

  it("rejects an emitted path and an unrelated read as consumption evidence", () => {
    const { root } = fixture();
    write(root, "packages/cli/src/current.ts", ["export function loadCurrent() {", '  console.log("references/current.yaml");', '  return fs.readFileSync("references/other.yaml");', "}", ""].join("\n"));
    expect(validateRetainedReferenceAuthority(root)).toContain("references/current.yaml: consumers[0] must read or parse the exact reference; unrelated reads and emitted strings do not count");
  });

  it("rejects reference literals outside the reader path argument", () => {
    const { root } = fixture();
    write(root, "packages/cli/src/current.ts", ["export function loadCurrent() {", '  return fs.readFileSync("references/other.yaml", ["references", "current.yaml"] as any);', "}", ""].join("\n"));
    expect(validateRetainedReferenceAuthority(root)).toContain("references/current.yaml: consumers[0] must read or parse the exact reference; unrelated reads and emitted strings do not count");
  });

  it("rejects a no-op loader consumer", () => {
    const { root, authority } = fixture();
    write(root, "packages/cli/src/validator.ts", "export function validateManifest() { return []; }\n");
    rewrite(root, authority);
    expect(validateRetainedReferenceAuthority(root)).toContain("references/meta/retained-reference-authority.yaml: consumers[0] must read or parse the exact reference; unrelated reads and emitted strings do not count");
  });

  it("rejects a validator-like symbol that only reads data under the removed validates mode", () => {
    const { root, authority } = fixture();
    write(root, "packages/cli/src/validator.ts", ["export function validateManifest() {", '  fs.readFileSync("references/meta/retained-reference-authority.yaml");', "  return [];", "}", ""].join("\n"));
    authority.inventory[3].consumers[0].consumption = "validates";
    rewrite(root, authority);
    expect(validateRetainedReferenceAuthority(root)).toContain("references/meta/retained-reference-authority.yaml: consumers[0].consumption must be loads");
  });

  it("rejects a dead production export", () => {
    const { root, authority } = fixture();
    write(root, "packages/cli/src/dead.ts", 'export function loadDead() { return fs.readFileSync("references/current.yaml"); }\n');
    authority.inventory[0].production_owner = {
      module: "packages/cli/src/dead.ts",
      symbol: "loadDead",
    };
    authority.inventory[0].consumers[0] = {
      kind: "runtime",
      module: "packages/cli/src/dead.ts",
      symbol: "loadDead",
      consumption: "loads",
    };
    rewrite(root, authority);
    expect(validateRetainedReferenceAuthority(root)).toContain("references/current.yaml: consumers[0].symbol is not reachable from a production CLI or package-script entrypoint");
  });

  it("rejects a dead export from an otherwise reachable production module", () => {
    const { root, authority } = fixture();
    write(root, "packages/cli/src/current.ts", ['export function loadCurrent() { return fs.readFileSync("references/current.yaml"); }', 'export function loadDead() { return fs.readFileSync("references/current.yaml"); }', ""].join("\n"));
    authority.inventory[0].production_owner = {
      module: "packages/cli/src/current.ts",
      symbol: "loadDead",
    };
    authority.inventory[0].consumers[0] = {
      kind: "runtime",
      module: "packages/cli/src/current.ts",
      symbol: "loadDead",
      consumption: "loads",
    };
    rewrite(root, authority);
    expect(validateRetainedReferenceAuthority(root)).toContain("references/current.yaml: consumers[0].symbol is not reachable from a production CLI or package-script entrypoint");
  });

  it("rejects traversal in a declared production module", () => {
    const { root, authority } = fixture();
    authority.inventory[0].consumers[0].module = "packages/cli/src/../test/current.ts";
    rewrite(root, authority);
    expect(validateRetainedReferenceAuthority(root)).toContain("references/current.yaml: consumers[0].module must name a contained production packages/cli src or scripts module");
  });

  it("rejects a symlinked production module", () => {
    const { root, authority } = fixture();
    fs.symlinkSync(path.join(root, "packages/cli/src/current.ts"), path.join(root, "packages/cli/src/current-link.ts"));
    authority.inventory[0].consumers[0].module = "packages/cli/src/current-link.ts";
    rewrite(root, authority);
    expect(validateRetainedReferenceAuthority(root)).toContain("references/current.yaml: consumers[0].module must be a contained regular production file, not a symlink");
  });

  it("rejects a migration-only path outside its allowed migration roots", () => {
    const { root, authority } = fixture();
    write(root, "references/analysis/migration.yaml", "migration: true\n");
    authority.inventory[1].path = "references/analysis/migration.yaml";
    rewrite(root, authority);
    expect(validateRetainedReferenceAuthority(root)).toContain("references/analysis/migration.yaml: migration-only references must remain in references/adapters or references/cli");
  });

  it("rejects a missing retained entry and an unlisted live reference", () => {
    const { root, authority } = fixture();
    fs.rmSync(path.join(root, "references/current.yaml"));
    write(root, "references/unlisted.yaml", "unlisted: true\n");
    rewrite(root, authority);
    const errors = validateRetainedReferenceAuthority(root);
    expect(errors).toContain("references/current.yaml: retained current reference is missing from live roots");
    expect(errors).toContain("references/unlisted.yaml: live reference is absent from the retained-reference inventory");
  });

  it("rejects a runbook without source-checkout context or a tracked command", () => {
    const { root, authority } = fixture();
    delete authority.inventory[2].source_checkout_root;
    authority.inventory[2].command = "npx agentera check validate capability-contract";
    rewrite(root, authority);
    const errors = validateRetainedReferenceAuthority(root);
    expect(errors).toContain("references/runbook.md: runbook source_checkout_root must be the source checkout root '.'");
    expect(errors).toContain("references/runbook.md: runbook command must use a tracked pnpm script or the local agentera bin");
  });

  it("rejects live historical and delete references", () => {
    const { root } = fixture();
    write(root, "references/cli/old.md", "historical\n");
    write(root, "skills/agentera/references/deleted.md", "delete\n");
    const errors = validateRetainedReferenceAuthority(root);
    expect(errors).toContain("references/cli/old.md: historical inventory entries must be absent from live roots");
    expect(errors).toContain("skills/agentera/references/deleted.md: delete inventory entries must be absent from live roots");
  });

  it("rejects a standalone bundle root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "retained-reference-bundle-"));
    roots.push(root);
    write(root, ".agentera-npx-bundle.json", "{}\n");
    write(root, "skills/agentera/SKILL.md", "# Agentera\n");
    write(root, "registry.json", "{}\n");
    expect(isRetainedReferenceSourceCheckout(root)).toBe(false);
    expect(validateRetainedReferenceAuthority(root)[0]).toContain("requires a source checkout");
  });
});
