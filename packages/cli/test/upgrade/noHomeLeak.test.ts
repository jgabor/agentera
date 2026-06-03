import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planRuntimeRewirePhase } from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { migrationCtx } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "no-home-leak-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function assertMigrationPathsStaySandboxed(home: string, items: { source?: string; target?: string }[]): void {
  const realHome = os.homedir();
  const repoPrefix = REPO_ROOT.endsWith(path.sep) ? REPO_ROOT : `${REPO_ROOT}${path.sep}`;

  for (const item of items) {
    const target = item.target ?? "";
    if (target) {
      expect(
        target.startsWith(home),
        `migration item.target must stay under sandbox home ${home}, got: ${target}`,
      ).toBe(true);
      if (target.startsWith(realHome) && !target.startsWith(home)) {
        expect.fail(`migration item.target must not use developer homedir ${realHome}, got: ${target}`);
      }
    }

    const source = item.source ?? "";
    if (!source) {
      continue;
    }
    const inSandboxHome = source.startsWith(home);
    const inRepo = source === REPO_ROOT || source.startsWith(repoPrefix);
    expect(
      inSandboxHome || inRepo,
      `migration item.source must be under sandbox home or REPO_ROOT, got: ${source}`,
    ).toBe(true);
  }
}

describe("runtime migration home leak guard", () => {
  it("plans opencode and runtime targets only under sandbox home", () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    const ctx = migrationCtx(path.join(home, "agentera"), path.join(home, "project"), home, REPO_ROOT);
    const phase = planRuntimeRewirePhase(ctx);
    assertMigrationPathsStaySandboxed(home, phase.items);
  });
});
