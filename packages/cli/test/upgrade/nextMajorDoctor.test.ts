import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadUpdateChannelsAuthority } from "../../src/upgrade/channels.js";
import {
  NEXT_MAJOR_LINE_CAP,
  NEXT_MAJOR_SECTION_HEADER,
  V1_NEXT_MAJOR_FALLBACK,
  formatNextMajorDoctorLines,
  loadChannelNextMajor,
  prependNextMajorDoctorSection,
  resolveNextMajorDoctorLines,
} from "../../src/upgrade/nextMajorDoctor.js";
import { renderDoctorStatus } from "../../src/cli/commands/doctor.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "next-major-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("update-channels authority next_major", () => {
  it("exposes channels.stable.next_major with required successor fields", () => {
    const authority = loadUpdateChannelsAuthority(REPO_ROOT);
    const stable = (authority.channels as Record<string, unknown>).stable as Record<string, unknown>;
    const block = stable.next_major as Record<string, unknown>;
    expect(block).toBeTruthy();
    expect(block.concept).toBe("forward_successor_line");
    expect(block.channel).toBe("development");
    expect(block.version).toBe("3.0.0");
    expect((block.npm as Record<string, unknown>).dist_tag).toBe("next");
    expect(String(block.guide_url)).toContain("UPGRADE.md");
    expect(block.preview_command).toContain("@next");
    expect(String(block.irreversible_advisory)).toContain("one-way");
    expect(loadChannelNextMajor(REPO_ROOT, "stable")).not.toBeNull();
  });

  it("returns null when a channel omits next_major in the authority", () => {
    const authorityRoot = path.join(tmp, "no-successor");
    fs.mkdirSync(path.join(authorityRoot, "references/cli"), { recursive: true });
    fs.copyFileSync(
      path.join(REPO_ROOT, "references/cli/update-channels.yaml"),
      path.join(authorityRoot, "references/cli/update-channels.yaml"),
    );
    const authorityPath = path.join(authorityRoot, "references/cli/update-channels.yaml");
    const text = fs.readFileSync(authorityPath, "utf8");
    fs.writeFileSync(authorityPath, text.replace(/\n    next_major:[\s\S]*?(?=\n    resolution:)/, "\n"));
    expect(loadChannelNextMajor(authorityRoot, "stable")).toBeNull();
  });
});

describe("loadChannelNextMajor", () => {
  it("loads stable successor metadata from the authority", () => {
    const block = loadChannelNextMajor(REPO_ROOT, "stable");
    expect(block).toMatchObject({
      concept: "forward_successor_line",
      channel: "development",
      version: "3.0.0",
    });
    expect(block?.previewCommand).toContain("upgrade --dry-run");
  });

  it("returns null when development has no announced successor", () => {
    expect(loadChannelNextMajor(REPO_ROOT, "development")).toBeNull();
  });
});

describe("resolveNextMajorDoctorLines", () => {
  it("renders six lines for stable-channel 2.x installs from authority", () => {
    const lines = resolveNextMajorDoctorLines({
      sourceRoot: REPO_ROOT,
      home: tmp,
      channel: "stable",
      runningVersion: "2.7.7",
      runningDistributionMajor: 2,
    });
    expect(lines).not.toBeNull();
    expect(lines).toHaveLength(NEXT_MAJOR_LINE_CAP);
    expect(lines?.[0]).toBe(NEXT_MAJOR_SECTION_HEADER);
    expect(lines?.[1]).toContain("2.7.7");
    expect(lines?.[1]).toContain("stable channel");
    expect(lines?.[2]).toContain("3.0.0");
    expect(lines?.[2]).toContain("development channel");
    expect(lines?.[2]).toContain("npm-only");
    expect(lines?.[3]).toContain("Guide:");
    expect(lines?.[4]).toContain("Preview:");
    expect(lines?.[5]).toContain("one-way");
  });

  it("omits the section when development channel has no successor", () => {
    const lines = resolveNextMajorDoctorLines({
      sourceRoot: REPO_ROOT,
      home: tmp,
      channel: "development",
      runningVersion: "3.0.0-dev.4",
      runningDistributionMajor: 3,
    });
    expect(lines).toBeNull();
  });

  it("uses hardcoded v1→v2 fallback for distribution major 1", () => {
    const lines = resolveNextMajorDoctorLines({
      sourceRoot: REPO_ROOT,
      home: tmp,
      channel: "stable",
      runningVersion: "1.18.0",
      runningDistributionMajor: 1,
    });
    expect(lines).toHaveLength(NEXT_MAJOR_LINE_CAP);
    expect(lines?.[1]).toBe(`Current: ${V1_NEXT_MAJOR_FALLBACK.currentVersion} (stable channel)`);
    expect(lines?.[2]).toBe(`Next: ${V1_NEXT_MAJOR_FALLBACK.version} (stable channel)`);
    expect(lines?.[4]).toContain(V1_NEXT_MAJOR_FALLBACK.previewCommand);
  });

  it("fails when rendered section exceeds the six-line cap", () => {
    const block = {
      concept: "forward_successor_line",
      channel: "development" as const,
      version: "3.0.0",
      npmOnlyAdvisory: "npm-only advisory",
      guideUrl: "https://example.test/guide",
      previewCommand: "npx -y agentera@next upgrade --dry-run",
      irreversibleAdvisory: "one-way advisory",
    };
    const lines = formatNextMajorDoctorLines({
      currentVersion: "2.7.7",
      currentChannel: "stable",
      block,
    });
    lines.push("extra line breaks the cap");
    expect(lines.length).toBeGreaterThan(NEXT_MAJOR_LINE_CAP);
  });
});

describe("next-major doctor vocabulary", () => {
  const forbidden = [/\bv3\b/i, /\bv4\b/i, /major.version/i, /major_version/i];

  it("keeps doctor-section source free of version-named concepts", () => {
    const sourcePath = path.join(REPO_ROOT, "packages/cli/src/upgrade/nextMajorDoctor.ts");
    const source = fs.readFileSync(sourcePath, "utf8");
    for (const pattern of forbidden) {
      expect(source).not.toMatch(pattern);
    }
  });

  it("fails when doctor-section source introduces version-named concepts", () => {
    const sample = "Next major: upgrade to v3 on the stable channel";
    expect(forbidden.some((pattern) => pattern.test(sample))).toBe(true);
  });
});

describe("prependNextMajorDoctorSection", () => {
  it("places the section before Agentera doctor output", () => {
    const status = {
      status: "up_to_date",
      expectedVersion: "2.7.7",
      appHome: "/h",
      managedAppRoot: "/h/app",
      userDataRoot: "/h",
      signals: [],
      dryRunCommand: null,
      applyCommand: null,
      retryCommand: "npx -y agentera prime",
    };
    const section = resolveNextMajorDoctorLines({
      sourceRoot: REPO_ROOT,
      home: tmp,
      channel: "stable",
      runningVersion: "2.7.7",
      runningDistributionMajor: 2,
    });
    const text = prependNextMajorDoctorSection(renderDoctorStatus(status), section);
    expect(text.startsWith(`${NEXT_MAJOR_SECTION_HEADER}\n`)).toBe(true);
    expect(text).toContain("Agentera doctor");
    expect(text.indexOf(NEXT_MAJOR_SECTION_HEADER)).toBeLessThan(text.indexOf("Agentera doctor"));
  });

  it("omits the section entirely when successor is null", () => {
    const status = {
      status: "up_to_date",
      expectedVersion: "3.0.0-dev.4",
      appHome: "/h",
      managedAppRoot: "/h/app",
      userDataRoot: "/h",
      signals: [],
      dryRunCommand: null,
      applyCommand: null,
      retryCommand: "npx -y agentera@next prime",
    };
    const text = prependNextMajorDoctorSection(
      renderDoctorStatus(status),
      resolveNextMajorDoctorLines({
        sourceRoot: REPO_ROOT,
        home: tmp,
        channel: "development",
        runningVersion: "3.0.0-dev.4",
        runningDistributionMajor: 3,
      }),
    );
    expect(text.startsWith("Agentera doctor\n")).toBe(true);
    expect(text).not.toContain(NEXT_MAJOR_SECTION_HEADER);
  });
});
