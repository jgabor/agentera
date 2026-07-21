import fs from "node:fs";

import { cleanupGeneratedState } from "../../scripts/generated-output.mjs";

const [root, ready, release] = process.argv.slice(2);

try {
  fs.writeFileSync(ready, `${process.pid}\n`);
  while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  cleanupGeneratedState(root);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
