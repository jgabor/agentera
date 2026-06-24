import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { cmdDoctor } from "../../src/cli/commands/doctor.js";
import {
  detectV2Coexistence,
  formatCoexistenceDoctorLines,
  formatNamingDivergenceLines,
  isV2ManagedInstallAtAppHome,
  loadCoexistenceProbeAuthority,
  resolveCoexistenceDoctorLines,
} from "../../src/upgrade/coexistenceProbe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const V2_APP_HOME_FIXTURE = path.join(__dirname, "../upgrade/fixtures/v2-app-home");

function platformDefaultAppHome(home: string): string {
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "agentera");
  }
  if (process.platform === "win32") {
    return path.join(home, "AppData", "Roaming", "agentera");
  }
  return path.join(home, ".local", "share", "agentera");
}

function captureDoctor(home: string): string {
  let out = "";
  const priorHome = process.env.HOME;
  const priorXdg = process.env.XDG_DATA_HOME;
  const priorAgenteraHome = process.env.AGENTERA_HOME;
  const priorBootstrap = process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  process.env.HOME = home;
  delete process.env.XDG_DATA_HOME;
  process.env.AGENTERA_HOME = REPO_ROOT;
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  try {
    const code = cmdDoctor(
      { format: "text", home },
      {
        out: (chunk) => {
          out += chunk;
        },
        err: () => {},
      },
    );
    expect([0, 1]).toContain(code);
    return out;
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = priorXdg;
    if (priorAgenteraHome === undefined) delete process.env.AGENTERA_HOME;
    else process.env.AGENTERA_HOME = priorAgenteraHome;
    if (priorBootstrap === undefined) delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
    else process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = priorBootstrap;
  }
}

describe("v2/v3 coexistence probe (v3 doctor)", () => {
  it("loads the shared warning contract from references/cli/coexistence-probe.yaml", () => {
    const contract = loadCoexistenceProbeAuthority(REPO_ROOT);
    const lines = formatCoexistenceDoctorLines(contract);
    expect(lines[0]).toBe("Coexistence");
    expect(lines[1]).toBe("v3 detected alongside v2; pick one line");
    expect(lines.slice(2, 5)).toEqual([
      "  - complete v3 migration",
      "  - uninstall v3",
      "  - stay on v2 explicitly",
    ]);
    // D70: naming-divergence dimension surfaces v3 English IDs vs v2 Swedish -era IDs.
    expect(lines[5]).toBe("  naming divergence:");
    expect(lines[6]).toBe(
      "    v3: status, vision, discuss, research, plan, build, optimize, audit, document, profile, design, orchestrate",
    );
    expect(lines[7]).toBe(
      "    v2: hej, visionera, resonera, inspirera, planera, realisera, optimera, inspektera, dokumentera, profilera, visualisera, orkestrera",
    );
  });

  it("renders the naming-divergence dimension from a well-formed contract", () => {
    const lines = formatNamingDivergenceLines({
      v3_canonical: ["status", "build"],
      v2_stable: ["hej", "realisera"],
    });
    expect(lines).toEqual([
      "  naming divergence:",
      "    v3: status, build",
      "    v2: hej, realisera",
    ]);
  });

  it("returns null when the naming-divergence dimension is missing or malformed", () => {
    expect(formatNamingDivergenceLines(undefined)).toBeNull();
    expect(formatNamingDivergenceLines(null)).toBeNull();
    expect(formatNamingDivergenceLines("nope")).toBeNull();
    expect(formatNamingDivergenceLines({ v3_canonical: ["status"] })).toBeNull();
    expect(formatNamingDivergenceLines({ v3_canonical: [], v2_stable: [] })).toBeNull();
  });

  it("detects a synthetic v2 managed app home under the platform default path", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coexistence-v2-"));
    const appHome = platformDefaultAppHome(home);
    fs.cpSync(V2_APP_HOME_FIXTURE, appHome, { recursive: true });
    expect(isV2ManagedInstallAtAppHome(appHome)).toBe(true);
    expect(detectV2Coexistence({ home, env: { HOME: home } }).length).toBeGreaterThan(0);
    expect(
      resolveCoexistenceDoctorLines({
        home,
        sourceRoot: REPO_ROOT,
        env: { HOME: home },
      }),
    ).not.toBeNull();
  });

  it("stays silent when the platform default app home has no v2 install", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coexistence-clean-"));
    expect(detectV2Coexistence({ home, env: { HOME: home } })).toEqual([]);
    expect(
      resolveCoexistenceDoctorLines({
        home,
        sourceRoot: REPO_ROOT,
        env: { HOME: home },
      }),
    ).toBeNull();
  });

  it("emits the coexistence warning when a v2 install is staged in the default app home", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coexistence-doctor-v2-"));
    const appHome = platformDefaultAppHome(home);
    fs.cpSync(V2_APP_HOME_FIXTURE, appHome, { recursive: true });
    const output = captureDoctor(home);
    expect(output).toContain("v3 detected alongside v2; pick one line");
    expect(output).toContain("  - complete v3 migration");
    expect(output).toContain("  - uninstall v3");
    expect(output).toContain("  - stay on v2 explicitly");
    // D70: naming-divergence dimension is emitted alongside the coexistence warning.
    expect(output).toContain("naming divergence");
    expect(output).toContain(
      "v3: status, vision, discuss, research, plan, build, optimize, audit, document, profile, design, orchestrate",
    );
    expect(output).toContain(
      "v2: hej, visionera, resonera, inspirera, planera, realisera, optimera, inspektera, dokumentera, profilera, visualisera, orkestrera",
    );
  });

  it("does not emit the coexistence warning without a v2 install", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coexistence-doctor-clean-"));
    const output = captureDoctor(home);
    expect(output).not.toContain("v3 detected alongside v2; pick one line");
  });
});
