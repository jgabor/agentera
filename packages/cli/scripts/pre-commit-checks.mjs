// Runs AFTER fixes, inside vp staged's hidden-partial-hunk snapshot.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function selectChecks(files) {
  const parity = files.some((file) => /^(scripts\/extract_corpus\.py|packages\/cli\/scripts\/(py_ts_parity\.sh|generate-extract-corpus-parity\.mjs)|packages\/cli\/src\/analytics\/extractCorpus\/.*|packages\/cli\/test\/analytics\/extractCorpus[^/]*\.test\.ts)$/.test(file));
  const related = files.filter((file) => /^packages\/cli\/(src\/.*\.(ts|js)|test\/.*\.(ts|js|mjs))$/.test(file));
  const guards = files.some((file) => /^[^/]+\.(json|jsonc|yaml|yml)$/.test(file) || /^[^/]+\.config\.(ts|js|mjs)$/.test(file) || file === "packages/cli/vitest.shared.ts" || /^(packages\/cli\/(scripts|test)|scripts|skills|references|\.github\/workflows|\.vite-hooks)\//.test(file));
  return [
    ...(files.some((file) => file.startsWith(".agentera/") || file === "TODO.md") ? [["timeout", "--foreground", "10s", "npx", "-y", "agentera@next", "check", "compact"]] : []),
    ...(parity ? [["bash", "packages/cli/scripts/py_ts_parity.sh", "--check", "--json"]] : []),
    ...(guards ? [["./node_modules/.bin/vp", "test", "run", "--project", "guards"]] : []),
    ...(related.length ? [["./node_modules/.bin/vp", "test", "related", "--run", "--project", "local", "--passWithNoTests", ...related.map((file) => path.resolve(file))]] : []),
    ...(files.some((file) => /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|yaml|yml)$/.test(file)) ? [["./node_modules/.bin/vp", "run", "typecheck"]] : []),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const files = process.argv.slice(2).map((file) => path.relative(process.cwd(), file).split(path.sep).join("/"));
  for (const [command, ...args] of selectChecks(files)) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
