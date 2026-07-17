import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { ArtifactSchemaValidator } from "../../../src/hooks/validateArtifact/index.js";
import {
  countTodoResolvedEntries,
  countTodoResolvedInSeverityBands,
  countTodoResolvedSectionHeadings,
  countTodoPendingSummarization,
  extractResolvedSection,
  isTodoResolvedSectionHeading,
  normalizeTodoResolvedLayout,
} from "../../../src/hooks/compaction/parse.js";
import { compactFile } from "../../../src/hooks/compaction/apply.js";
import { checkCompaction, computeCompactionStatus, runCompaction } from "../../../src/hooks/compaction/status.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "todo-resolved-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("parse todo-resolved layout", () => {
  it("does not read the legacy TODO aggregate as compaction authority in entity mode", () => {
    fs.mkdirSync(path.join(tmp, ".agentera"));
    fs.writeFileSync(path.join(tmp, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    fs.writeFileSync(path.join(tmp, "TODO.md"), "not a valid TODO aggregate\n");
    expect(computeCompactionStatus(tmp).some((status) => status.artifact === "todo#Resolved")).toBe(false);
  });

  it("counts mis-placed resolved rows in severity bands for the compaction gate", () => {
    const todo = [
      "# TODO",
      "",
      "## ⇶ Critical",
      "- [x] [fix] Done in critical",
      "",
      "## → Normal",
      "- [ ] [chore] Still open",
      "",
    ].join("\n");
    expect(countTodoResolvedInSeverityBands(todo)).toBe(1);
    // Positional tiering per TC9: a single resolved row occupies the
    // first full-detail slot (min(N,10)=1), yielding full=1/oneline=0
    // (not full=0/oneline=1 as kind-based counting would produce).
    expect(countTodoResolvedEntries(todo)).toEqual({ full: 1, oneline: 0 });
  });

  it("migrates mis-placed resolved rows into ## ✓ Resolved on normalize", () => {
    const todo = [
      "# TODO",
      "",
      "## ⇶ Critical",
      "- [x] [fix] First",
      "",
      "## → Normal",
      "- [ ] [chore] Open",
      "- [x] [feat] Second",
      "",
      "## ⇢ Annoying",
      "",
      "## ✓ Resolved",
      "",
    ].join("\n");
    const { text, changed } = normalizeTodoResolvedLayout(todo);
    expect(changed).toBe(true);
    expect(text).toContain("## ✓ Resolved");
    expect(text).toContain("- [x] [fix] First");
    expect(text).toContain("- [x] [feat] Second");
    const normalBody = text.match(/## → Normal\n([\s\S]*?)(?=\n## |\n?$)/)?.[1] ?? "";
    expect(normalBody).not.toMatch(/^- \[x\]/m);
    const violations = new ArtifactSchemaValidator().validateMarkdown(text, "TODO.md", null);
    expect(violations.filter((v) => v.includes("## ✓ Resolved"))).toEqual([]);
  });
});

describe("duplicate ## ✓ Resolved section detection", () => {
  const duplicateTodo = [
    "# TODO",
    "",
    "## → Normal",
    "- [ ] [chore] Open item one",
    "",
    "## ✓ Resolved",
    "- [x] [fix] First resolved",
    "",
    "## ⇢ Annoying",
    "- [ ] [chore] Annoying open item",
    "",
    "## ✓ Resolved",
    "- [x] [fix] Second resolved",
    "",
  ].join("\n");

  it("countTodoResolvedSectionHeadings returns the true section count", () => {
    expect(countTodoResolvedSectionHeadings(duplicateTodo)).toBe(2);
    const single = duplicateTodo.replace("## ✓ Resolved\n- [x] [fix] Second resolved\n", "");
    expect(countTodoResolvedSectionHeadings(single)).toBe(1);
    expect(countTodoResolvedSectionHeadings("# TODO\n\n## → Normal\n- [ ] open\n")).toBe(0);
  });

  it("validation requires one Resolved section before any item is resolved", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, "# TODO\n\n## → Normal\n- [ ] [chore] Open item\n");
    const violations = new ArtifactSchemaValidator().validateExplicit("TODO.md", todoPath, tmp);
    expect(violations).toContain("TODO.md: missing required '## ✓ Resolved' section");
  });

  it("validateTodoResolvedPlacement refuses with an actionable violation", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, duplicateTodo);
    const violations = new ArtifactSchemaValidator().validateExplicit("TODO.md", todoPath, tmp);
    expect(
      violations.some((v) => v.includes("2 '## ✓ Resolved' sections") && v.includes("merge")),
    ).toBe(true);
  });

  it("compaction status emits an error (not ok) and surfaces Git recovery guidance", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, duplicateTodo);
    const status = computeCompactionStatus(tmp).find((s) => s.artifact === "todo#Resolved");
    expect(status?.classification).toBe("error");
    expect(status?.reason).toContain("2 '## ✓ Resolved' sections");
    expect(status?.reason).toContain("merge into exactly one");
    expect(status?.reason).toContain("git log -p -- :/TODO.md");
    expect(status?.reason).toContain("no lossless archive");
  });

  it("checkCompaction reports the todo#Resolved duplicate as an error operation", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, duplicateTodo);
    const op = checkCompaction(tmp).find((o) => o.status.artifact === "todo#Resolved");
    expect(op?.action).toBe("error");
  });

  it("fixCompaction refuses to compact a duplicate-section TODO without mutating it", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, duplicateTodo);
    const before = fs.readFileSync(todoPath, "utf8");
    const ops = runCompaction(tmp, "fix");
    const op = ops.find((o) => o.status.artifact === "todo#Resolved");
    expect(op?.action).toBe("error");
    expect(op?.changed).toBe(false);
    // The duplicate file is left untouched — no silent merge on the fix path.
    expect(fs.readFileSync(todoPath, "utf8")).toBe(before);
  });

  it("compactFile throws on a duplicate-section TODO (defense for direct callers)", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, duplicateTodo);
    expect(() => compactFile(todoPath, "todo-resolved")).toThrow(
      /2 '## ✓ Resolved' sections.*merge into exactly one.*git log -p -- :\/TODO\.md/s,
    );
    // File unchanged.
    expect(fs.readFileSync(todoPath, "utf8")).toBe(duplicateTodo);
  });
});

describe("todo-resolved compaction ordering and diagnostics", () => {
  function resolvedEntry(i: number): string[] {
    const day = String((i % 28) + 1).padStart(2, "0");
    return [
      `- [x] ~~[fix:3.0.0] item ${i} resolved 2026-01-${day} MARKER-${i} brief description~~`,
      `    Detail body for item ${i} with additional resolved context.`,
    ];
  }

  function overLimitTodo(count: number): string {
    const entries: string[] = [];
    for (let i = 1; i <= count; i++) entries.push(...resolvedEntry(i), "");
    return ["# TODO", "", "## → Normal", "- [ ] [chore] Open item", "", "## ✓ Resolved", "", ...entries].join("\n");
  }

  it("retains the 10 newest resolved entries in full, summarizes the next 40, and drops the oldest", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, overLimitTodo(55));
    const result = compactFile(todoPath, "todo-resolved");

    expect(result.full_before).toBe(10);
    expect(result.oneline_before).toBe(45);
    expect(result.full_after).toBe(10);
    expect(result.oneline_after).toBe(40);
    expect(result.dropped).toBe(5);
    expect(result.changed).toBe(true);

    const after = fs.readFileSync(todoPath, "utf8");
    // Newest 10 retained in full (header + detail body).
    expect(after).toContain("MARKER-1");
    expect(after).toContain("Detail body for item 1");
    expect(after).toContain("MARKER-10");
    expect(after).toContain("Detail body for item 10");
    // Items 11–50 summarized: header present, detail body stripped.
    expect(after).toContain("MARKER-11");
    expect(after).not.toContain("Detail body for item 11");
    expect(after).toContain("MARKER-50");
    expect(after).not.toContain("Detail body for item 50");
    // Oldest 5 dropped entirely.
    expect(after).not.toContain("MARKER-51");
    expect(after).not.toContain("MARKER-55");

    // Ordering preserved newest-first for retained entries.
    expect(after.indexOf("MARKER-1")).toBeLessThan(after.indexOf("MARKER-10"));
    expect(after.indexOf("MARKER-10")).toBeLessThan(after.indexOf("MARKER-50"));
  });

  it("reports dropped entries honestly with Git recovery (not a lossless projection)", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, overLimitTodo(55));
    const result = compactFile(todoPath, "todo-resolved");
    expect(result.dropped).toBe(5);
    expect(result.omission_reason).toBeTruthy();
    expect(result.omission_reason).toContain("dropped");
    expect(result.omission_reason).toContain("git log -p -- :/TODO.md");
    expect(result.omission_reason).toContain("previously committed");
    expect(result.omission_reason).toContain("no historical recovery");
    // The diagnostic must not project the YAML lossless-projection model onto TODO.
    expect(result.omission_reason).not.toMatch(/lossless projection/);
  });

  it("does not compact when within the 10/40/50 budget and sets no recovery guidance", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, overLimitTodo(8));
    const result = compactFile(todoPath, "todo-resolved");
    expect(result.dropped).toBe(0);
    expect(result.full_after).toBe(8);
    expect(result.changed).toBe(false);
    expect(result.omission_reason).toBeUndefined();
  });
});

describe("shared resolved-heading matcher variants", () => {
  it("isTodoResolvedSectionHeading accepts case-insensitive and space-flexible variants", () => {
    expect(isTodoResolvedSectionHeading("## ✓ Resolved")).toBe(true);
    expect(isTodoResolvedSectionHeading("## Resolved")).toBe(true);
    expect(isTodoResolvedSectionHeading("## resolved")).toBe(true);
    expect(isTodoResolvedSectionHeading("## RESOLVED")).toBe(true);
    expect(isTodoResolvedSectionHeading("##resolved")).toBe(true);
    expect(isTodoResolvedSectionHeading("## ✓ resolved")).toBe(true);
    expect(isTodoResolvedSectionHeading("## ✓ RESOLVED")).toBe(true);
    // Non-matches: must not fire on unrelated headings.
    expect(isTodoResolvedSectionHeading("## → Normal")).toBe(false);
    expect(isTodoResolvedSectionHeading("## Resolved Items")).toBe(false);
    expect(isTodoResolvedSectionHeading("# Resolved")).toBe(false);
  });

  it("countTodoResolvedSectionHeadings counts all variant headings consistently", () => {
    const variants = [
      "# TODO",
      "",
      "## ✓ Resolved",
      "- [x] [fix] First",
      "",
      "## resolved",
      "- [x] [fix] Second",
      "",
      "## RESOLVED",
      "- [x] [fix] Third",
      "",
    ].join("\n");
    expect(countTodoResolvedSectionHeadings(variants)).toBe(3);
  });

  it("extractResolvedSection extracts from case-variant headings (was \\s+ without i flag)", () => {
    for (const heading of ["## ✓ Resolved", "## resolved", "## RESOLVED", "##resolved"]) {
      const todo = `# TODO\n\n## → Normal\n- [ ] open\n\n${heading}\n- [x] [fix] Body entry\n`;
      const [start, , body] = extractResolvedSection(todo);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(body).toContain("[x] [fix] Body entry");
    }
    // Non-matching heading returns -1.
    const [, end] = extractResolvedSection("# TODO\n\n## → Normal\n- [ ] open\n");
    expect(end).toBe(-1);
  });
});

describe("inline-row positional tier regression", () => {
  // Entries 1-5 have no indented body; entries 6-55 have indented detail
  // bodies. The first 10 are the full-detail tier (bodies preserved if
  // present), rows 11-50 are stripped to one-line, rows 51+ are dropped
  // — regardless of body presence (TC9: positional, not body-based).
  function inlineTodo(count: number, firstBodyless: number): string {
    const entries: string[] = [];
    for (let i = 1; i <= count; i++) {
      entries.push(`- [x] ~~[fix:3.0.0] item ${i} resolved 2026-07-${String(i % 28 + 1).padStart(2, "0")} MARKER-${i}~~`);
      if (i > firstBodyless) {
        entries.push(`    Inline detail body for item ${i} with context.`);
      }
      entries.push("");
    }
    return ["# TODO", "", "## → Normal", "- [ ] [chore] Open", "", "## ✓ Resolved", "", ...entries].join("\n");
  }

  it("promotes first 10 bodyless entries to full tier, preserves bodies where present, strips 11-50", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, inlineTodo(55, 5));
    const result = compactFile(todoPath, "todo-resolved");

    expect(result.full_before).toBe(10);
    expect(result.oneline_before).toBe(45);
    expect(result.full_after).toBe(10);
    expect(result.oneline_after).toBe(40);
    expect(result.dropped).toBe(5);
    expect(result.changed).toBe(true);

    const after = fs.readFileSync(todoPath, "utf8");
    // Entries 1-5: full tier, header only (body was never present).
    expect(after).toContain("MARKER-1");
    expect(after).toContain("MARKER-5");
    // Entry 6: full tier, body preserved.
    expect(after).toContain("MARKER-6");
    expect(after).toContain("Inline detail body for item 6 with context.");
    // Entry 10: full tier, body preserved.
    expect(after).toContain("MARKER-10");
    expect(after).toContain("Inline detail body for item 10 with context.");
    // Entry 11: summary tier, body stripped.
    expect(after).toContain("MARKER-11");
    expect(after).not.toContain("Inline detail body for item 11 with context.");
    expect(after).toContain("MARKER-50");
    expect(after).not.toContain("Inline detail body for item 50 with context.");
    // Entries 51-55: dropped.
    expect(after).not.toContain("MARKER-51");
    expect(after).not.toContain("MARKER-55");
  });

  it("is idempotent: a second compaction is a no-op", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, inlineTodo(55, 5));
    const first = compactFile(todoPath, "todo-resolved");
    expect(first.dropped).toBe(5);
    const afterFirst = fs.readFileSync(todoPath, "utf8");

    const second = compactFile(todoPath, "todo-resolved");
    expect(second.dropped).toBe(0);
    expect(second.changed).toBe(false);
    expect(second.full_before).toBe(10);
    expect(second.oneline_before).toBe(40);
    expect(second.full_after).toBe(10);
    expect(second.oneline_after).toBe(40);

    const afterSecond = fs.readFileSync(todoPath, "utf8");
    expect(afterSecond).toBe(afterFirst);
  });

  it("status reports 10/40/50 correctly after compaction (not 0/50)", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, inlineTodo(55, 55)); // all bodyless (like live TODO)
    compactFile(todoPath, "todo-resolved");

    const status = computeCompactionStatus(tmp).find((s) => s.artifact === "todo#Resolved");
    expect(status?.classification).toBe("compactable");
    expect(status?.active_count).toBe(10);
    expect(status?.archive_count).toBe(40);
    expect(status?.total_count).toBe(50);
    expect(status?.over_limit_count).toBe(0);
  });
});

describe("merged-two-section ordering regression", () => {
  // Simulates a post-merge scenario: entries from two former `## ✓ Resolved`
  // sections are interleaved under one heading in newest-first order. The
  // newest entries (from the second former section, dates 07-14 through
  // 07-10) must be retained, not the physical first 50 rows which would be
  // the oldest section's entries.
  it("retains newest entries from former second section and drops oldest from first", () => {
    const entries: string[] = [];
    // First 6 entries: newest (from former section 2, dates 07-14 through 07-10).
    for (const day of [14, 13, 12, 11, 10, 9]) {
      entries.push(`- [x] ~~[fix:3.0.0] newer item ${day} resolved 2026-07-${day} NEW-${day}~~`);
      entries.push(`    Detail for newer ${day}.`);
      entries.push("");
    }
    // Remaining 55 entries: older (from former section 1, dates 07-08 through 06-09).
    let d = 8;
    let month = 7;
    for (let i = 7; i <= 61; i++) {
      entries.push(`- [x] ~~[fix:3.0.0] older item ${i} resolved 2026-0${month}-${String(d).padStart(2, "0")} OLD-${i}~~`);
      entries.push(`    Detail for older ${i}.`);
      entries.push("");
      d--;
      if (d < 1) {
        d = 28;
        month = month === 7 ? 6 : 5;
      }
    }

    const todo = ["# TODO", "", "## → Normal", "- [ ] [chore] Open", "", "## ✓ Resolved", "", ...entries].join("\n");
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, todo);

    const result = compactFile(todoPath, "todo-resolved");
    expect(result.full_before).toBe(10);
    expect(result.oneline_before).toBe(51);
    expect(result.full_after).toBe(10);
    expect(result.oneline_after).toBe(40);
    expect(result.dropped).toBe(11);

    const after = fs.readFileSync(todoPath, "utf8");
    // Newest 6 (from former second section) retained in full tier with bodies.
    expect(after).toContain("NEW-14");
    expect(after).toContain("Detail for newer 14");
    expect(after).toContain("NEW-9");
    expect(after).toContain("Detail for newer 9");
    // Next 4 older entries also in full tier (positions 7-10).
    expect(after).toContain("OLD-7");
    expect(after).toContain("Detail for older 7");
    expect(after).toContain("OLD-10");
    expect(after).toContain("Detail for older 10");
    // Positions 11-50: summary tier, bodies stripped.
    expect(after).toContain("OLD-11");
    expect(after).not.toContain("Detail for older 11");
    expect(after).toContain("OLD-50");
    expect(after).not.toContain("Detail for older 50");
    // Positions 51-61: dropped.
    expect(after).not.toContain("OLD-51");
    expect(after).not.toContain("OLD-61");

    // Ordering preserved: newest-first retained, oldest dropped.
    expect(after.indexOf("NEW-14")).toBeLessThan(after.indexOf("NEW-9"));
    expect(after.indexOf("NEW-9")).toBeLessThan(after.indexOf("OLD-7"));
    expect(after.indexOf("OLD-10")).toBeLessThan(after.indexOf("OLD-50"));
  });
});

describe("≤15-word summary enforcement for rows 11-50", () => {
  // Bodyless inline rows must be summarized to ≤15 words at positions 11-50.
  // The first 10 rows are preserved verbatim (full-detail tier).
  function bodylessTodo(count: number): string {
    const entries: string[] = [];
    for (let i = 1; i <= count; i++) {
      entries.push(
        `- [x] ~~[fix:3.0.0] item ${i} resolved 2026-07-${String(i % 28 + 1).padStart(2, "0")} WORDY-${i} this is a very long resolved entry that exceeds fifteen words and should be truncated to a summary at position eleven through fifty~~`,
      );
      entries.push("");
    }
    return ["# TODO", "", "## → Normal", "- [ ] [chore] Open", "", "## ✓ Resolved", "", ...entries].join("\n");
  }

  it("produces ≤15-word summaries for bodyless rows 11-50, preserves rows 1-10 verbatim", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, bodylessTodo(50));
    const result = compactFile(todoPath, "todo-resolved");

    expect(result.dropped).toBe(0);
    expect(result.full_after).toBe(10);
    expect(result.oneline_after).toBe(40);
    expect(result.changed).toBe(true);

    const after = fs.readFileSync(todoPath, "utf8");
    const lines = after.split("\n").filter((l) => /^\s*-\s+\[x\]/.test(l));

    // Rows 1-10: verbatim (no truncation, contains the full long text).
    expect(lines[0]).toContain("WORDY-1");
    expect(lines[0].split(/\s+/).length).toBeGreaterThan(15);
    expect(lines[9]).toContain("WORDY-10");
    expect(lines[9].split(/\s+/).length).toBeGreaterThan(15);

    // Rows 11-50: ≤15-word summaries (truncated with "...").
    // The ≤15-word limit applies to the summary content after the `- [x]`
    // prefix, not the full line. Strip `- [x]` before counting.
    expect(lines[10]).toContain("WORDY-11");
    const summary11 = lines[10].replace(/^-\s+\[x\]\s+/, "");
    expect(summary11.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(16); // 15 words + "..."
    expect(summary11).toContain("...");
    expect(lines[49]).toContain("WORDY-50");
    const summary50 = lines[49].replace(/^-\s+\[x\]\s+/, "");
    expect(summary50.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(16);
    expect(summary50).toContain("...");
  });

  it("fix is triggered under total=50 when rows 11-50 are unsummarized", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, bodylessTodo(50));

    // Status should detect pending summarization even though total=50.
    const status = computeCompactionStatus(tmp).find((s) => s.artifact === "todo#Resolved");
    expect(status?.classification).toBe("compactable");
    expect(status?.pending_summarization_count).toBe(40);
    expect(status?.over_limit_count).toBe(0);

    // Check mode reports formatting work without claiming the artifact is over limit.
    const checkOp = checkCompaction(tmp).find((o) => o.status.artifact === "todo#Resolved");
    expect(checkOp?.action).toBe("formatting");
    expect(checkOp?.message).toContain("summarization");

    // fix mode should rewrite.
    const before = fs.readFileSync(todoPath, "utf8");
    const fixOps = runCompaction(tmp, "fix");
    const fixOp = fixOps.find((o) => o.status.artifact === "todo#Resolved");
    expect(fixOp?.action).toBe("compacted");
    expect(fixOp?.changed).toBe(true);
    const after = fs.readFileSync(todoPath, "utf8");
    expect(after).not.toBe(before);
  });

  it("second fix is idempotent: already-summarized rows 11-50 are not rewritten", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, bodylessTodo(50));

    // First compaction.
    const first = compactFile(todoPath, "todo-resolved");
    expect(first.changed).toBe(true);
    const afterFirst = fs.readFileSync(todoPath, "utf8");

    // Second compaction.
    const second = compactFile(todoPath, "todo-resolved");
    expect(second.changed).toBe(false);
    expect(second.dropped).toBe(0);
    const afterSecond = fs.readFileSync(todoPath, "utf8");

    // File unchanged.
    expect(afterSecond).toBe(afterFirst);
  });

  it("countTodoPendingSummarization returns 0 for already-compacted bodyless entries", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, bodylessTodo(50));
    compactFile(todoPath, "todo-resolved");
    const after = fs.readFileSync(todoPath, "utf8");
    expect(countTodoPendingSummarization(after)).toBe(0);
  });

  it("countTodoPendingSummarization detects unsummarized rows at total=50", () => {
    expect(countTodoPendingSummarization(bodylessTodo(50))).toBe(40);
    expect(countTodoPendingSummarization(bodylessTodo(8))).toBe(0); // no summary tier
  });
});

describe("zero Resolved heading enforcement", () => {
  const zeroHeadingTodo = [
    "# TODO",
    "",
    "## → Normal",
    "- [x] [fix] Resolved item in a severity band with no heading",
    "- [ ] [chore] Open item",
    "",
  ].join("\n");

  it("validation flags missing heading when resolved items are misplaced", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, zeroHeadingTodo);
    const violations = new ArtifactSchemaValidator().validateExplicit("TODO.md", todoPath, tmp);
    expect(violations.some((v) => v.includes("## ✓ Resolved"))).toBe(true);
  });

  it("status reports error when zero headings and resolved items exist", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, zeroHeadingTodo);
    const status = computeCompactionStatus(tmp).find((s) => s.artifact === "todo#Resolved");
    expect(status?.classification).toBe("error");
    expect(status?.reason).toContain("no required '## ✓ Resolved' section");
    expect(status?.reason).toContain("add exactly one");
  });

  it("checkCompaction reports zero-heading TODO as an error operation", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, zeroHeadingTodo);
    const op = checkCompaction(tmp).find((o) => o.status.artifact === "todo#Resolved");
    expect(op?.action).toBe("error");
  });

  it("compactFile throws on zero-heading TODO with resolved items", () => {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, zeroHeadingTodo);
    expect(() => compactFile(todoPath, "todo-resolved")).toThrow(
      /no required '## ✓ Resolved' section.*add exactly one/s,
    );
    // File unchanged.
    expect(fs.readFileSync(todoPath, "utf8")).toBe(zeroHeadingTodo);
  });

  it("status and apply reject zero headings even before any item is resolved", () => {
    const noResolvedTodo = ["# TODO", "", "## → Normal", "- [ ] [chore] Open item", ""].join("\n");
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, noResolvedTodo);

    const status = computeCompactionStatus(tmp).find((s) => s.artifact === "todo#Resolved");
    expect(status?.classification).toBe("error");
    expect(status?.reason).toContain("no required '## ✓ Resolved' section");
    expect(() => compactFile(todoPath, "todo-resolved")).toThrow(
      /no required '## ✓ Resolved' section/,
    );
  });
});
