/** Quote one argument for a POSIX shell command without permitting expansion. */
export function shellQuoteArgument(value: unknown): string {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
