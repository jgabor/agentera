import { reject } from "./errors.js";

export function schemaViolation(violations: string[]): never {
  reject({ class: "schema_violation", message: violations[0], violations });
}

export function findByNumber(
  entries: Record<string, unknown>[],
  number: number,
): Record<string, unknown> | undefined {
  return entries.find((entry) => Number(entry.number) === number);
}
