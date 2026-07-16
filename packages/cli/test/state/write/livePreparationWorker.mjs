import fs from "node:fs";

const project = process.env.AGENTERA_LIVE_PREPARATION_ROOT;
const readyPath = process.env.AGENTERA_LIVE_PREPARATION_READY;
const removePath = process.env.AGENTERA_LIVE_PREPARATION_REMOVE;
if (!project || !readyPath || !removePath) {
  throw new Error("live preparation worker requires a project and synchronization paths");
}

const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const directory = `${project}/.agentera/.writer.${process.pid}.${token}.tmp`;
fs.mkdirSync(directory, { recursive: true });
const ownerFd = fs.openSync(`${directory}/.owner.json.tmp`, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL);
fs.writeFileSync(readyPath, "ready\n");

while (!fs.existsSync(removePath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
fs.closeSync(ownerFd);
fs.rmSync(directory, { recursive: true });
