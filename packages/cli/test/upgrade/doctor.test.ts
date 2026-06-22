import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APP_MANUAL_REVIEW_NEEDED,
  APP_OUTDATED,
  APP_REPAIR_NEEDED,
  APP_UP_TO_DATE,
  appLifecycleApprovalPhrase,
  buildDoctorStatus,
  publicDoctorStatus,
} from "../../src/upgrade/doctor.js";
import { renderDoctorStatus } from "../../src/cli/commands/doctor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function managed(appHome: string, marker: string | null, hej = true): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "scripts", "agentera"),
    "#!/usr/bin/env python3\n" + (hej ? "sub.add_parser('hej')\n" : "pass\n"),
  );
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: "current" }] }),
  );
  if (marker !== null) {
    fs.writeFileSync(
      path.join(app, ".agentera-bundle.json"),
      JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: marker }),
    );
  }
}

const common = {
  sourceRoot: REPO_ROOT,
  home: "/tmp/doctor-home",
  project: "/tmp/doctor-proj",
  expectedVersion: "v9",
  probeCli: false,
};

describe("buildDoctorStatus", () => {
  it("reports up_to_date for a fresh managed bundle", () => {
    const appHome = path.join(tmp, "fresh");
    managed(appHome, "v9");
    const status = buildDoctorStatus(appHome, { rootSource: "explicit --install-root", ...common });
    expect(status.status).toBe(APP_UP_TO_DATE);
    expect(status.rootStatus).toBe("managed");
    expect(status.signals).toEqual([]);
    expect(status.dryRunCommand).toBeNull();
    expect(status.applyCommand).toBeNull();
    expect(status.schemaVersion).toBe("agentera.bundleStatus.v1");
  });

  it("uses plain-language repair wording for missing_bundle signals", () => {
    const appHome = path.join(tmp, "nope");
    const status = buildDoctorStatus(appHome, { rootSource: "default app home", ...common });
    const signal = status.signals.find((s: { kind?: string }) => s.kind === "missing_bundle");
    expect(signal?.message).toBe("Agentera is not installed in the normal directory yet");
    expect(JSON.stringify(status.signals)).not.toMatch(/bundle freshness|bundle refresh|app refresh required/);
  });

  it("pins missing_marker diagnostic copy to authority-approved repair wording", () => {
    const classifierSource = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/upgrade/doctorClassifier.ts"),
      "utf8",
    );
    expect(classifierSource).toContain('kind: "missing_marker"');
    expect(classifierSource).toContain('message: "Agentera app files need repair"');
  });

  it("reports outdated with a version_mismatch signal for a stale marker", () => {
    const appHome = path.join(tmp, "stale");
    managed(appHome, "old");
    const status = buildDoctorStatus(appHome, { rootSource: "explicit --install-root", ...common });
    expect(status.status).toBe(APP_OUTDATED);
    expect(status.signals.some((s: any) => s.kind === "version_mismatch")).toBe(true);
    expect(status.markerVersion).toBe("old");
    expect(status.dryRunCommand).toContain("npx -y agentera@latest");
    expect(status.dryRunCommand).toContain("upgrade");
    expect(status.applyCommand).toContain("--yes");
    expect(status.approval).toBe(appLifecycleApprovalPhrase(APP_OUTDATED, appHome));
    expect(status.approval).toContain("update");
    expect(status.approval).not.toContain("repair");
    const rendered = renderDoctorStatus(status);
    expect(rendered).toContain("Preview the update:");
    expect(rendered).not.toContain("Preview the repair:");
  });

  it("uses repair approval wording for repair_needed installs", () => {
    const appHome = path.join(tmp, "repair");
    fs.mkdirSync(path.join(appHome, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(appHome, ".agentera", "progress.yaml"), "cycles: []\n");
    const status = buildDoctorStatus(appHome, { rootSource: "explicit --install-root", ...common });
    expect(status.status).toBe(APP_REPAIR_NEEDED);
    expect(status.approval).toContain("repair");
    expect(status.approval).not.toContain("update");
    const rendered = renderDoctorStatus(status);
    expect(rendered).toContain("Preview the repair:");
  });

  it("reports user_data_only repair for an app home with only Agentera data", () => {
    const appHome = path.join(tmp, "userdata");
    fs.mkdirSync(path.join(appHome, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(appHome, ".agentera", "progress.yaml"), "cycles: []\n");
    const status = buildDoctorStatus(appHome, { rootSource: "explicit --install-root", ...common });
    expect(status.status).toBe(APP_REPAIR_NEEDED);
    expect(status.rootStatus).toBe("user_data_only");
    expect(status.signals.some((s: any) => s.kind === "user_data_only_app_home")).toBe(true);
  });

  it("reports missing_bundle for a missing default app home", () => {
    const appHome = path.join(tmp, "nope");
    const status = buildDoctorStatus(appHome, { rootSource: "default app home", ...common });
    expect(status.rootStatus).toBe("missing");
    expect(status.status).toBe(APP_REPAIR_NEEDED);
    expect(status.signals.some((s: any) => s.kind === "missing_bundle")).toBe(true);
  });

  it("blocks on a missing explicit app home", () => {
    const appHome = path.join(tmp, "nope2");
    const status = buildDoctorStatus(appHome, { rootSource: "explicit --install-root", ...common });
    expect(status.status).toBe(APP_MANUAL_REVIEW_NEEDED);
    expect(status.rootStatus).toBe("missing");
    expect(status.dryRunCommand).toBeNull();
    expect(status.signals.some((s: any) => s.kind === "invalid_install_root")).toBe(true);
  });

  it("emits cross_major_pending advisory and manual_review_needed for v2.7.9 app facing v3.0.0 CLI with successor unannounced", () => {
    const appHome = path.join(tmp, "v2-cross-major");
    managed(appHome, "2.7.9");
    const status = buildDoctorStatus(appHome, {
      rootSource: "explicit --install-root",
      sourceRoot: REPO_ROOT,
      home: path.join(tmp, "home"),
      project: path.join(tmp, "proj"),
      expectedVersion: "3.0.0",
      probeCli: false,
    });
    expect(status.status).toBe(APP_MANUAL_REVIEW_NEEDED);
    expect(status.crossMajorBoundary).toBe(false);
    expect(status.dryRunCommand).toBeNull();
    expect(status.applyCommand).toBeNull();
    const pending = status.signals.find((s: { kind?: string }) => s.kind === "cross_major_pending");
    expect(pending).toBeTruthy();
    expect(pending?.status).toBe(APP_MANUAL_REVIEW_NEEDED);
    expect(pending?.expected).toBe("3.0.0");
    expect(pending?.actual).toBe("2.7.9");
    expect(pending?.message).toContain("not announced");
    expect(pending?.message).not.toContain("--yes");
    expect(status.signals.some((s: { kind?: string }) => s.kind === "version_mismatch")).toBe(true);
  });

  it("does not emit cross_major_pending for a same-major stale bundle", () => {
    const appHome = path.join(tmp, "stale-same-major");
    managed(appHome, "old");
    const status = buildDoctorStatus(appHome, {
      rootSource: "explicit --install-root",
      ...common,
      expectedVersion: "v9",
    });
    expect(status.status).toBe(APP_OUTDATED);
    expect(status.signals.some((s: { kind?: string }) => s.kind === "cross_major_pending")).toBe(false);
    expect(status.signals.some((s: { kind?: string }) => s.kind === "version_mismatch")).toBe(true);
  });

  it("does not emit cross_major_pending when the v2 managed marker matches the v2 CLI version", () => {
    const appHome = path.join(tmp, "v2-match");
    managed(appHome, "2.7.9");
    const v2Source = path.join(tmp, "v2-cli-source");
    fs.mkdirSync(path.join(v2Source, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(v2Source, "skills", "agentera", "SKILL.md"), "x");
    fs.writeFileSync(
      path.join(v2Source, "registry.json"),
      JSON.stringify({ skills: [{ name: "agentera", version: "2.7.9" }] }),
    );
    const status = buildDoctorStatus(appHome, {
      rootSource: "explicit --install-root",
      sourceRoot: v2Source,
      home: path.join(tmp, "home"),
      project: path.join(tmp, "proj"),
      expectedVersion: "2.7.9",
      probeCli: false,
    });
    expect(status.status).toBe(APP_UP_TO_DATE);
    expect(status.signals.some((s: { kind?: string }) => s.kind === "cross_major_pending")).toBe(false);
    expect(status.signals.some((s: { kind?: string }) => s.kind === "version_mismatch")).toBe(false);
  });
});

describe("publicDoctorStatus", () => {
  it("strips installRoot and installRootSource", () => {
    const appHome = path.join(tmp, "fresh");
    managed(appHome, "v9");
    const status = buildDoctorStatus(appHome, { rootSource: "explicit --install-root", ...common });
    const pub = publicDoctorStatus(status);
    expect("installRoot" in pub).toBe(false);
    expect("installRootSource" in pub).toBe(false);
    expect(pub.appHome).toBe(status.appHome);
  });
});

function managedWithScript(
  appHome: string,
  marker: string | null,
  scriptBody: string,
  shebang: string | null,
): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  const content = shebang ? `${shebang}\n${scriptBody}` : scriptBody;
  fs.writeFileSync(path.join(app, "scripts", "agentera"), content);
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: "current" }] }),
  );
  if (marker !== null) {
    fs.writeFileSync(
      path.join(app, ".agentera-bundle.json"),
      JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: marker }),
    );
  }
}

describe("buildDoctorStatus shebang-aware retryCommand", () => {
  it("builds retryCommand with 'uv run' for a Python shebang managed script", () => {
    const appHome = path.join(tmp, "python-shebang");
    managedWithScript(
      appHome,
      "v9",
      "import argparse\ndef main():\n    pass\n",
      "#!/usr/bin/env python3",
    );
    const status = buildDoctorStatus(appHome, { rootSource: "explicit --install-root", ...common });
    expect(status.retryCommand).not.toBeNull();
    expect(status.retryCommand).toMatch(/^uv run /);
    expect(status.retryCommand).toContain("scripts/agentera");
    expect(status.retryCommand).toMatch(/prime$/);
    expect(status.retryCommand).not.toMatch(/^node /);
  });

  it("builds retryCommand with 'node' for a Node shebang managed script", () => {
    const appHome = path.join(tmp, "node-shebang");
    managedWithScript(
      appHome,
      "v9",
      "import fs from 'node:fs';\nexport const main = () => {};\n",
      "#!/usr/bin/env node",
    );
    const status = buildDoctorStatus(appHome, { rootSource: "explicit --install-root", ...common });
    expect(status.retryCommand).not.toBeNull();
    expect(status.retryCommand).toMatch(/^node /);
    expect(status.retryCommand).toContain("scripts/agentera");
    expect(status.retryCommand).toMatch(/prime$/);
  });

  it("sets retryCommand to null for a managed script with no shebang", () => {
    const appHome = path.join(tmp, "no-shebang");
    managedWithScript(
      appHome,
      "v9",
      "console.log('no shebang');\n",
      null,
    );
    const status = buildDoctorStatus(appHome, { rootSource: "explicit --install-root", ...common });
    expect(status.retryCommand).toBeNull();
  });

  it("emits a runtime_mismatch signal for a managed script with mismatched shebang and content (probeCli: true)", () => {
    const appHome = path.join(tmp, "mismatch");
    managedWithScript(
      appHome,
      "v9",
      "import argparse\ndef main():\n    pass\n",
      "#!/usr/bin/env node",
    );
    const status = buildDoctorStatus(appHome, {
      rootSource: "explicit --install-root",
      ...common,
      probeCli: true,
    });
    const mismatch = status.signals.find((s: { kind?: string }) => s.kind === "runtime_mismatch");
    expect(mismatch).toBeTruthy();
    expect(mismatch?.status).toBe("repair_needed");
    expect(mismatch?.message).toMatch(/shebang/i);
    expect(mismatch?.message).toMatch(/content/i);
  });

  it("does not emit a runtime_mismatch signal for a mismatched shebang when probeCli is false", () => {
    const appHome = path.join(tmp, "mismatch-no-probe");
    managedWithScript(
      appHome,
      "v9",
      "import argparse\ndef main():\n    pass\n",
      "#!/usr/bin/env node",
    );
    const status = buildDoctorStatus(appHome, {
      rootSource: "explicit --install-root",
      ...common,
      probeCli: false,
    });
    expect(status.signals.some((s: { kind?: string }) => s.kind === "runtime_mismatch")).toBe(false);
  });

  it("does not emit a runtime_mismatch signal for a script whose shebang matches its content", () => {
    const appHome = path.join(tmp, "matched");
    managedWithScript(
      appHome,
      "v9",
      "import argparse\ndef main():\n    pass\n",
      "#!/usr/bin/env python3",
    );
    const status = buildDoctorStatus(appHome, {
      rootSource: "explicit --install-root",
      ...common,
      probeCli: true,
    });
    expect(status.signals.some((s: { kind?: string }) => s.kind === "runtime_mismatch")).toBe(false);
  });
});
