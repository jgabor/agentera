import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  REPO_STATE_FIXTURE_NAMES,
  cleanupFixtureProject,
  repoStateFixturePath,
  useFixtureProject,
} from "./useFixtureProject.js";

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) cleanupFixtureProject(cleanups.pop()!);
});

describe("useFixtureProject", () => {
  it("lists every documented variant on disk", () => {
    for (const name of REPO_STATE_FIXTURE_NAMES) {
      const root = repoStateFixturePath(name);
      expect(fs.existsSync(path.join(root, "TODO.md"))).toBe(true);
      expect(fs.existsSync(path.join(root, ".agentera", "plan.yaml"))).toBe(true);
    }
  });

  it("returns independent temp copies and cleans them up", () => {
    const a = useFixtureProject("ok");
    const b = useFixtureProject("ok");
    cleanups.push(a, b);
    expect(a).not.toBe(b);

    const marker = path.join(a, "TODO.md");
    fs.writeFileSync(marker, "# mutated\n");
    expect(fs.readFileSync(path.join(b, "TODO.md"), "utf8")).toContain("Open item one");
    expect(fs.readFileSync(marker, "utf8")).toBe("# mutated\n");
    cleanupFixtureProject(a);
    expect(fs.existsSync(a)).toBe(false);
  });
});
