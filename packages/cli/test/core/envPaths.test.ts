import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultCorpusPath,
  defaultUsageDir,
} from "../../src/analytics/usageStats.js";
import { agenteraDataHome, startupBenchmarkDir } from "../../src/cli/capabilityContext/benchmark.js";
import { statsCorpusPath } from "../../src/cli/commands/report.js";
import { resolveProfileDirOverride, resolveXdgDataHome } from "../../src/core/envPaths.js";
import { defaultProfileDir } from "../../src/analytics/extractCorpus/core.js";
import { resolveInstallRoot } from "../../src/upgrade/appModel.js";

describe("resolveProfileDirOverride", () => {
  it("prefers AGENTERA_PROFILE_DIR over PROFILERA_PROFILE_DIR", () => {
    expect(
      resolveProfileDirOverride({
        AGENTERA_PROFILE_DIR: "/v3/profile",
        PROFILERA_PROFILE_DIR: "/legacy/profile",
      }),
    ).toBe("/v3/profile");
  });

  it("falls back to PROFILERA_PROFILE_DIR when AGENTERA_PROFILE_DIR is unset", () => {
    expect(resolveProfileDirOverride({ PROFILERA_PROFILE_DIR: "/legacy/profile" })).toBe(
      "/legacy/profile",
    );
  });
});

describe("resolveXdgDataHome", () => {
  it("expands tilde paths the same way installRoot.ts does", () => {
    const home = "/tmp/home";
    expect(resolveXdgDataHome({ XDG_DATA_HOME: "~/.local/share" }, home)).toBe(
      path.join(os.homedir(), ".local", "share"),
    );
  });

  it("aligns corpus and usage resolvers on the same expanded directory", () => {
    const env = { XDG_DATA_HOME: "~/.local/share", HOME: "/tmp/home" };
    const xdgBase = path.join(os.homedir(), ".local", "share", "agentera");
    expect(defaultUsageDir(env, "linux")).toBe(xdgBase);
    expect(defaultCorpusPath(env, "linux")).toBe(path.join(xdgBase, "intermediate", "corpus.json"));
    expect(statsCorpusPath(env, "linux")).toBe(path.join(xdgBase, "intermediate", "corpus.json"));
    expect(defaultProfileDir(env, "linux")).toBe(xdgBase);
  });
});

describe("startupBenchmarkDir", () => {
  it("uses caller-provided env instead of process.env", () => {
    const env = { AGENTERA_HOME: "/tmp/custom-home" };
    expect(startupBenchmarkDir(env)).toBe(
      path.join("/tmp/custom-home", "benchmarks", "startup-state"),
    );
  });

  it("honors PROFILERA_PROFILE_DIR when AGENTERA_PROFILE_DIR is unset", () => {
    const env = { PROFILERA_PROFILE_DIR: "/legacy/profile" };
    expect(agenteraDataHome(env)).toBe("/legacy/profile");
    expect(startupBenchmarkDir(env)).toBe(
      path.join("/legacy/profile", "benchmarks", "startup-state"),
    );
  });
});

describe("resolveInstallRoot profile layer", () => {
  it("uses AGENTERA_PROFILE_DIR before platform default when AGENTERA_HOME is unset", () => {
    const home = "/tmp/home";
    const sourceRoot = "/tmp/source";
    expect(
      resolveInstallRoot(null, sourceRoot, home, {
        AGENTERA_PROFILE_DIR: "/tmp/profile-layer",
      }),
    ).toBe(path.resolve("/tmp/profile-layer"));
  });

  it("falls back to PROFILERA_PROFILE_DIR for install-root resolution", () => {
    const home = "/tmp/home";
    const sourceRoot = "/tmp/source";
    expect(
      resolveInstallRoot(null, sourceRoot, home, {
        PROFILERA_PROFILE_DIR: "/tmp/legacy-profile",
      }),
    ).toBe(path.resolve("/tmp/legacy-profile"));
  });
});
