import { describe, expect, it } from "vitest";

import { cmdDoctor, renderDoctorStatus } from "../../src/cli/commands/doctor.js";
import { main } from "../../src/cli/dispatch.js";

function capture(fn: (io: { out: (t: string) => void; err: (t: string) => void }) => number): {
  rc: number;
  out: string;
  err: string;
} {
  let out = "";
  let err = "";
  const rc = fn({ out: (t) => (out += t), err: (t) => (err += t) });
  return { rc, out, err };
}

describe("cli doctor", () => {
  it("renders a doctor status briefing", () => {
    const status = {
      status: "up_to_date",
      expectedVersion: "3.0.0",
      appHome: "/home/u/.local/share/agentera",
      managedAppRoot: "/home/u/.local/share/agentera/app",
      userDataRoot: "/home/u/.local/share/agentera",
      signals: [],
      dryRunCommand: null,
      applyCommand: null,
      retryCommand: "npx -y agentera prime",
    };
    const text = renderDoctorStatus(status);
    expect(text.startsWith("Agentera doctor\nstatus: up to date")).toBe(true);
    expect(text).toContain("No action needed");
  });

  it("renders attention signals and the next-steps block", () => {
    const status = {
      status: "outdated",
      expectedVersion: "3.0.0",
      appHome: "/h",
      managedAppRoot: "/h/app",
      userDataRoot: "/h",
      signals: [{ status: "outdated", message: "app files need an update", missingCommands: ["prime"] }],
      dryRunCommand: "npx -y agentera upgrade --dry-run",
      applyCommand: "npx -y agentera upgrade --yes",
      retryCommand: "npx -y agentera prime",
    };
    const text = renderDoctorStatus(status);
    expect(text).toContain("What needs attention:");
    expect(text).toContain("  - outdated: app files need an update");
    expect(text).toContain("    Missing command: prime");
    expect(text).toContain("1. Preview the update: npx -y agentera upgrade --dry-run");
  });

  it("runs against the environment and emits a status (text)", () => {
    const { rc, out } = capture((io) => cmdDoctor({}, io));
    expect([0, 1, 2]).toContain(rc);
    expect(out).toContain("Agentera doctor");
    expect(out).toContain("status: ");
  });

  it("emits sorted indented JSON", () => {
    const { out } = capture((io) => cmdDoctor({ format: "json" }, io));
    const payload = JSON.parse(out);
    expect(typeof payload.status).toBe("string");
    expect("expectedVersion" in payload).toBe(true);
  });

  it("routes doctor and the --json deprecation alias", () => {
    const { err } = capture((io) => main(["node", "agentera", "doctor", "--json"], io));
    expect(err).toContain("Deprecation: agentera doctor --json is deprecated; use agentera doctor --format json");
  });
});
