import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { encode } from "gpt-tokenizer/model/gpt-5";
import { expect } from "vite-plus/test";

import { statusContextOf, statusStateUtf8Bytes, STATUS_STATE_BYTES_PER_TOKEN, STATUS_STATE_MAX_UTF8_BYTES } from "../../src/cli/commands/prime/orientationOutput.js";

const MANIFEST = YAML.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../../../scripts/json_output_surface_manifest.yaml"), "utf8"));
export const STATUS_ROW = MANIFEST.surfaces.find((surface: { id: string }) => surface.id === "prime-status-context");
export const ROUTED_STATUS = MANIFEST.surfaces.find((surface: { id: string }) => surface.id === "prime-routed-start").budget_by_carried.status;

/** The two byte parts of a status capsule's pretty stdout, with state tokens. */
export function statusParts(capsulePayload: Record<string, any>): { instructions: number; state: number; stateTokens: number } {
  const stdout = JSON.stringify(capsulePayload, null, 2) + "\n";
  const instructions = JSON.stringify(capsulePayload.capability_context.instructions);
  return {
    instructions: Buffer.byteLength(instructions, "utf8"),
    state: statusStateUtf8Bytes(capsulePayload),
    stateTokens: encode(stdout).length - encode(instructions).length,
  };
}

/**
 * Assert a direct or routed status start against its declared byte budget.
 * Instructions stay under their ratchet ceiling. State fits its ceiling or
 * carries a state_budget report of what was trimmed; only a state that fits
 * can hold the whole output to the sum of the ceilings. Every measured state
 * must also tokenize at no fewer bytes per token than the ratio its byte
 * target assumes.
 */
export function expectStatusWithinBudget(stdout: string, label = "status"): void {
  const payload = JSON.parse(stdout) as Record<string, any>;
  const capsulePayload = (payload.start ?? payload) as Record<string, any>;
  const status = statusContextOf(capsulePayload) as Record<string, any>;
  const parts = statusParts(capsulePayload);
  expect(parts.instructions, `${label} instruction bytes`).toBeLessThanOrEqual(STATUS_ROW.instruction_byte_budget);
  expect(parts.state / parts.stateTokens, `${label} state bytes per token`).toBeGreaterThanOrEqual(STATUS_STATE_BYTES_PER_TOKEN);
  if (status.state_budget) {
    expect(status.state_budget, label).toMatchObject({ omitted: true, omission_reason: "status_state_budget", max_utf8_bytes: STATUS_STATE_MAX_UTF8_BYTES });
    if (!status.state_budget.within_budget) return;
  } else {
    expect(parts.state, `${label} state bytes`).toBeLessThanOrEqual(STATUS_STATE_MAX_UTF8_BYTES);
  }
  const row = payload.start ? ROUTED_STATUS : STATUS_ROW;
  expect(Buffer.byteLength(stdout, "utf8"), `${label} bytes`).toBeLessThanOrEqual(row.byte_budget);
  if (row.instruction_budget_enforcement !== "deferred_to_status_rewrite") expect(encode(stdout).length, `${label} tokens`).toBeLessThanOrEqual(row.token_budget);
}
