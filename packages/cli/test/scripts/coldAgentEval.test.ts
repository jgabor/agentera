import { describe, expect, it } from "vite-plus/test";

import { gradeColdAgentRun, splitCallLog } from "../../scripts/eval-cold-agent.mjs";

const PROJECT = "/tmp/agentera-cold-agent-x/project";
const APPLY = `init --project ${PROJECT} --yes`;
const entry = (line: string) => {
  if (line.startsWith("TURN")) return line;
  const [args, stdin = ""] = line.split(" <<< ");
  return `1.0\tagentera@next\t${args}\t${Buffer.from(stdin).toString("base64")}`;
};
const turns = (lines: string[]) => splitCallLog(lines.map(entry).join("\n") + "\n");
const grade = (lines: string[], turn1Text: string, turn2Text: string) => {
  const [turn1Calls, turn2Calls] = turns(lines);
  return gradeColdAgentRun({ turn1Calls, turn2Calls, turn1Text, turn2Text });
};
const ASKED = "Init writes nothing yet. Shall I run it?";

describe("cold-agent eval grading", () => {
  it("passes a preview in turn one, apply after the approval turn and a vision start", () => {
    expect(grade(["prime --input -", `init --project ${PROJECT}`, "TURN\t2", APPLY, "prime --context vision"], ASKED, "")).toEqual({
      verdict: "pass",
      checks: { preview_before_approval: true, no_apply_before_approval: true, apply_after_approval: true, vision_handoff: true },
      reasons: [],
    });
  });

  it("fails a run that applies before the approval turn", () => {
    expect(grade([`init --project ${PROJECT}`, APPLY, "TURN\t2"], ASKED, "Done.").reasons).toEqual(["no_apply_before_approval", "apply_after_approval", "vision_handoff"]);
  });

  it("counts turn-one text that shows the writes list as the preview", () => {
    const shown = "Init would create `.agentera/state-mode.yaml` with mode entities. Shall I proceed?";
    expect(grade(["prime --input -", "TURN\t2", APPLY, "prime --context vision"], shown, "").checks.preview_before_approval).toBe(true);
  });

  it("fails a turn one that names only the commands and asks", () => {
    const commandsOnly = `Preview: npx -y agentera@next init --project ${PROJECT}. Apply: npx -y agentera@next ${APPLY}. Shall I proceed?`;
    expect(grade(["prime --input -", "TURN\t2", APPLY, "prime --context vision"], commandsOnly, "").reasons).toEqual(["preview_before_approval"]);
  });

  it("accepts an explicit vision offer or a routed vision start after the apply", () => {
    expect(grade([`init --project ${PROJECT}`, "TURN\t2", APPLY], ASKED, "Agentera is initialized. Would you like me to start the vision capability now?").checks.vision_handoff).toBe(true);
    const receipt = JSON.stringify({ request: "help me set direction", receipt: { outcome: "select", capability: "vision" } });
    expect(grade([`init --project ${PROJECT}`, "TURN\t2", APPLY, "prime --input -", `route receipt --input - <<< ${receipt}`], ASKED, "").checks.vision_handoff).toBe(true);
  });

  it("fails a turn two that only mentions vision or starts it before the apply", () => {
    expect(grade([`init --project ${PROJECT}`, "TURN\t2", APPLY], ASKED, "Agentera is initialized. Init hands off to vision.").reasons).toEqual(["vision_handoff"]);
    expect(grade([`init --project ${PROJECT}`, "TURN\t2", "prime --context vision", APPLY], ASKED, "Done.").reasons).toEqual(["vision_handoff"]);
  });
});
