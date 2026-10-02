import { describe, expect, it } from "vite-plus/test";

import { parseToml } from "../../src/core/toml.js";

describe("parseToml", () => {
  it("parses TOML into an object", () => {
    expect(parseToml('[project]\nversion = "1.2.3"\n')).toEqual({ project: { version: "1.2.3" } });
  });
});
