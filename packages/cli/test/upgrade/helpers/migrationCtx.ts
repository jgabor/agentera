import path from "node:path";

/**
 * Sandbox env for v2→v3 migration tests. Do not spread process.env: a developer shell
 * with XDG_CONFIG_HOME set would route opencode migration writes to ~/.config/opencode.
 */
export function sandboxMigrationEnv(home: string, sourceRoot: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "xdg"),
    AGENTERA_BOOTSTRAP_SOURCE_ROOT: sourceRoot,
  };
}

export function migrationCtx(
  appHome: string,
  project: string,
  home: string,
  sourceRoot: string,
  env?: Record<string, string>,
) {
  const base = sandboxMigrationEnv(home, sourceRoot);
  return {
    appHome,
    project,
    home,
    sourceRoot,
    channel: "development" as const,
    env: env ? { ...base, ...env } : { ...base },
  };
}
