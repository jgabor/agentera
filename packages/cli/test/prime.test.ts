import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PRIME_BLOB } from "../src/cli/prime-blob.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, "../dist/bin/agentera.js");

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", [BIN, ...args], { encoding: "utf8" });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

describe("agentera prime --guidance (Phase 0 spike)", () => {
  it("prints the priming guide exactly, with no trailing newline added", () => {
    const { stdout, status } = runCli(["prime", "--guidance"]);
    expect(status).toBe(0);
    expect(stdout).toBe(PRIME_BLOB);
  });

  it("PRIME_BLOB ends with a single trailing newline and no extra", () => {
    expect(PRIME_BLOB.endsWith("repair preview.\n")).toBe(true);
    expect(PRIME_BLOB.endsWith("\n\n")).toBe(false);
  });
});
