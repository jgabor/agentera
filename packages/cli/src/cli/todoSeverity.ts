/** Severity band keys for TODO.md sections — shared by state todo, prime, and orientation. */
export const TODO_SEVERITY_ORDER_KEYS = [
  "critical",
  "degraded",
  "warning",
  "normal",
  "info",
  "annoying",
] as const;

/** Sort priority for TODO severity bands (lower = higher priority). */
export const TODO_SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  degraded: 1,
  warning: 1,
  normal: 2,
  info: 3,
  annoying: 3,
};
