import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import {
  STARTUP_COMPLETENESS_CLI_FALLBACK,
  startupCompletenessContract,
} from "../../src/cli/startupCompletenessContract.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function capture(root: string, command: string): { rc: number; out: string; err: string } {
  const previous = process.cwd();
  let out = "";
  let err = "";
  process.chdir(root);
  try {
    const rc = main(["node", "agentera", ...command.split(" ").slice(1)], {
      out: (text) => (out += text),
      err: (text) => (err += text),
    });
    return { rc, out, err };
  } finally {
    process.chdir(previous);
  }
}

describe("startup completeness recovery", () => {
  it("advertises executable state fallbacks that return structured JSON", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-startup-fallback-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });

    expect(startupCompletenessContract().cli_fallback).toEqual([...STARTUP_COMPLETENESS_CLI_FALLBACK]);
    for (const command of STARTUP_COMPLETENESS_CLI_FALLBACK) {
      const result = capture(root, command);
      expect(result.rc, command).toBe(0);
      expect(result.err, command).toBe("");
      const payload = JSON.parse(result.out) as Record<string, unknown>;
      expect(payload.command, command).toEqual(expect.stringContaining(command.split(" ")[2]));
      expect(payload.status, command).toBeDefined();
    }
  });
});
