import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeoutChangelogBoundary } from "../../src/cli/capabilityContext/planState.js";
import { buildExecutionContext } from "../../src/cli/capabilityContext/build.js";
import { documentCloseoutContext } from "../../src/cli/capabilityContext/closeout.js";
import { cmdQuery } from "../../src/cli/commands/query.js";
import { CHANGELOG_DOCS_MAX_READ_BYTES, CHANGELOG_MAX_HEADING_BYTES, CHANGELOG_MAX_OUTPUT_BYTES, CHANGELOG_MAX_READ_BYTES, CHANGELOG_MAX_SOURCE_PATH_BYTES, CHANGELOG_QUERY_COMMAND, CHANGELOG_SCANNER_ID, readChangelog, scanChangelogHeadings } from "../../src/state/changelog.js";

let project: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-read-"));
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

function releaseHeading(byteLength: number): string {
  const prefix = "## [1.0.0-";
  const suffix = "] - 2026-07-30";
  return `${prefix}${"a".repeat(byteLength - prefix.length - suffix.length)}${suffix}`;
}

function relativePath(byteLength: number): string {
  const parts: string[] = [];
  let remaining = byteLength;
  while (remaining > 200) {
    parts.push("p".repeat(200));
    remaining -= 201;
  }
  parts.push("p".repeat(remaining));
  return parts.join("/");
}

function projectionBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("changelog heading scanner", () => {
  it.each(["\n", "\r\n"])("recognizes canonical headings with %j line endings", (newline) => {
    const scan = scanChangelogHeadings(["# Changelog", "", "## [Unreleased]", "", "## [2.1.0] · 2026-07-01", "## [2.0.0] - 2026-06-01"].join(newline));
    expect(scan).toMatchObject({
      status: "available",
      recognizedHeadings: ["## [Unreleased]", "## [2.1.0] · 2026-07-01"],
      recognizedReleaseCount: 2,
      boundary: "## [Unreleased]",
    });
  });

  it("uses the newest recognized release when Unreleased is absent", () => {
    expect(scanChangelogHeadings("## [1.4.0] - 2026-07-01\n## [1.3.0] - 2026-06-01\n")).toMatchObject({
      status: "available",
      recognizedHeadings: ["## [1.4.0] - 2026-07-01"],
      boundary: "## [1.4.0] - 2026-07-01",
    });
  });

  it("accepts a valid release heading at the identity bound", () => {
    const heading = releaseHeading(CHANGELOG_MAX_HEADING_BYTES);
    expect(Buffer.byteLength(heading)).toBe(CHANGELOG_MAX_HEADING_BYTES);
    expect(scanChangelogHeadings(`${heading}\n`)).toMatchObject({
      status: "available",
      boundary: heading,
      identityBoundExceeded: false,
    });
  });

  it("fails safe above the release-heading identity bound", () => {
    const heading = releaseHeading(CHANGELOG_MAX_HEADING_BYTES + 1);
    expect(scanChangelogHeadings(`${heading}\n`)).toMatchObject({
      status: "incomplete",
      recognizedHeadings: [],
      boundary: null,
      identityBoundExceeded: true,
    });
  });

  it.each([
    ["empty", ""],
    ["no recognized heading", "# Changelog\n\nText\n"],
    ["arbitrary H2", "## [Unreleased]\n## Notes\n## [1.0.0] - 2026-01-01\n"],
    ["duplicate Unreleased", "## [Unreleased]\n## [Unreleased]\n## [1.0.0] - 2026-01-01\n"],
    ["duplicate release", "## [1.0.0] - 2026-01-01\n## [1.0.0] - 2026-01-02\n"],
    ["Unreleased only", "## [Unreleased]\n"],
  ])("fails safe for %s input", (_class, text) => {
    expect(scanChangelogHeadings(text)).toMatchObject({
      status: "incomplete",
      recognizedHeadings: [],
      boundary: null,
    });
  });
});

describe("project changelog reader", () => {
  it("returns one bounded shared projection with scanner provenance", () => {
    fs.writeFileSync(path.join(project, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n## [3.0.0] · 2026-07-30\n");
    const result = readChangelog(project);
    expect(result.projection).toMatchObject({
      status: "available",
      recognized_headings: ["## [Unreleased]", "## [3.0.0] · 2026-07-30"],
      boundary: "## [Unreleased]",
      source: { artifact: "changelog", path: "CHANGELOG.md", path_resolution: "artifact_registry" },
      source_provenance: { command: CHANGELOG_QUERY_COMMAND, scanner: CHANGELOG_SCANNER_ID },
      recovery: null,
    });
    expect(result.recognizedReleaseVersions).toEqual(["3.0.0"]);
    expect(projectionBytes(result.projection)).toBeLessThanOrEqual(CHANGELOG_MAX_OUTPUT_BYTES);
  });

  it("uses the registry-owned docs path mapping without exposing an absolute path", () => {
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.mkdirSync(path.join(project, "docs"));
    fs.writeFileSync(path.join(project, ".agentera/docs.yaml"), ["mapping:", "  - artifact: CHANGELOG.md", "    path: docs/HISTORY.md", ""].join("\n"));
    fs.writeFileSync(path.join(project, "docs/HISTORY.md"), "## [1.0.0] - 2026-07-30\n");
    expect(readChangelog(project).projection).toMatchObject({
      status: "available",
      boundary: "## [1.0.0] - 2026-07-30",
      source: { path: "docs/HISTORY.md", path_resolution: "artifact_registry" },
    });
  });

  it("exposes a mapped source path at the path bound", () => {
    const mapped = relativePath(CHANGELOG_MAX_SOURCE_PATH_BYTES);
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.mkdirSync(path.join(project, path.dirname(mapped)), { recursive: true });
    fs.writeFileSync(path.join(project, ".agentera/docs.yaml"), `mapping:\n  - artifact: CHANGELOG.md\n    path: ${mapped}\n`);
    fs.writeFileSync(path.join(project, mapped), "## [1.0.0] - 2026-07-30\n");
    const projection = readChangelog(project).projection;
    expect(Buffer.byteLength(mapped)).toBe(CHANGELOG_MAX_SOURCE_PATH_BYTES);
    expect(projection).toMatchObject({ status: "available", source: { path: mapped } });
    expect(projectionBytes(projection)).toBeLessThanOrEqual(CHANGELOG_MAX_OUTPUT_BYTES);
  });

  it("uses the fixed privacy-safe envelope above the mapped source-path bound", () => {
    const mapped = relativePath(CHANGELOG_MAX_SOURCE_PATH_BYTES + 1);
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.writeFileSync(path.join(project, ".agentera/docs.yaml"), `mapping:\n  - artifact: CHANGELOG.md\n    path: ${mapped}\n`);
    const projection = readChangelog(project).projection;
    expect(projection).toMatchObject({ status: "unavailable", source: { path: null } });
    expect(JSON.stringify(projection)).not.toContain(mapped);
    expect(projectionBytes(projection)).toBeLessThanOrEqual(CHANGELOG_MAX_OUTPUT_BYTES);
  });

  it("fails closed when present docs authority is malformed", () => {
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.writeFileSync(path.join(project, ".agentera/docs.yaml"), "mapping: [private-value");
    const serialized = JSON.stringify(readChangelog(project).projection);
    expect(JSON.parse(serialized)).toMatchObject({ status: "unavailable", source: { path: null } });
    expect(serialized).not.toContain("private-value");
  });

  it("fails closed when present docs authority is a symlink", () => {
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.writeFileSync(path.join(project, "private-docs.yaml"), "mapping:\n  - artifact: CHANGELOG.md\n    path: private.md\n");
    fs.symlinkSync(path.join(project, "private-docs.yaml"), path.join(project, ".agentera/docs.yaml"));
    const serialized = JSON.stringify(readChangelog(project).projection);
    expect(JSON.parse(serialized)).toMatchObject({ status: "unavailable", source: { path: null } });
    expect(serialized).not.toContain("private.md");
  });

  it("fails closed when present docs authority exceeds its read bound", () => {
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.writeFileSync(path.join(project, ".agentera/docs.yaml"), Buffer.alloc(CHANGELOG_DOCS_MAX_READ_BYTES + 1, 0x78));
    const projection = readChangelog(project).projection;
    expect(projection).toMatchObject({ status: "unavailable", source: { path: null } });
    expect(projectionBytes(projection)).toBeLessThanOrEqual(CHANGELOG_MAX_OUTPUT_BYTES);
  });

  it("fails closed when present docs authority is not valid UTF-8", () => {
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.writeFileSync(path.join(project, "CHANGELOG.md"), "## [8.8.8-default] - 2026-07-30\n");
    fs.writeFileSync(path.join(project, "private.md"), "## [9.9.9-private] - 2026-07-30\n");
    fs.writeFileSync(path.join(project, ".agentera/docs.yaml"), Buffer.concat([Buffer.from("# "), Buffer.from([0xff]), Buffer.from("\nmapping:\n  - artifact: CHANGELOG.md\n    path: private.md\n")]));
    const serialized = JSON.stringify(readChangelog(project).projection);
    expect(JSON.parse(serialized)).toMatchObject({ status: "unavailable", source: { path: null } });
    expect(serialized).not.toContain("8.8.8-default");
    expect(serialized).not.toContain("9.9.9-private");
    expect(serialized).not.toContain("private.md");
  });

  it("uses the fixed envelope for a valid heading above the identity bound", () => {
    fs.writeFileSync(path.join(project, "CHANGELOG.md"), `${releaseHeading(CHANGELOG_MAX_HEADING_BYTES + 1)}\n`);
    const projection = readChangelog(project).projection;
    expect(projection).toMatchObject({
      schemaVersion: "agentera.changelogRead.v1",
      status: "unavailable",
      source: { path: null },
      source_provenance: { command: CHANGELOG_QUERY_COMMAND, scanner: CHANGELOG_SCANNER_ID },
      recovery: { retry: CHANGELOG_QUERY_COMMAND, retry_limit: 1 },
    });
    expect(projectionBytes(projection)).toBeLessThanOrEqual(CHANGELOG_MAX_OUTPUT_BYTES);
  });

  it.each(["missing", "directory"])("normalizes %s input as unavailable", (kind) => {
    if (kind === "directory") fs.mkdirSync(path.join(project, "CHANGELOG.md"));
    expect(readChangelog(project).projection).toMatchObject({
      status: "unavailable",
      boundary: null,
      recovery: {
        strategy: "repair_validate_retry_once",
        retry: CHANGELOG_QUERY_COMMAND,
        retry_limit: 1,
      },
    });
  });

  it("rejects an escaping changelog symlink without exposing its target", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-outside-"));
    const target = path.join(outside, "private.md");
    fs.writeFileSync(target, "## [9.9.9] - 2026-01-01\n");
    fs.symlinkSync(target, path.join(project, "CHANGELOG.md"));
    try {
      const serialized = JSON.stringify(readChangelog(project).projection);
      expect(JSON.parse(serialized)).toMatchObject({ status: "unavailable", boundary: null });
      expect(serialized).not.toContain(outside);
      expect(serialized).not.toContain("private.md");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a changelog over the bounded read limit", () => {
    fs.writeFileSync(path.join(project, "CHANGELOG.md"), Buffer.alloc(CHANGELOG_MAX_READ_BYTES + 1, 0x20));
    expect(readChangelog(project).projection).toMatchObject({
      status: "unavailable",
      caveats: [expect.stringContaining("bounded read limit")],
    });
  });

  it("normalizes unreadable UTF-8 without leaking decoder errors", () => {
    fs.writeFileSync(path.join(project, "CHANGELOG.md"), Buffer.from([0xff, 0xfe]));
    const serialized = JSON.stringify(readChangelog(project).projection);
    expect(JSON.parse(serialized)).toMatchObject({ status: "unavailable", boundary: null });
    expect(serialized).not.toContain("encoded data");
  });

  it("layers Build target-version recognition on the shared result", () => {
    fs.writeFileSync(path.join(project, "CHANGELOG.md"), "## [Unreleased]\n## [3.0.0] · 2026-07-30\n");
    expect(closeoutChangelogBoundary(project, { title: "Release 3.0.0" })).toMatchObject({
      status: "available",
      selected_target_version: "3.0.0",
      selected_target_recorded: true,
      release_state: "selected_target_recorded",
      source_provenance: { command: CHANGELOG_QUERY_COMMAND, scanner: CHANGELOG_SCANNER_ID },
    });
  });

  it("bounds oversized Build and Document target overlays without target leakage", () => {
    const mapped = relativePath(300);
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.mkdirSync(path.join(project, path.dirname(mapped)), { recursive: true });
    fs.writeFileSync(path.join(project, ".agentera/docs.yaml"), `mapping:\n  - artifact: CHANGELOG.md\n    path: ${mapped}\n`);
    fs.writeFileSync(path.join(project, mapped), "## [1.0.0] - 2026-07-30\n");
    const oversizedTarget = `${"9".repeat(3_004)}.1.1`;
    const plan = { exists: false, active: false, title: `Release ${oversizedTarget}`, tasks: [] };
    const shared = readChangelog(project).projection;
    expect(shared).toMatchObject({ status: "available", source: { path: mapped } });
    const previousCwd = process.cwd();
    let queryOutput = "";
    process.chdir(project);
    try {
      expect(
        cmdQuery(
          { query: "changelog", format: "json" },
          {
            out: (text) => {
              queryOutput += text;
            },
          },
        ),
      ).toBe(0);
    } finally {
      process.chdir(previousCwd);
    }
    const query = JSON.parse(queryOutput) as Record<string, unknown>;

    const build = buildExecutionContext("build", {}, plan, { exists: true }, { exists: true }, [], { exists: true }, { status: "loaded" }, { status: "up_to_date" }, project)!.changelog_boundary as Record<string, unknown>;
    const document = documentCloseoutContext("document", {}, plan, { exists: true }, [], { exists: true }, { status: "loaded" }, { status: "up_to_date" }, {}, project)!.changelog_boundary as Record<string, unknown>;

    for (const boundary of [build, document]) {
      const serialized = JSON.stringify(boundary);
      expect(boundary).toMatchObject({
        selected_target_version: null,
        selected_target_recorded: false,
        recovery: null,
      });
      expect(boundary.recovery).toEqual(query.recovery);
      expect(projectionBytes(boundary)).toBeLessThanOrEqual(CHANGELOG_MAX_OUTPUT_BYTES);
      expect(serialized).not.toContain(oversizedTarget);
      expect(serialized).not.toContain("9".repeat(128));
    }
  });
});
