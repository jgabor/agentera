import path from "node:path";
import { describe, expect, inject, it } from "vite-plus/test";
import { closeout } from "../../src/capabilities/discuss/instructions.js";
import { discussCloseoutJourney, discussScenarios } from "../helpers/discussCloseoutJourney.mjs";
import { coldProcessTest } from "../helpers/coldProcessTest.js";

const fixture = inject("packageFixture");
describe("Discuss closeout through extracted package", () => {
  it.concurrent.for(discussScenarios)("%s", async (scenario, context) => {
    const env = {
      ...process.env,
      HOME: path.join(fixture.root, `discuss-home-${scenario}`),
      AGENTERA_PROFILE: path.join(fixture.root, `discuss-profile-${scenario}`),
    };
    for (const key of Object.keys(env)) if (/^AGENTERA_.*SOURCE.*ROOT$/.test(key)) delete env[key];
    delete env.AGENTERA_SOURCE_TEST_BUILD;
    await coldProcessTest(
      context,
      ({ run }) =>
        discussCloseoutJourney(async (root: string, args: string[], input?: unknown) => {
          const child = await run({
            command: process.execPath,
            args: [path.join(fixture.packageRoot, "dist/bin/agentera.js"), ...args],
            cwd: root,
            env,
            input: input === undefined ? undefined : JSON.stringify(input),
          });
          const json = JSON.parse(child.stdout);
          if (args.includes("instructions")) {
            expect(json.items.map((item: { content: string }) => item.content).join("")).toContain(closeout.trim().replaceAll("`agentera ", "`npx -y agentera@next "));
          }
          return { rc: child.status, json };
        }, scenario),
      { concurrency: 1 },
    );
  });
});
