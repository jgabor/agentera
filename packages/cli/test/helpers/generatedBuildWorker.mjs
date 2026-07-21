import fs from "node:fs";
import path from "node:path";

import { installCompatibilityLauncher } from "../../scripts/build-package.mjs";
import {
  cleanupGeneratedState,
  publishGeneratedGeneration,
  withGeneratedStateLock,
  writeGenerationIdentity,
} from "../../scripts/generated-output.mjs";

const [root, id, ready, release] = process.argv.slice(2);
const staged = path.join(root, `.worker-stage-${id}`);

try {
  fs.mkdirSync(path.join(staged, "dist/bin"), { recursive: true });
  fs.mkdirSync(path.join(staged, "bundle"), { recursive: true });
  fs.writeFileSync(path.join(staged, "dist/bin/agentera.js"), `export const generation = ${JSON.stringify(id)};\n`);
  fs.writeFileSync(path.join(staged, "bundle/generation.txt"), `${id}\n`);
  writeGenerationIdentity(staged, id);
  fs.writeFileSync(ready, `${process.pid}\n`);
  while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  withGeneratedStateLock(root, () => {
    publishGeneratedGeneration(root, staged, id, { lockHeld: true });
    cleanupGeneratedState(root, { lockHeld: true });
    installCompatibilityLauncher(root);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
