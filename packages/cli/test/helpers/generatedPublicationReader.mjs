import fs from "node:fs";
import path from "node:path";

import { selectGeneratedGeneration } from "../../scripts/build-package.mjs";

const [packageRoot, observations, ready, stop] = process.argv.slice(2);

try {
  fs.writeFileSync(ready, "ready\n");
  while (!fs.existsSync(stop)) {
    const selected = selectGeneratedGeneration(packageRoot);
    const dist = fs.readFileSync(path.join(selected.root, "dist/generation.txt"), "utf8").trim();
    const bundle = fs.readFileSync(path.join(selected.root, "bundle/generation.txt"), "utf8").trim();
    fs.appendFileSync(observations, JSON.stringify({ id: selected.id, dist, bundle }) + "\n");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
