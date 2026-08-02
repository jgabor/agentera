import { execFileSync } from "node:child_process";

/** Execute a generated command against a harmless shell function and capture argv. */
export function shellCommandArgs(command: string): string[] {
  const output = execFileSync("/bin/sh", ["-c", `agentera() { printf '%s\\0' "$@"; }\n${command}`]);
  return output.toString("utf8").split("\0").filter(Boolean);
}
