/** Shared argv flag helpers for dispatch-layer parsers. */

/** Read `--flag` or `--flag=value` at argv[index]. */
export function readArgvFlag(
  argv: readonly string[],
  index: number,
  name: string,
): string | null {
  const a = argv[index];
  if (a === name) return argv[index + 1] ?? null;
  if (a.startsWith(name + "=")) return a.slice(name.length + 1);
  return null;
}

/** True when argv[index] is `name` or `name=value`. */
export function matchesArgvFlag(argv: readonly string[], index: number, name: string): boolean {
  const a = argv[index];
  return a === name || a.startsWith(name + "=");
}

/**
 * Factory matching the inline `value(name)` closures used across dispatch parsers.
 * Space-separated values advance the outer loop index via setIndex.
 */
export function makeArgvValueReader(
  argv: readonly string[],
  getIndex: () => number,
  setIndex: (index: number) => void,
): (name: string) => string | null {
  return (name: string): string | null => {
    const i = getIndex();
    const a = argv[i];
    if (a === name) {
      setIndex(i + 1);
      return argv[i + 1] ?? null;
    }
    if (a.startsWith(name + "=")) return a.slice(name.length + 1);
    return null;
  };
}
