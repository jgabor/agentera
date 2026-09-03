import { describe, expect, it } from "vitest";

import { runStateWrite } from "../../src/cli/commands/state/write.js";
import { parseQueryArgs } from "../../src/cli/dispatch/state.js";

describe("state output defaults", () => {
  it("defaults query and writer parsers to JSON", () => {
    expect(parseQueryArgs(["--list-artifacts"])).toMatchObject({ format: "json" });

    let out = "";
    expect(
      runStateWrite("progress", ["explain"], {
        out: (text) => {
          out += text;
        },
      }),
    ).toBe(0);
    expect(JSON.parse(out)).toMatchObject({
      schemaVersion: "agentera.stateWriteExplain.v1",
      artifact: "progress",
    });
  });

  it.each(["text", "yaml"])("rejects non-JSON query and writer selectors as JSON", (format) => {
    expect(parseQueryArgs(["--list-artifacts", "--format", format])).toEqual({
      error: `argument --format: invalid choice: '${format}' (choose from 'json')`,
    });

    let out = "";
    expect(
      runStateWrite("progress", ["explain", "--format", format], {
        out: (text) => {
          out += text;
        },
      }),
    ).toBe(2);
    expect(JSON.parse(out).error).toMatchObject({
      class: "invalid_choice",
      valid_values: ["json"],
    });
  });
});
