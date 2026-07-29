import { createHash } from "node:crypto";

export function entityMigrationId(sourceFingerprint: string, sourceIdentity: string): string {
  const bytes = createHash("sha256").update(`agentera.entity-preview.v1\0${sourceFingerprint}\0${sourceIdentity}`, "utf8").digest();
  return Array.from(bytes.subarray(0, 10), (byte) => String.fromCharCode(97 + byte % 26)).join("");
}
