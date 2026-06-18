import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkCompaction } from "../../src/hooks/compaction/index.js";
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

  it("returns independent temp copies for the same variant", () => {
    const a = useFixtureProject("ok");
    const b = useFixtureProject("ok");
    cleanups.push(a, b);
    expect(a).not.toBe(b);

    const marker = path.join(a, "TODO.md");
    fs.writeFileSync(marker, "# mutated\n");
    expect(fs.readFileSync(path.join(b, "TODO.md"), "utf8")).toContain("Open item one");
    expect(fs.readFileSync(marker, "utf8")).toBe("# mutated\n");
  });

  it("todo-resolved-over-limit exceeds the full-entry cap by 6", () => {
    const root = useFixtureProject("todo-resolved-over-limit");
    cleanups.push(root);
    const op = checkCompaction(root).find((o) => o.status.artifact === "todo#Resolved");
    expect(op?.action).toBe("over_limit");
    expect(op?.status.over_limit_count).toBe(6);
  });

  it("progress-at-cap is within limits at 50 total entries", () => {
    const root = useFixtureProject("progress-at-cap");
    cleanups.push(root);
    const op = checkCompaction(root).find((o) => o.status.artifact === "progress");
    expect(op?.status.total_count).toBe(50);
    expect(op?.action).toBe("ok");
  });

  it("progress-over-limit triggers compaction over_limit", () => {
    const root = useFixtureProject("progress-over-limit");
    cleanups.push(root);
    const op = checkCompaction(root).find((o) => o.status.artifact === "progress");
    expect(op?.action).toBe("over_limit");
    expect(op?.status.total_count).toBe(55);
  });

  it("invalid-progress-yaml classifies progress as error", () => {
    const root = useFixtureProject("invalid-progress-yaml");
    cleanups.push(root);
    const op = checkCompaction(root).find((o) => o.status.artifact === "progress");
    expect(op?.action).toBe("error");
  });
});
