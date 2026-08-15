import { describe, expect, it } from "vitest";

import { renderManagedMarkdown } from "../../src/state/todoMarkdownProjection.js";
import { inspectTodoSeverityHeadings } from "../../src/state/todoSeverityHeadings.js";

describe("TODO severity headings", () => {
  it("accepts missing bands and unrelated headings", () => {
    expect(inspectTodoSeverityHeadings("# TODO\n\n## ⇶ Critical\n\n## Project notes\n\n## ✓ Resolved\n")).toEqual({ diagnostics: [], omitted_count: 0 });
  });

  it.each([
    "## Project Critical",
    "## Release status Degraded",
    "## Operating status Normal",
    "## Minor issues Annoying",
    "## Recently Resolved",
  ])("ignores unrelated prose heading '%s'", (heading) => {
    expect(inspectTodoSeverityHeadings(`# TODO\n\n${heading}\n`)).toEqual({ diagnostics: [], omitted_count: 0 });
  });

  it.each([
    ["## Resolved", "## ✓ Resolved"],
    ["## ? Degraded", "## ⇉ Degraded"],
  ])("continues diagnosing malformed managed heading '%s'", (heading, expectedHeading) => {
    expect(inspectTodoSeverityHeadings(heading)).toEqual({
      diagnostics: [expect.objectContaining({
        code: "todo_severity_heading_mismatch",
        classification: "glyph_name_mismatch",
        expected_heading: expectedHeading,
      })],
      omitted_count: 0,
    });
  });

  it("reports bounded mismatch, duplicate, and order evidence without inspecting unrelated headings", () => {
    const result = inspectTodoSeverityHeadings([
      "# TODO",
      "## Project Critical notes",
      "## → Normal",
      "## → Critical",
      "## → Normal",
    ].join("\n"));

    expect(result).toEqual({
      diagnostics: [
        expect.objectContaining({ code: "todo_severity_heading_mismatch", classification: "glyph_name_mismatch", line: 4, expected_heading: "## ⇶ Critical" }),
        expect.objectContaining({ code: "todo_severity_heading_out_of_order", classification: "out_of_order", line: 4, expected_heading: "## ⇶ Critical" }),
        expect.objectContaining({ code: "todo_severity_heading_duplicate", classification: "duplicate", line: 5, expected_heading: "## → Normal" }),
      ],
      omitted_count: 0,
    });
  });

  it("inserts a missing band before the first later managed heading", () => {
    const records = new Map([["abcdefghij", { status: "open", severity: "critical", description: "Critical task" }]]);
    const rendered = renderManagedMarkdown("# TODO\n\n## ✓ Resolved\n", records, new Map());

    expect(rendered.indexOf("## ⇶ Critical")).toBeLessThan(rendered.indexOf("## ✓ Resolved"));
    expect(rendered).toContain("## ⇶ Critical\n- [ ] [id:abcdefghij] Critical task\n\n## ✓ Resolved");
  });
});
