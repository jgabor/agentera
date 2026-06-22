import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { resolvePath } from "../../src/core/paths.js";

let tmp: string;
let savedXdg: string | undefined;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "app-home-cli-"));
  savedXdg = process.env.XDG_DATA_HOME;
  delete process.env.XDG_DATA_HOME;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedXdg !== undefined) process.env.XDG_DATA_HOME = savedXdg;
  else delete process.env.XDG_DATA_HOME;
});

describe("agentera app-home", () => {
  it("prints the platform default path", () => {
    const home = path.join(tmp, "home");
    let out = "";
    const rc = main(["node", "agentera", "app-home", "--home", home], { out: (t) => (out += t) });
    expect(rc).toBe(0);
    const expected =
      process.platform === "darwin"
        ? path.join(home, "Library", "Application Support", "agentera")
        : process.platform === "win32"
          ? path.join(home, "AppData", "Roaming", "agentera")
          : path.join(home, ".local", "share", "agentera");
    expect(out.trim()).toBe(resolvePath(expected));
  });

  it("supports json output", () => {
    const home = path.join(tmp, "home");
    let out = "";
    const rc = main(["node", "agentera", "app-home", "--home", home, "--format", "json"], {
      out: (t) => (out += t),
    });
    expect(rc).toBe(0);
    const payload = JSON.parse(out.trim());
    expect(payload.source).toBe("default");
    expect(payload.sourceLabel).toBe("default app home");
  });

  it("rejects unknown flags", () => {
    let err = "";
    const rc = main(["node", "agentera", "app-home", "--bogus"], { err: (t) => (err += t) });
    expect(rc).toBe(2);
    expect(err).toContain("unrecognized");
  });
});
