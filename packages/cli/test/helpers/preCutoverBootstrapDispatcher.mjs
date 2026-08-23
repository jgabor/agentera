import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function dispatchPreCutoverBootstrap({
  identityJson,
  candidate,
  runtimeRoot,
  project,
  sentinel,
  environmentEvidence,
  environment = process.env,
  spawn = spawnSync,
}) {
  try {
    const authority = await import(pathToFileURL(path.join(runtimeRoot, "dist/core/developmentInvocation.js")).href);
    const identity = JSON.parse(identityJson);
    const invocation = authority.bindDevelopmentInvocation(identity, candidate);
    const bin = authority.assertDevelopmentRuntimeSurface(runtimeRoot);
    const env = authority.scrubDevelopmentChildEnvironment(environment, {
      HOME: environment.HOME,
      XDG_DATA_HOME: environment.XDG_DATA_HOME,
      XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME,
      XDG_CACHE_HOME: environment.XDG_CACHE_HOME,
      XDG_STATE_HOME: environment.XDG_STATE_HOME,
      TMPDIR: environment.TMPDIR,
      AGENTERA_HOME: environment.AGENTERA_HOME,
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: path.join(runtimeRoot, "bundle"),
      AGENTERA_UPDATE_CHANNEL: "development",
      DO_NOT_TRACK: "1",
    });
    env.AGENTERA_RUNTIME_PROOF_SENTINEL = sentinel;
    env.AGENTERA_RUNTIME_PROOF_ENVIRONMENT = environmentEvidence;
    const boundary = path.resolve(import.meta.dirname, "runtimeProofCliBoundary.mjs");
    const result = spawn(process.execPath, [boundary, bin, ...invocation.argv], {
      cwd: project,
      env,
      encoding: "utf8",
      shell: false,
    });
    return {
      status: result.status ?? 1,
      classification: "accepted",
      diagnostic: "",
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (error) {
    const classification = error && typeof error === "object" && "classification" in error
      ? error.classification
      : "invalid_authority";
    const diagnostic = String(error?.message ?? error);
    return {
      status: 64,
      classification,
      diagnostic,
      stdout: "",
      stderr: `${JSON.stringify({ classification, diagnostic })}\n`,
    };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [identityJson, candidate, runtimeRoot, project, sentinel, environmentEvidence] = process.argv.slice(2);
  const result = await dispatchPreCutoverBootstrap({
    identityJson,
    candidate,
    runtimeRoot,
    project,
    sentinel,
    environmentEvidence,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status);
}
