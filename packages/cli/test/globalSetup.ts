import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `test global setup failed: ${command} ${args.join(" ")}\n${result.stderr || result.stdout}`,
    );
  }
}

export default function setup(): void {
  // Build shared package output once, before Vitest starts parallel workers.
  // Worker tests must treat dist/ and bundle/ as immutable inputs so npm pack,
  // installed-app, and parity tests cannot race a concurrent `rm -rf dist`.
  run("pnpm", ["run", "build"], packageRoot);
  run(process.execPath, [path.join(packageRoot, "scripts", "copy-bundle.mjs")], repoRoot);
}
