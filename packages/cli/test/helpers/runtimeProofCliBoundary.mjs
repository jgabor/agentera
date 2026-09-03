import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const [bin, ...argv] = process.argv.slice(2);
const sentinel = process.env.AGENTERA_RUNTIME_PROOF_SENTINEL;
const evidence = process.env.AGENTERA_RUNTIME_PROOF_ENVIRONMENT;
delete process.env.AGENTERA_RUNTIME_PROOF_SENTINEL;
delete process.env.AGENTERA_RUNTIME_PROOF_ENVIRONMENT;

if (!sentinel || !evidence) throw new Error("runtime proof boundary requires external evidence paths");
fs.writeFileSync(sentinel, "cli-child-started\n", { flag: "wx" });
const unsafeNames = Object.keys(process.env)
  .filter((key) => /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)|^npm_config_|^NODE_OPTIONS$|^AGENTERA_UNSAFE/u.test(key))
  .sort();
const isolated = Object.fromEntries(
  ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR", "AGENTERA_HOME"].map((key) => [
    key,
    createHash("sha256")
      .update(process.env[key] ?? "")
      .digest("hex"),
  ]),
);
const userOwnedResolution = spawnSync("agentera-runtime-user-owned-proof", [], {
  encoding: "utf8",
  shell: false,
});
fs.writeFileSync(
  evidence,
  `${JSON.stringify({
    unsafeNames,
    isolated,
    argv,
    cwd: process.cwd(),
    path: process.env.PATH,
    userOwnedResolution: userOwnedResolution.error?.code ?? userOwnedResolution.status,
  })}\n`,
  { flag: "wx" },
);
process.argv = [process.argv[0], bin, ...argv];
await import(pathToFileURL(bin).href);
