import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const buildRoot = process.env.AGENTERA_SOURCE_TEST_BUILD;
if (!buildRoot) throw new Error("entity publication worker requires the source test build");
const { publishEntity } = await import(pathToFileURL(path.join(buildRoot, "state/entityStorage.js")));

const root = process.env.AGENTERA_ENTITY_TEST_ROOT;
const artifact = process.env.AGENTERA_ENTITY_TEST_ARTIFACT;
const boundary = process.env.AGENTERA_ENTITY_TEST_BOUNDARY;
const resultPath = process.env.AGENTERA_ENTITY_TEST_RESULT;
const readyPath = process.env.AGENTERA_ENTITY_TEST_READY;
const startPath = process.env.AGENTERA_ENTITY_TEST_START;
const ownerOpenedPath = process.env.AGENTERA_ENTITY_TEST_OWNER_OPENED;
const continuePath = process.env.AGENTERA_ENTITY_TEST_CONTINUE;
const waitingPath = process.env.AGENTERA_ENTITY_TEST_WAITING;
if (!root || !artifact || !boundary || !resultPath || !readyPath || !startPath) {
  throw new Error("entity publication worker requires complete publication input");
}
if ((ownerOpenedPath === undefined) !== (continuePath === undefined)) {
  throw new Error("controlled publication requires both owner-opened and continue paths");
}

fs.writeFileSync(readyPath, "ready\n");
while (!fs.existsSync(startPath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
if (ownerOpenedPath && continuePath) {
  const originalOpen = fs.openSync;
  let paused = false;
  fs.openSync = (...args) => {
    const fd = Reflect.apply(originalOpen, fs, args);
    if (!paused && String(args[0]).endsWith("/.owner.json.tmp")) {
      paused = true;
      fs.writeFileSync(ownerOpenedPath, "owner opened\n");
      while (!fs.existsSync(continuePath)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return fd;
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
