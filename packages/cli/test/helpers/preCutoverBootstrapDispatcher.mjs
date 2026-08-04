import { spawnSync } from "node:child_process";

const [spec, bin, project] = process.argv.slice(2);
const prefix = "npx -y agentera@next ";
if (typeof spec !== "string" || !spec.startsWith(prefix)) {
  process.stderr.write(`wrong_channel: pre-cutover bootstrap requires ${prefix.trim()}\n`);
  process.exit(64);
}
const args = spec.slice(prefix.length).split(" ").filter(Boolean);
const result = spawnSync(process.execPath, [bin, ...args], {
  cwd: project,
  env: process.env,
  encoding: "utf8",
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
