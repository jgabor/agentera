import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { VP_VERSION } from "./bootstrap-integrity.mjs";

// Contributor launcher rule. The CI bootstrap keeps its exact VP_LAUNCHER_PATTERN.
const PIN = VP_VERSION.split(".").map(Number);
export const VP_LAUNCHER_RANGE = `>=${VP_VERSION} <${PIN[0] + 1}.0.0`;

// Results whose evidence depends on the standalone launcher binary rather than
// the root-local Vite+. The task runner, cache storage, and staged snapshot live
// in the local Vite+, but the cache and hook results were observed through the
// launcher's dispatch, so they stay qualified only for the pinned launcher.
export const LAUNCHER_DEPENDENT_RESULTS = [
  "managed Node.js download and selection (vp env on, vp env exec --node, vp node, and the runtime of root tasks)",
  "pnpm acquisition from the hash-pinned packageManager (vp install, vp exec pnpm)",
  "dispatch to the local Vite+ through VP_CLI_BIN, including the native-cache guard characterization",
  "Git hook dispatch (vp exec in .vite-hooks/pre-commit)",
];

export const LAUNCHER_RECOVERY = `Use a stable standalone Vite+ launcher in the accepted range ${VP_LAUNCHER_RANGE}; only the official ${VP_VERSION} release asset is qualified. Restore it on PATH, then run vp env on and vp install --frozen-lockfile from the repository root. See docs/packaging/vite-plus-1-toolchain.md#contributor-setup.`;

const compare = (left, right) => left.map((part, index) => part - right[index]).find((difference) => difference !== 0) ?? 0;

// Reads the launcher line of real `vp --version` output, for example "vp v1.3.0"
// followed by the "Local vite-plus:" block.
export function classifyLauncher(output) {
  const version = /^vp v(\S+)\s*$/m.exec(String(output))?.[1] ?? null;
  const reject = (reason) => ({ status: "rejected", version, reason, message: `Standalone Vite+ launcher ${version ? `v${version}` : "version"} rejected: ${reason}. ${LAUNCHER_RECOVERY}` });
  if (!version) return reject("no 'vp vX.Y.Z' launcher line in vp --version output");
  const stable = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!stable) return reject(/^\d+\.\d+\.\d+[-+]/.test(version) ? "prerelease and build-tagged launchers are not accepted" : "unrecognized version");
  const parts = stable.slice(1).map(Number);
  if (parts[0] !== PIN[0]) return reject(`major version ${parts[0]} is outside the accepted range`);
  const order = compare(parts, PIN);
  if (order < 0) return reject(`older than the pinned ${VP_VERSION}`);
  if (order === 0) return { status: "qualified", version, reason: "pinned version", message: `Standalone Vite+ launcher v${version} is the qualified pin; qualification covers the official release asset, not distribution-packaged builds.` };
  return {
    status: "accepted_unqualified",
    version,
    reason: `newer than the pinned ${VP_VERSION} within the accepted range ${VP_LAUNCHER_RANGE}`,
    unqualifiedResults: LAUNCHER_DEPENDENT_RESULTS,
    message: `Standalone Vite+ launcher v${version} is accepted but unqualified; only ${VP_VERSION} is qualified. These results are not qualified for this launcher: ${LAUNCHER_DEPENDENT_RESULTS.join("; ")}.`,
  };
}

// Hook entry: node launcher-range.mjs /absolute/path/to/vp
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const launcher = process.argv[2];
  if (!launcher || !path.isAbsolute(launcher)) {
    console.error(`usage: launcher-range.mjs /absolute/path/to/vp. ${LAUNCHER_RECOVERY}`);
    process.exit(2);
  }
  const result = spawnSync(launcher, ["--version"], { encoding: "utf8", timeout: 60_000 });
  const classification = classifyLauncher(result.status === 0 ? result.stdout : "");
  if (classification.status === "rejected") {
    console.error(classification.message);
    process.exit(1);
  }
  if (classification.status === "accepted_unqualified") console.error(classification.message);
}
