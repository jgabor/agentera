import fs from "node:fs";

import { publishEntity } from "../../dist/state/entityStorage.js";

const root = process.env.AGENTERA_ENTITY_TEST_ROOT;
const artifact = process.env.AGENTERA_ENTITY_TEST_ARTIFACT;
const boundary = process.env.AGENTERA_ENTITY_TEST_BOUNDARY;
const resultPath = process.env.AGENTERA_ENTITY_TEST_RESULT;
const readyPath = process.env.AGENTERA_ENTITY_TEST_READY;
const startPath = process.env.AGENTERA_ENTITY_TEST_START;
const preparedPath = process.env.AGENTERA_ENTITY_TEST_PREPARED;
const continuePath = process.env.AGENTERA_ENTITY_TEST_CONTINUE;
const waitingPath = process.env.AGENTERA_ENTITY_TEST_WAITING;
if (!root || !artifact || !boundary || !resultPath || !readyPath || !startPath) {
  throw new Error("entity publication worker requires complete publication input");
}
if ((preparedPath === undefined) !== (continuePath === undefined)) {
  throw new Error("controlled publication requires both prepared and continue paths");
}

fs.writeFileSync(readyPath, "ready\n");
while (!fs.existsSync(startPath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
if (preparedPath && continuePath) {
  const originalRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (String(source).includes("/.writer.") && String(source).endsWith(".tmp") && String(destination).endsWith("/.writer.lock")) {
      fs.writeFileSync(preparedPath, "prepared\n");
      while (!fs.existsSync(continuePath)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return originalRename(source, destination);
  };
}
if (waitingPath) {
  const originalWait = Atomics.wait;
  Atomics.wait = (...args) => {
    fs.writeFileSync(waitingPath, "waiting\n");
    return Reflect.apply(originalWait, Atomics, args);
  };
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
