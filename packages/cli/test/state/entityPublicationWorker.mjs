import fs from "node:fs";

import { publishEntity } from "../../dist/state/entityStorage.js";

const root = process.env.AGENTERA_ENTITY_TEST_ROOT;
const artifact = process.env.AGENTERA_ENTITY_TEST_ARTIFACT;
const boundary = process.env.AGENTERA_ENTITY_TEST_BOUNDARY;
const resultPath = process.env.AGENTERA_ENTITY_TEST_RESULT;
const readyPath = process.env.AGENTERA_ENTITY_TEST_READY;
const startPath = process.env.AGENTERA_ENTITY_TEST_START;
if (!root || !artifact || !boundary || !resultPath || !readyPath || !startPath) {
  throw new Error("entity publication worker requires complete publication input");
}

fs.writeFileSync(readyPath, "ready\n");
while (!fs.existsSync(startPath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
try {
  const result = publishEntity({
    projectRoot: root,
    artifact,
    boundary,
    id: "zzzzzzzzzz",
    record: { writer: artifact },
  });
  fs.writeFileSync(resultPath, JSON.stringify({ published: !result.replay }));
} catch (error) {
  fs.writeFileSync(resultPath, JSON.stringify({ published: false, error: error.message }));
}
