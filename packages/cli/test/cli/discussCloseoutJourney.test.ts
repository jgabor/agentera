import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeout } from "../../src/capabilities/discuss/instructions.js";
import { discussCloseoutJourney, discussScenarios } from "../helpers/discussCloseoutJourney.mjs";
import { sourceBuildOutputRoot, sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";
import { useSourceAppHome } from "../helpers/managedAppStub.js";
import { detectStateModeBinding } from "../../src/state/stateMode.js";
import { mutateTodoDocsEntity } from "../../src/state/todoDocsEntities.js";
import { operationSpec } from "../../src/state/write/operations.js";

useSourceAppHome();

describe("Discuss closeout, cooperative host with built CLI writers", () => {
  it.each([...discussScenarios, "pending-transaction"])("%s", (scenario) => {
    const result = discussCloseoutJourney(
      (root: string, args: string[], input?: unknown) => {
        const child = spawnSync(process.execPath, [path.join(sourceBuildOutputRoot(), "bin/agentera.js"), ...args], {
          cwd: root,
          env: sourceSubprocessEnv({
            ...process.env,
            AGENTERA_BOOTSTRAP_SOURCE_ROOT: path.resolve(import.meta.dirname, "../../../.."),
          }),
          encoding: "utf8",
          input: input === undefined ? undefined : JSON.stringify(input),
        });
        expect(child.error).toBeUndefined();
        const json = JSON.parse(child.stdout);
        if (args.includes("instructions")) {
          expect(child.status, child.stdout + child.stderr).toBe(0);
          const served = json.items.map((item: { content: string }) => item.content).join("");
          expect(served).toContain(closeout.trim().replaceAll("`agentera ", "`npx -y agentera@next "));
        }
        return { rc: child.status, json };
      },
      scenario,
      (root: string, input: Record<string, unknown>, effect: string) => {
        const binding = detectStateModeBinding(root);
        if (binding.mode !== "entities") throw new Error("expected entities");
        try {
          expect(() =>
            mutateTodoDocsEntity(
              {
                artifact: "todo",
                spec: operationSpec("todo", "create")!,
                projectRoot: root,
                dryRun: false,
                force: false,
                values: { confirmed: true, effect_sha256: effect },
                callerPayload: input,
                input,
              },
              { publicationContext: binding.publicationContext, interruptAfterTarget: 1 },
            ),
          ).toThrow(/interruption/);
        } finally {
          binding.publicationContext.close();
        }
      },
    );
    expect(result.trace.filter((item: { kind: string }) => item.kind === "proposal")).toHaveLength(1);
  });
});
