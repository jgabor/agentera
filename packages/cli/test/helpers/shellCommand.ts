import { execFileSync, spawnSync } from "node:child_process";

/** Check only the tools required by the calling shell fixture, not the source suite. */
export function requireShellTools(tools: string[], env = process.env): void {
  for (const tool of tools) {
    const result = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "fixture-prerequisite", tool], {
      env,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`Shell fixture requires ${tool} on PATH (and /bin/sh): ${result.error?.message ?? result.stderr.trim()}`);
  }
}

/** Execute a generated command against a harmless shell function and capture argv. */
export function shellCommandArgs(command: string): string[] {
  const output = execFileSync("/bin/sh", ["-c", `agentera() { printf '%s\\0' "$@"; }\n${command}`]);
  return output.toString("utf8").split("\0").filter(Boolean);
}
