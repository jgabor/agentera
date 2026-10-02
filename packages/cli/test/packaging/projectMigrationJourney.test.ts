import path from "node:path";
import { inject, it } from "vite-plus/test";
import { migrationScenarios, projectMigrationJourney } from "../helpers/projectMigrationJourney.mjs";
import { coldProcessTest } from "../helpers/coldProcessTest.js";
const fixture = inject("packageFixture");
it.concurrent.for(migrationScenarios)(
  "project migration extracted-package journey: %s",
  async (scenario, context) => {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (/^AGENTERA_.*SOURCE.*ROOT$/.test(name)) delete env[name];
    delete env.AGENTERA_SOURCE_TEST_BUILD;
    // Each scenario owns a distinct project and home. Only its CLI commands
    // overlap other scenarios; commands within a journey remain ordered.
    const result = await coldProcessTest(context, ({ run }) => projectMigrationJourney(path.join(fixture.packageRoot, "dist/bin/agentera.js"), path.join(import.meta.dirname, "../upgrade/fixtures/v2-yaml-project"), scenario, env, run), { concurrency: 1 });
    console.log(
      JSON.stringify({
        projectMigrationJourney: scenario,
        runtime: process.version,
        tarballSha256: fixture.deterministicBytes.sha256,
        sourceIdentity: fixture.sourceIdentity,
        checks: result.trace.map((call) => ({
          command: call.args.slice(0, 2),
          offered: call.offered,
          rc: call.rc,
          signal: call.signal,
          status: call.json?.status,
          phase: call.json?.phase,
        })),
      }),
    );
  },
  60000,
);
