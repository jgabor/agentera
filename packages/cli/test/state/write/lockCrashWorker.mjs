import fs from "node:fs";

import { acquireWriterLock } from "../../../dist/state/write/lock.js";

const project = process.env.AGENTERA_LOCK_CRASH_ROOT;
const crashPoint = process.env.AGENTERA_LOCK_CRASH_POINT;
if (!project || !crashPoint) throw new Error("lock crash worker requires a project and crash point");

function canonicalOwnerIsOurs() {
  try {
    return JSON.parse(fs.readFileSync(`${project}/.agentera/.writer.lock/owner.json`, "utf8")).pid === process.pid;
  } catch {
    return false;
  }
}

function crash() {
  fs.writeFileSync(`${project}/.lock-crash-${crashPoint}`, "reached\n");
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not terminate the crash worker");
}

if (crashPoint === "claim-created") {
  const original = fs.openSync;
  fs.openSync = (...args) => {
    const fd = Reflect.apply(original, fs, args);
    if (String(args[0]).endsWith("/.reclaim.json")) crash();
    return fd;
  };
} else if (crashPoint === "private-created") {
  const original = fs.mkdirSync;
  fs.mkdirSync = (target, options) => {
    const result = original(target, options);
    if (String(target).includes(`/.writer.${process.pid}.`) && String(target).endsWith(".tmp")) crash();
    return result;
  };
} else if (crashPoint === "claim-published") {
  const original = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    original(fd);
    try {
      if (
        fs.realpathSync(`/proc/self/fd/${fd}`).endsWith("/.writer.lock")
        && fs.existsSync(`${project}/.agentera/.writer.lock/.reclaim.json`)
      ) crash();
    } catch {
      // The fd may have been closed between inspection and diagnostic lookup.
    }
  };
} else if (crashPoint === "owner-transitioned") {
  const original = fs.renameSync;
  fs.renameSync = (source, destination) => {
    original(source, destination);
    if (String(destination).endsWith("/owner.json") && canonicalOwnerIsOurs()) crash();
  };
} else if (crashPoint === "private-removed") {
  const original = fs.rmdirSync;
  fs.rmdirSync = (target, options) => {
    const result = original(target, options);
    if (
      String(target).includes("/.writer.")
      && String(target).endsWith(".tmp")
      && canonicalOwnerIsOurs()
      && fs.existsSync(`${project}/.agentera/.writer.lock/.reclaim.json`)
    ) crash();
    return result;
  };
} else if (crashPoint === "claim-removed") {
  const original = fs.unlinkSync;
  fs.unlinkSync = (target) => {
    original(target);
    if (String(target).endsWith("/.reclaim.json") && canonicalOwnerIsOurs()) crash();
  };
}

acquireWriterLock(project, 2_000);
throw new Error(`writer lock did not crash at ${crashPoint}`);
