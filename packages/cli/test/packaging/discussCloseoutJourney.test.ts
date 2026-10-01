import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, inject, it } from "vitest";
import { closeout } from "../../src/capabilities/discuss/instructions.js";
import { discussCloseoutJourney, discussScenarios } from "../helpers/discussCloseoutJourney.mjs";

const fixture = inject("packageFixture");
describe("Discuss closeout through extracted package", () => {
  it.each(discussScenarios)("%s", (scenario) => {
    const env = {
      ...process.env,
      HOME: path.join(fixture.root, "discuss-home"),
      AGENTERA_PROFILE: path.join(fixture.root, "discuss-profile"),
    };
    for (const key of Object.keys(env)) if (/^AGENTERA_.*SOURCE.*ROOT$/.test(key)) delete env[key];
    delete env.AGENTERA_SOURCE_TEST_BUILD;
    discussCloseoutJourney((root: string, args: string[], input?: unknown) => {
      const child = spawnSync(process.execPath, [path.join(fixture.packageRoot, "dist/bin/agentera.js"), ...args], {
        cwd: root,
        env,
        encoding: "utf8",
        input: input === undefined ? undefined : JSON.stringify(input),
      });
      expect(child.error).toBeUndefined();
      const json = JSON.parse(child.stdout);
      if (args.includes("instructions")) {
        expect(json.items.map((item: { content: string }) => item.content).join("")).toContain(closeout.trim().replaceAll("`agentera ", "`npx -y agentera@next "));
      }
      return { rc: child.status, json };
    }, scenario);
  });
});
