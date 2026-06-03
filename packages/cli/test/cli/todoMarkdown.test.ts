import { describe, expect, it } from "vitest";

import { parseTodoMarkdownListItem } from "../../src/cli/todoMarkdown.js";

describe("parseTodoMarkdownListItem", () => {
  it("treats [x] checkbox before type tag as resolved", () => {
    expect(parseTodoMarkdownListItem("- [x] [fix] Resolved item")).toEqual({
      status: "resolved",
      description: "[fix] Resolved item",
    });
  });

  it("treats [ ] checkbox before type tag as open", () => {
    expect(parseTodoMarkdownListItem("- [ ] [fix] Open item")).toEqual({
      status: "open",
      description: "[fix] Open item",
    });
  });

  it("treats type-only bracket as open", () => {
    expect(parseTodoMarkdownListItem("- [fix:3.0.0] Type-only item")).toEqual({
      status: "open",
      description: "Type-only item",
    });
  });

  it("returns null for non-list lines", () => {
    expect(parseTodoMarkdownListItem("not a list")).toBeNull();
  });
});
