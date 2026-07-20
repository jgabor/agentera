import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const buildRoot = process.env.AGENTERA_SOURCE_TEST_BUILD;
if (!buildRoot) throw new Error("entity publication worker requires the source test build");

const root = process.env.AGENTERA_ENTITY_TEST_ROOT;
const artifact = process.env.AGENTERA_ENTITY_TEST_ARTIFACT;
const boundary = process.env.AGENTERA_ENTITY_TEST_BOUNDARY;
const resultPath = process.env.AGENTERA_ENTITY_TEST_RESULT;
const readyPath = process.env.AGENTERA_ENTITY_TEST_READY;
const startPath = process.env.AGENTERA_ENTITY_TEST_START;
const ownerOpenedPath = process.env.AGENTERA_ENTITY_TEST_OWNER_OPENED;
const continuePath = process.env.AGENTERA_ENTITY_TEST_CONTINUE;
const waitingPath = process.env.AGENTERA_ENTITY_TEST_WAITING;
const reclaimReadyPath = process.env.AGENTERA_ENTITY_TEST_RECLAIM_READY;
const reclaimContinuePath = process.env.AGENTERA_ENTITY_TEST_RECLAIM_CONTINUE;
const preparationReadyPath = process.env.AGENTERA_ENTITY_TEST_PREPARATION_READY;
const preparationContinuePath = process.env.AGENTERA_ENTITY_TEST_PREPARATION_CONTINUE;
const fault = process.env.AGENTERA_ENTITY_TEST_FAULT;
if (!root || !artifact || !boundary || !resultPath || !readyPath || !startPath) {
  throw new Error("entity publication worker requires complete publication input");
}
if ((ownerOpenedPath === undefined) !== (continuePath === undefined)) {
  throw new Error("controlled publication requires both owner-opened and continue paths");
}
if ((reclaimReadyPath === undefined) !== (reclaimContinuePath === undefined)) {
  throw new Error("controlled reclamation requires both reclaim-ready and reclaim-continue paths");
}
if ((preparationReadyPath === undefined) !== (preparationContinuePath === undefined)) {
  throw new Error("controlled preparation requires both preparation-ready and preparation-continue paths");
}

fs.writeFileSync(readyPath, "ready\n");
while (!fs.existsSync(startPath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
if (fault === "nonzero") {
  process.stderr.write(`injected worker failure ${"x".repeat(10_000)}`);
  process.exit(23);
}
if (fault === "malformed") {
  fs.writeFileSync(resultPath, "{malformed result");
  process.exit(0);
}
if (fault === "timeout") {
  while (true) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
}
if (preparationReadyPath && preparationContinuePath) {
  const originalMkdir = fs.mkdirSync;
  let paused = false;
  fs.mkdirSync = (...args) => {
    const target = String(args[0]);
    if (!paused && target.includes("/.writer.") && target.endsWith(".tmp")) {
      paused = true;
      fs.writeFileSync(preparationReadyPath, "preparation ready\n");
      while (!fs.existsSync(preparationContinuePath)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return Reflect.apply(originalMkdir, fs, args);
  };
}
if (reclaimReadyPath && reclaimContinuePath) {
  const originalLink = fs.linkSync;
  let paused = false;
  fs.linkSync = (...args) => {
    if (!paused) {
      if (!String(args[1]).endsWith("/.reclaim.json")) {
        throw new Error(`controlled reclamation reached unexpected link target '${String(args[1])}'`);
      }
      paused = true;
      fs.writeFileSync(reclaimReadyPath, "reclaim ready\n");
      while (!fs.existsSync(reclaimContinuePath)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return Reflect.apply(originalLink, fs, args);
  };
}
const { publishEntity } = await import(pathToFileURL(path.join(buildRoot, "state/entityStorage.js")));
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
