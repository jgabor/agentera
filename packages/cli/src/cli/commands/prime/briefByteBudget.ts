import type { JsonObject } from "../../../core/jsonValue.js";

/** Authoritative byte budget for the default bare prime decision brief.
 *  Mirrors references/artifacts/state-storage-authority.yaml
 *  budgets.startup.surfaces.prime_briefing.max_utf8_bytes and
 *  scripts/json_output_surface_manifest.yaml prime-briefing byte_budget.
 *  archiveAuthority.test.ts binds the authority to the manifest; the
 *  primeProjectionContract.test.ts suite binds this constant to the authority
 *  so the contract and implementation cannot drift apart. */
export const PRIME_BRIEF_MAX_UTF8_BYTES = 12000;

/** Deterministic pretty-JSON UTF-8 byte length (including the trailing newline)
 *  used by the brief byte gate. Identical to the projection-policy serializer
 *  (serializedProjectionBytes) so measurement is consistent across surfaces. */
export function briefUtf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError("brief value is not JSON serializable");
  return Buffer.byteLength(serialized + "\n", "utf8");
}

/** Byte-gate primitive: deterministic UTF-8 measurement + budget comparison.
 *  AC5: a passing fixture (bytes <= budget) is accepted; an over-budget fixture
 *  (bytes > budget) is rejected. */
export function briefByteGate(value: unknown, budget: number = PRIME_BRIEF_MAX_UTF8_BYTES): { accepted: boolean; bytes: number } {
  const bytes = briefUtf8Bytes(value);
  return { accepted: bytes <= budget, bytes };
}

/** Settle the self-measuring byte field and return only at a fixed point. The
 * serialized value and the reported value therefore use the same pretty UTF-8
 * plus newline accounting as emitStructured. */
export function settledBriefEnvelope(body: Record<string, unknown>, meta: JsonObject): Record<string, unknown> {
  let brief: JsonObject = { ...meta, utf8_bytes: 0 };
  let envelope: Record<string, unknown> = { ...body, brief };
  for (let guard = 0; guard < 32; guard += 1) {
    const bytes = briefUtf8Bytes(envelope);
    if (brief.utf8_bytes === bytes) return envelope;
    brief = { ...brief, utf8_bytes: bytes };
    envelope = { ...body, brief };
  }
  throw new Error("brief UTF-8 byte measurement did not settle");
}

export class BriefBudgetError extends Error {
  readonly budgetBytes: number;
  readonly minimumBytes: number;

  constructor(budgetBytes: number, minimumBytes: number) {
    super(`brief budget ${budgetBytes} bytes cannot contain the minimum routing envelope (${minimumBytes} bytes); increase the budget or use prime --context status`);
    this.name = "BriefBudgetError";
    this.budgetBytes = budgetBytes;
    this.minimumBytes = minimumBytes;
  }
}
