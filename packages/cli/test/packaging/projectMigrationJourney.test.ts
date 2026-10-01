import path from "node:path";
import { inject, it } from "vitest";
import { migrationScenarios, projectMigrationJourney } from "../helpers/projectMigrationJourney.mjs";
const fixture = inject("packageFixture");
it.each(migrationScenarios)(
  "project migration extracted-package journey: %s",
  (scenario) => {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (/^AGENTERA_.*SOURCE.*ROOT$/.test(name)) delete env[name];
    delete env.AGENTERA_SOURCE_TEST_BUILD;
    const result = projectMigrationJourney(path.join(fixture.packageRoot, "dist/bin/agentera.js"), path.join(import.meta.dirname, "../upgrade/fixtures/v2-yaml-project"), scenario, env);
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
