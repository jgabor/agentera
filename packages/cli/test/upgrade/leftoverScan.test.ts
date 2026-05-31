import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NPX_HOOK_VALIDATE,
  applyMigrationPhases,
  dryRunMigration,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { scanDirectoryForPythonLeftovers } from "./helpers/preservation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-leftover-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("leftoverScan", () => {
  it("reports no python managed references after runtime rewire", () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    const appHome = path.join(home, ".local/share/agentera");
    fs.cpSync(path.join(FIXTURES, "v2-app-home"), appHome, { recursive: true });
    const project = path.join(tmp, "project");
    fs.cpSync(path.join(FIXTURES, "v2-yaml-project"), project, { recursive: true });
    fs.cpSync(path.join(FIXTURES, "v2-runtime-python"), home, { recursive: true });

    const preview = dryRunMigration({ appHome, project, home });
    applyMigrationPhases({ appHome, project, home }, preview, ["runtime"]);

    expect(scanDirectoryForPythonLeftovers(path.join(home, ".codex"))).toEqual([]);
    expect(scanDirectoryForPythonLeftovers(path.join(project, ".cursor"))).toEqual([]);
    const codexHooks = fs.readFileSync(path.join(home, ".codex/hooks/codex-hooks.json"), "utf8");
    expect(codexHooks).toContain(NPX_HOOK_VALIDATE);
  });
});
