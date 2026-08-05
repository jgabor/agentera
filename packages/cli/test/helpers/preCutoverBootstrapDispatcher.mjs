import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [identityJson, candidate, runtimeRoot, project, sentinel, environmentEvidence] = process.argv.slice(2);

try {
  const authority = await import(pathToFileURL(path.join(runtimeRoot, "dist/core/developmentInvocation.js")).href);
  const identity = JSON.parse(identityJson);
  const invocation = authority.bindDevelopmentInvocation(identity, candidate);
  const bin = authority.assertDevelopmentRuntimeSurface(runtimeRoot);
  const env = authority.scrubDevelopmentChildEnvironment(process.env, {
    HOME: process.env.HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    TMPDIR: process.env.TMPDIR,
    AGENTERA_HOME: process.env.AGENTERA_HOME,
    AGENTERA_BOOTSTRAP_SOURCE_ROOT: path.join(runtimeRoot, "bundle"),
    AGENTERA_UPDATE_CHANNEL: "development",
    DO_NOT_TRACK: "1",
  });
  env.AGENTERA_RUNTIME_PROOF_SENTINEL = sentinel;
  env.AGENTERA_RUNTIME_PROOF_ENVIRONMENT = environmentEvidence;
  const boundary = path.resolve(import.meta.dirname, "runtimeProofCliBoundary.mjs");
  const result = spawnSync(process.execPath, [boundary, bin, ...invocation.argv], {
    cwd: project,
    env,
    encoding: "utf8",
    shell: false,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  process.exit(result.status ?? 1);
} catch (error) {
  const classification = error && typeof error === "object" && "classification" in error
    ? error.classification
    : "invalid_authority";
  process.stderr.write(`${JSON.stringify({ classification, diagnostic: String(error?.message ?? error) })}\n`);
  process.exit(64);
}
