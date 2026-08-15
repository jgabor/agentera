import { describe, expect, it } from "vitest";

import { parseTodoMarkdownListItem } from "../../src/cli/todoMarkdown.js";

describe("parseTodoMarkdownListItem", () => {
  it("treats [x] checkbox before type tag as resolved", () => {
    expect(parseTodoMarkdownListItem("- [x] [fix] Resolved item")).toEqual({
      status: "resolved",
      description: "[fix] Resolved item",
      title: "Resolved item",
      kind: "fix",
      target_version: null,
    });
  });

  it("treats [ ] checkbox before type tag as open", () => {
    expect(parseTodoMarkdownListItem("- [ ] [fix] Open item")).toEqual({
      status: "open",
      description: "[fix] Open item",
      title: "Open item",
      kind: "fix",
      target_version: null,
    });
  });

  it("treats type-only bracket as open", () => {
    expect(parseTodoMarkdownListItem("- [fix:3.0.0] Type-only item")).toEqual({
      status: "open",
      description: "Type-only item",
      title: "Type-only item",
      kind: "fix",
      target_version: "3.0.0",
    });
  });

  it("recognizes only leading legacy presentation IDs, not referenced IDs in prose", () => {
    expect(parseTodoMarkdownListItem("- [ ] [fix:3.0.0] `abcdefghij` Legacy title")).toMatchObject({
      id: "abcdefghij",
      public_description: "[fix:3.0.0] Legacy title",
      title: "Legacy title",
    });
    const referenced = parseTodoMarkdownListItem("- [ ] [fix:3.0.0] Keep follow-up `abcdefghij` open");
    expect(referenced).toMatchObject({
      title: "Keep follow-up `abcdefghij` open",
    });
    expect(referenced).not.toHaveProperty("id");
  });

  it("returns null for non-list lines", () => {
    expect(parseTodoMarkdownListItem("not a list")).toBeNull();
  });
});
