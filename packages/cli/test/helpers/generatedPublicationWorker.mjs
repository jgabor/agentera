import fs from "node:fs";

import { publishGeneratedGeneration } from "../../scripts/generated-output.mjs";

const [packageRoot, stagedRoot, generationId, readyPath = "", holdBeforePointerMs = "0"] = process.argv.slice(2);

try {
  publishGeneratedGeneration(packageRoot, stagedRoot, generationId, {
    holdBeforePointerMs: Number(holdBeforePointerMs),
    onBeforePointer: readyPath ? () => fs.writeFileSync(readyPath, "ready\n") : undefined,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
