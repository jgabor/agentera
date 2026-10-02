import path from "node:path";
import { it } from "vite-plus/test";
import { migrationScenarios, projectMigrationJourney } from "../helpers/projectMigrationJourney.mjs";
import { sourceBuildOutputRoot, sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";
it.each(migrationScenarios)(
  "project migration built journey: %s",
  async (scenario) => {
    await projectMigrationJourney(
      path.join(sourceBuildOutputRoot(), "bin/agentera.js"),
      path.join(import.meta.dirname, "../upgrade/fixtures/v2-yaml-project"),
      scenario,
      sourceSubprocessEnv({
        ...process.env,
        AGENTERA_BOOTSTRAP_SOURCE_ROOT: path.resolve(import.meta.dirname, "../../../.."),
      }),
    );
  },
  60000,
);
