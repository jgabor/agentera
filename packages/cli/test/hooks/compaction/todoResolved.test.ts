import { describe, expect, it } from "vitest";

import { ArtifactSchemaValidator } from "../../../src/hooks/validateArtifact/index.js";
import {
  countTodoResolvedEntries,
  countTodoResolvedInSeverityBands,
  normalizeTodoResolvedLayout,
} from "../../../src/hooks/compaction/parse.js";

describe("parse todo-resolved layout", () => {
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
    expect(countTodoResolvedEntries(todo)).toEqual({ full: 0, oneline: 1 });
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
