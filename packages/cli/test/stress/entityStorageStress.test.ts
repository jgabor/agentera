import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverEntities } from "../../src/state/entityStorage.js";
import { concurrentPublication } from "../helpers/entityPublicationRace.js";

const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-entity-stress-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  return root;
}

function assertInvariant(repetition: number, invariant: string, condition: boolean, observed: unknown): void {
  if (condition) return;
  const diagnostic = JSON.stringify(observed).slice(0, 1_000);
  throw new Error(`stale-lock race repetition ${repetition} violated invariant '${invariant}': ${diagnostic}`);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("entity publication stress", () => {
  it("names the repetition and violated invariant in bounded diagnostics", () => {
    expect(() => assertInvariant(17, "exactly one publisher", false, { publishers: 2 })).toThrow(
      "stale-lock race repetition 17 violated invariant 'exactly one publisher': {\"publishers\":2}",
    );
  });

  it("preserves atomicity and cleanup across 100 simultaneous stale-lock races", async () => {
    for (let repetition = 1; repetition <= 100; repetition += 1) {
      const root = project();
      const lockPath = path.join(root, ".agentera/.writer.lock");
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
        pid: 999_999_999,
        token: "seeded-dead-owner",
        created_at: "2020-01-01T00:00:00Z",
      }));

      const results = await concurrentPublication(root, `-stale-${repetition}`);
      const publishers = results.filter(({ published }) => published);
      const losers = results.filter(({ published }) => !published);
      assertInvariant(repetition, "exactly one publisher", publishers.length === 1, results);
      assertInvariant(
        repetition,
        "one explicit canonical duplicate-ID loser",
        losers.length === 1 && /entity ID 'zzzzzzzzzz' already exists.*owned by boundary/.test(losers[0]?.error ?? ""),
        results,
      );
      const entities = discoverEntities(root).entities.filter(({ id }) => id === "zzzzzzzzzz");
      assertInvariant(repetition, "exactly one canonical entity", entities.length === 1, entities);
      assertInvariant(repetition, "canonical writer lock cleanup", !fs.existsSync(lockPath), { lockPath });
      const residue = fs.readdirSync(path.join(root, ".agentera")).filter((name) => name.startsWith(".writer."));
      assertInvariant(repetition, "private writer residue cleanup", residue.length === 0, residue);
    }
  }, 180_000);
});
