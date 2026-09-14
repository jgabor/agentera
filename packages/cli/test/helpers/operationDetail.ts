import { expect } from "vitest";
import { runStateExplainDetail } from "../../src/cli/commands/state/explainDetail.js";
import { shellCommandArgs } from "./shellCommand.js";

/** Read the public static section, not a parallel test-owned input contract. */
export function explainedOperationSection(artifact: string, verb: string, section = "examples"): any {
  let out = "";
  const code = runStateExplainDetail(artifact, ["--verb", verb, "--section", `detail.${section}`], {
    out: (text) => {
      out += text;
    },
  });
  expect(code, out).toBe(0);
  const result = JSON.parse(out);
  expect(result.completeness.mode, out).toBe("detail");
  expect(result.next_command).toBeNull();
  expect(result.items).toHaveLength(1);
  return result.items[0].content;
}

/** Replace only advertised example placeholders; never add missing writer flags. */
export function explainedOperationCommand(artifact: string, verb: string, index: number, substitutions: Record<string, string> = {}): string[] {
  const command = explainedOperationSection(artifact, verb).commands[index];
  expect(command).toBeTypeOf("string");
  expect(command).toMatch(/^npx -y agentera@next state /);
  const args = shellCommandArgs(command.replace(/^npx -y agentera@next /, "agentera "));
  return args.map((arg) => substitutions[arg] ?? arg);
}
