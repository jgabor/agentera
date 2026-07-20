import fs from "node:fs";

import { publishGeneratedSurfaces } from "../../scripts/build-package.mjs";

const [packageRoot, stagedRoot, readyPath = "", holdLockMs = "0"] = process.argv.slice(2);

try {
  publishGeneratedSurfaces(packageRoot, stagedRoot, {
    holdLockMs: Number(holdLockMs),
    onLockAcquired: readyPath ? () => fs.writeFileSync(readyPath, "ready\n") : undefined,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
