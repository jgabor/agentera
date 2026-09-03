import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { cmdUpgrade } from "../../src/cli/commands/upgrade.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";
import { gitCommitArgs } from "../helpers/git.js";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "../../../..");
const FIXTURE = path.join(import.meta.dirname, "../upgrade/fixtures/v2-yaml-project");
const roots: string[] = [];

function todoId(index: number): string {
  let value = index;
  let suffix = "";
  for (let digit = 0; digit < 6; digit += 1) {
    suffix = String.fromCharCode(97 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return `item${suffix}`;
}

function managedV2(home: string): string {
  const appHome = path.join(home, "agentera");
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts/agentera"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(app, "skills/agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills/agentera/SKILL.md"), "x");
  fs.writeFileSync(path.join(app, "registry.json"), JSON.stringify({ skills: [{ name: "agentera", version: "2.7.0" }] }));
  fs.writeFileSync(path.join(app, BUNDLE_MARKER), JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "2.7.0" }));
  return appHome;
}

beforeEach(() => {
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = SOURCE_ROOT;
  setSuccessorAnnouncedOverrideForTests(true);
});

afterEach(() => {
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  setSuccessorAnnouncedOverrideForTests(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("entity cutover capacity", () => {
  it("reconciles every row in the exact 161-row fixture without duplicate projection or resurrection", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-cutover-capacity-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-cutover-capacity-home-"));
    roots.push(root, home);
    fs.cpSync(FIXTURE, root, { recursive: true });
    const rows = ["# TODO", "", "Unrelated project note.", "", "## ⇶ Critical"];
    const directory = path.join(root, ".agentera/entities/todo/todo_item");
    fs.mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 161; index += 1) {
      if (index === 2) rows.push("", "## Client-specific work");
      const id = todoId(index);
      const resolved = index % 3 === 1;
      rows.push(`${index % 2 ? "  " : ""}- [${resolved ? "x" : " "}] Task ${index}`);
      fs.writeFileSync(
        path.join(directory, `${id}.yaml`),
        YAML.stringify({
          id,
          artifact: "todo",
          record: {
            severity: "critical",
            status: "open",
            description: `Task ${index}`,
            readiness: {
              capability: "build",
              reason: "Preserve operational state",
              dependencies: [],
              blocked: null,
              gate: null,
              queue_rank: index + 1,
              order_reason: "Fixture order",
            },
          },
        }),
      );
    }
    rows.push("", "Unrelated closing note.", "");
    fs.writeFileSync(path.join(root, "TODO.md"), rows.join("\n"));
    const env = { ...process.env };
    for (const name of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[name];
    for (const args of [["init", "--quiet"], ["add", "."], gitCommitArgs("--quiet", "-m", "v2 state")]) {
      expect(spawnSync("git", args, { cwd: root, encoding: "utf8", env }).status).toBe(0);
    }
    const appHome = managedV2(home);
    const apply = () => cmdUpgrade({ installRoot: appHome, home, project: root, channel: "development", yes: true }, { out: () => {}, err: () => {} });

    expect(apply()).toBe(0);
    const markdown = fs.readFileSync(path.join(root, "TODO.md"), "utf8");
    expect([...markdown.matchAll(/\[id:([a-z]{10})\]/g)].map((match) => match[1])).toEqual(Array.from({ length: 161 }, (_, index) => todoId(index)));
    const records = fs
      .readdirSync(directory)
      .sort()
      .map((name) => YAML.parse(fs.readFileSync(path.join(directory, name), "utf8")).record);
    expect(records).toHaveLength(161);
    expect(records.filter((record) => record.status === "resolved")).toHaveLength(54);
    expect(new Set(records.map((record) => record.description)).size).toBe(161);
    expect(records.every((record) => record.readiness?.reason === "Preserve operational state")).toBe(true);
    expect(apply()).toBe(0);
    expect(fs.readFileSync(path.join(root, "TODO.md"), "utf8")).toBe(markdown);
    expect(fs.readdirSync(directory)).toHaveLength(161);
  }, 240_000);
});
